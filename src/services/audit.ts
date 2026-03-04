/**
 * @module audit
 * @description 集中式审计日志服务 — JSONL 热写入层。
 *
 * 设计哲学:
 * - 审计写入绝对不阻塞请求处理 (< 0.1ms enqueue)
 * - 内存写入缓冲 → 异步批量刷盘（configurable interval）
 * - JSONL 文件每条 < 4KB (PIPE_BUF)，OS 保证原子写入
 * - 磁盘满/IO 错误 → 静默降级到 stderr，永不抛异常到调用方
 *
 * 与 AnalyticsService 的关系:
 * - AuditService 是"热写入"层 — 每个请求都写
 * - AnalyticsService 是"冷分析"层 — 定期读取 JSONL 聚合到 SQLite
 * - 解耦设计：AuditService 不依赖 SQLite，AnalyticsService 不依赖 JSONL
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { appendFile, stat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { log } from "../utils/logger.js";
import { DATA_PATHS } from "../utils/paths.js";
import type {
  AuditLogEntry,
  AuditOperation,
  AuditOutcome,
} from "../types/audit-schema.js";
import { extractKeyPrefix } from "../types/audit-schema.js";

// =========================================================================
// Configuration
// =========================================================================

export interface AuditServiceConfig {
  /** JSONL 审计日志路径 (default: ~/.easy-memory-audit.jsonl) */
  logPath?: string;
  /** 写入缓冲刷盘间隔 (ms, default: 1000) */
  flushIntervalMs?: number;
  /** 缓冲区最大条目数（超出立即刷盘, default: 100） */
  maxBufferSize?: number;
  /** 日志文件最大大小 (bytes, default: 50MB) → 触发轮转 */
  maxFileSizeBytes?: number;
  /** 保留的轮转文件数 (default: 5) */
  maxRotatedFiles?: number;
  /** 是否启用审计 (default: true) */
  enabled?: boolean;
}

// =========================================================================
// AuditService
// =========================================================================

export class AuditService {
  private readonly logPath: string;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly maxFileSizeBytes: number;
  private readonly maxRotatedFiles: number;
  private readonly enabled: boolean;

  /** 内存写入缓冲 */
  private buffer: string[] = [];
  /** 定期刷盘定时器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** 是否正在刷盘（防止并发刷盘竞态） */
  private flushing = false;
  /** 轮转锁（防止并发轮转） */
  private rotating = false;
  /** 已关闭标记 — close() 后 record() 不再接受新条目 */
  closed = false;

  // === 运行时统计 ===
  private totalEnqueued = 0;
  private totalFlushed = 0;
  private totalDropped = 0;
  private lastFlushAt = 0;

  constructor(config: AuditServiceConfig = {}) {
    this.logPath = config.logPath ?? DATA_PATHS.auditLog;
    this.flushIntervalMs = config.flushIntervalMs ?? 1000;
    this.maxBufferSize = config.maxBufferSize ?? 100;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? 50 * 1024 * 1024; // 50MB
    this.maxRotatedFiles = config.maxRotatedFiles ?? 5;
    this.enabled = config.enabled ?? true;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * 启动审计服务 — 开始定期刷盘。
   * 幂等：重复调用安全。
   */
  start(): void {
    if (!this.enabled || this.flushTimer) return;
    this.closed = false;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // 允许进程正常退出（不因定时器阻塞）
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * 关闭审计服务 — 停止定时器并刷盘所有剩余条目。
   *
   * P1-FIX: 等待 in-flight flush 完成后再执行最终 flush，
   * 防止 close() 提前 resolve 导致最后一批条目丢失。
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // 等待正在进行的 flush 完成（最多等待 3s 兜底，防止无限阻塞）
    const deadline = Date.now() + 3000;
    while (this.flushing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // P10-FIX: 如果 deadline 超时但 flushing 仍为 true，
    // 强制重置以允许最终 flush 执行（in-flight flush 会独立完成）。
    if (this.flushing) {
      log.warn("Audit flush timeout during close, forcing final flush");
      this.flushing = false;
    }
    // 刷盘剩余
    await this.flush();
  }

  // =========================================================================
  // Core API — 非阻塞入队
  // =========================================================================

  /**
   * 记录一条审计日志 — 非阻塞，立即返回。
   *
   * 性能保证: < 0.1ms（仅 push 到内存数组）
   * 如果缓冲区满，立即触发异步刷盘。
   */
  record(entry: AuditLogEntry): void {
    if (!this.enabled || this.closed) return;

    try {
      // P2-FIX: 硬上限防止持续 IO 故障时 buffer 无界增长导致 OOM
      // 上限 = maxBufferSize * 10（默认 1000 条 ≈ 4MB），超出静默丢弃
      if (this.buffer.length >= this.maxBufferSize * 10) {
        this.totalDropped++;
        return;
      }

      const line = JSON.stringify(entry);
      this.buffer.push(line);
      this.totalEnqueued++;

      // 缓冲区满 → 立即触发异步刷盘
      if (this.buffer.length >= this.maxBufferSize) {
        void this.flush();
      }
    } catch {
      this.totalDropped++;
      // JSON 序列化失败 — 静默丢弃，不影响请求
    }
  }

  /**
   * 构建审计日志条目的便捷方法。
   *
   * 从 HTTP 请求上下文中提取公共字段（who/when/where），
   * 调用方只需补充 operation-specific 字段。
   */
  buildEntry(params: {
    operation: AuditOperation;
    project: string;
    outcome: AuditOutcome;
    outcomeDetail: string;
    elapsedMs: number;
    httpMethod: string;
    httpPath: string;
    httpStatus: number;
    authHeader?: string;
    userAgent?: string;
    clientIp?: string;
    /** 可选 key_prefix 覆盖 — 优先于从 authHeader 提取 */
    keyPrefix?: string;
    extra?: Partial<AuditLogEntry>;
  }): AuditLogEntry {
    return {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      key_prefix: params.keyPrefix ?? extractKeyPrefix(params.authHeader),
      user_agent: params.userAgent ?? "",
      client_ip: params.clientIp ?? "",
      operation: params.operation,
      project: params.project,
      outcome: params.outcome,
      outcome_detail: params.outcomeDetail,
      elapsed_ms: params.elapsedMs,
      http_method: params.httpMethod,
      http_path: params.httpPath,
      http_status: params.httpStatus,
      ...params.extra,
    };
  }

  // =========================================================================
  // Flush — 异步批量写入磁盘
  // =========================================================================

  /**
   * 将缓冲区内容刷入 JSONL 文件。
   *
   * 并发安全: 如果正在刷盘则跳过（下一个 interval 会重试）。
   * 磁盘故障: 捕获所有异常，降级到 stderr 警告。
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;

    this.flushing = true;
    // 原子交换缓冲区 — 新请求写入新 buffer，不阻塞
    const batch = this.buffer;
    this.buffer = [];

    try {
      const data = batch.map((line) => line + "\n").join("");
      await appendFile(this.logPath, data);
      this.totalFlushed += batch.length;
      this.lastFlushAt = Date.now();

      // 检查是否需要轮转
      await this.maybeRotate();
    } catch (err: unknown) {
      // 磁盘写入失败 — 回塞到 buffer 头部（重试）
      // 但如果 buffer 已经很大，就丢弃最旧的条目防止 OOM
      const maxRetryBuffer = this.maxBufferSize * 3;
      if (this.buffer.length + batch.length <= maxRetryBuffer) {
        this.buffer = [...batch, ...this.buffer];
      } else {
        this.totalDropped += batch.length;
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Audit flush failed, entries dropped", {
          dropped: batch.length,
          error: error.message,
        });
      }
    } finally {
      this.flushing = false;
    }
  }

  // =========================================================================
  // Log Rotation
  // =========================================================================

  /**
   * 日志轮转 — 当文件超过阈值时重命名为 .1, .2, ...
   *
   * 轮转策略:
   * - audit.jsonl → audit.jsonl.1 (最新)
   * - audit.jsonl.1 → audit.jsonl.2
   * - ...
   * - audit.jsonl.{maxRotatedFiles} → 删除
   */
  private async maybeRotate(): Promise<void> {
    if (this.rotating) return;

    try {
      const stats = await stat(this.logPath);
      if (stats.size < this.maxFileSizeBytes) return;

      this.rotating = true;

      // 反向重命名: .4→.5, .3→.4, .2→.3, .1→.2
      for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
        const from = i === 1 ? this.logPath : `${this.logPath}.${i}`;
        const to = `${this.logPath}.${i + 1}`;
        try {
          await rename(from, to);
        } catch {
          // 文件不存在 — 正常，跳过
        }
      }

      // 当前文件 → .1
      try {
        await rename(this.logPath, `${this.logPath}.1`);
      } catch {
        // rename 失败 — 可能有竞争写入，下个周期重试
      }

      log.info("Audit log rotated", { path: this.logPath });
    } catch {
      // stat 失败 — 文件可能不存在（首次写入前），忽略
    } finally {
      this.rotating = false;
    }
  }

  // =========================================================================
  // Stats
  // =========================================================================

  /**
   * 获取审计服务运行时统计。
   */
  getStats(): {
    enabled: boolean;
    total_enqueued: number;
    total_flushed: number;
    total_dropped: number;
    buffer_size: number;
    last_flush_at: number;
    log_path: string;
  } {
    return {
      enabled: this.enabled,
      total_enqueued: this.totalEnqueued,
      total_flushed: this.totalFlushed,
      total_dropped: this.totalDropped,
      buffer_size: this.buffer.length,
      last_flush_at: this.lastFlushAt,
      log_path: this.logPath,
    };
  }

  // =========================================================================
  // Testing Helpers
  // =========================================================================

  /** @internal 仅用于测试 — 获取缓冲区大小 */
  get _bufferSize(): number {
    return this.buffer.length;
  }

  /** @internal 仅用于测试 — 重置统计 */
  _resetStats(): void {
    this.totalEnqueued = 0;
    this.totalFlushed = 0;
    this.totalDropped = 0;
    this.lastFlushAt = 0;
    this.buffer = [];
  }
}
