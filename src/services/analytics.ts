/**
 * @module analytics
 * @description SQLite 分析存储 — 审计日志的冷分析层。
 *
 * 架构:
 * - SQLite WAL 模式 — 读写可并发（aggregation 写入不阻塞 admin 查询）
 * - 3 张主表: audit_events (原始事件), hourly_rollups, daily_rollups
 * - 聚合定时器: 每小时（或可配置间隔）从 JSONL 导入 + 聚合
 * - 数据保留: hourly 7 天, daily 90 天, raw events 30 天
 *
 * 性能:
 * - 建表时创建组合索引（时间+用户+项目+操作）
 * - 聚合使用 INSERT OR REPLACE + GROUP BY
 * - 查询走索引，Sub-second 响应
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../utils/logger.js";
import type {
  AuditLogEntry,
  AuditOperation,
  AuditOutcome,
  AnalyticsRollup,
  HitRateMetrics,
  UserUsageSummary,
  ProjectUsageSummary,
  ErrorRateMetrics,
  PaginatedResponse,
  AuditQuery,
  AnalyticsQuery,
} from "../types/audit-schema.js";
import { resolveTimeRange } from "../types/audit-schema.js";

// =========================================================================
// Configuration
// =========================================================================

export interface AnalyticsServiceConfig {
  /** SQLite 数据库路径 (default: ~/.easy-memory-analytics.db) */
  dbPath?: string;
  /** JSONL 审计日志路径 — 用于导入 (default: ~/.easy-memory-audit.jsonl) */
  auditLogPath?: string;
  /** 聚合间隔 (ms, default: 3600_000 = 1 hour) */
  aggregationIntervalMs?: number;
  /** Raw events 保留天数 (default: 30) */
  rawRetentionDays?: number;
  /** Hourly rollup 保留天数 (default: 7) */
  hourlyRetentionDays?: number;
  /** Daily rollup 保留天数 (default: 90) */
  dailyRetentionDays?: number;
  /** 是否启用自动聚合定时器 (default: true) */
  autoAggregate?: boolean;
}

// =========================================================================
// SQL DDL — 表结构
// =========================================================================

const CREATE_TABLES_SQL = `
-- 原始审计事件（从 JSONL 导入或实时接收）
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  outcome_detail TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  content_preview TEXT,
  memory_id TEXT,
  embedding_model TEXT,
  fact_type TEXT,
  source TEXT,
  save_status TEXT,
  query_preview TEXT,
  result_count INTEGER,
  top_score REAL,
  search_limit INTEGER,
  search_threshold REAL,
  search_hit INTEGER,
  forget_target_id TEXT,
  forget_action TEXT,
  forget_reason TEXT,
  elapsed_ms REAL NOT NULL DEFAULT 0,
  embedding_ms REAL,
  qdrant_ms REAL,
  http_method TEXT NOT NULL DEFAULT '',
  http_path TEXT NOT NULL DEFAULT '',
  http_status INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 聚合 rollup 表 — hourly + daily 共用
CREATE TABLE IF NOT EXISTS analytics_rollups (
  time_bucket TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('hourly', 'daily')),
  key_prefix TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  avg_elapsed_ms REAL NOT NULL DEFAULT 0,
  max_elapsed_ms REAL NOT NULL DEFAULT 0,
  p95_elapsed_ms REAL NOT NULL DEFAULT 0,
  search_hit_count INTEGER NOT NULL DEFAULT 0,
  search_total_count INTEGER NOT NULL DEFAULT 0,
  avg_top_score REAL NOT NULL DEFAULT 0,
  avg_result_count REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (time_bucket, granularity, key_prefix, project, operation)
);

-- JSONL 导入进度追踪（记录已导入的文件偏移量）
CREATE TABLE IF NOT EXISTS import_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  file_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  last_event_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_key_project ON audit_events(key_prefix, project);
CREATE INDEX IF NOT EXISTS idx_events_operation ON audit_events(operation, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_outcome ON audit_events(outcome, timestamp);
CREATE INDEX IF NOT EXISTS idx_rollups_time ON analytics_rollups(time_bucket, granularity);
CREATE INDEX IF NOT EXISTS idx_rollups_key ON analytics_rollups(key_prefix, granularity, time_bucket);
CREATE INDEX IF NOT EXISTS idx_rollups_project ON analytics_rollups(project, granularity, time_bucket);
`;

// =========================================================================
// AnalyticsService
// =========================================================================

export class AnalyticsService {
  private db: BetterSqlite3.Database | null = null;
  private aggregationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: Required<AnalyticsServiceConfig>;

  // Prepared statements cache
  private stmtInsertEvent: BetterSqlite3.Statement | null = null;

  constructor(config: AnalyticsServiceConfig = {}) {
    this.config = {
      dbPath:
        config.dbPath ??
        join(process.env.HOME ?? "/tmp", ".easy-memory-analytics.db"),
      auditLogPath:
        config.auditLogPath ??
        join(process.env.HOME ?? "/tmp", ".easy-memory-audit.jsonl"),
      aggregationIntervalMs: config.aggregationIntervalMs ?? 3_600_000,
      rawRetentionDays: config.rawRetentionDays ?? 30,
      hourlyRetentionDays: config.hourlyRetentionDays ?? 7,
      dailyRetentionDays: config.dailyRetentionDays ?? 90,
      autoAggregate: config.autoAggregate ?? true,
    };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * 初始化数据库 — 建表 + 启用 WAL + 启动聚合定时器。
   */
  open(): void {
    if (this.db) return;

    try {
      this.db = new Database(this.config.dbPath);

      // WAL 模式 — 读写并发
      this.db.pragma("journal_mode = WAL");
      // 提高写入性能 — sync 由 OS 保证
      this.db.pragma("synchronous = NORMAL");
      // 限制 WAL 文件大小
      this.db.pragma("wal_autocheckpoint = 1000");

      // 建表
      this.db.exec(CREATE_TABLES_SQL);

      // 缓存 prepared statements
      this.stmtInsertEvent = this.db.prepare(`
        INSERT OR IGNORE INTO audit_events (
          event_id, timestamp, key_prefix, user_agent, client_ip,
          operation, project, outcome, outcome_detail,
          content_hash, content_preview, memory_id, embedding_model,
          fact_type, source, save_status,
          query_preview, result_count, top_score, search_limit,
          search_threshold, search_hit,
          forget_target_id, forget_action, forget_reason,
          elapsed_ms, embedding_ms, qdrant_ms,
          http_method, http_path, http_status
        ) VALUES (
          @event_id, @timestamp, @key_prefix, @user_agent, @client_ip,
          @operation, @project, @outcome, @outcome_detail,
          @content_hash, @content_preview, @memory_id, @embedding_model,
          @fact_type, @source, @save_status,
          @query_preview, @result_count, @top_score, @search_limit,
          @search_threshold, @search_hit,
          @forget_target_id, @forget_action, @forget_reason,
          @elapsed_ms, @embedding_ms, @qdrant_ms,
          @http_method, @http_path, @http_status
        )
      `);

      log.info("Analytics database opened", { path: this.config.dbPath });

      // 启动聚合定时器
      if (this.config.autoAggregate) {
        this.startAggregation();
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to open analytics database", {
        error: error.message,
        path: this.config.dbPath,
      });
      // 降级: 数据库不可用不应阻止主服务运行
      this.db = null;
    }
  }

  /**
   * 关闭数据库连接和定时器。
   */
  close(): void {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // 静默处理关闭错误
      }
      this.db = null;
      this.stmtInsertEvent = null;
    }
  }

  /**
   * 数据库是否就绪。
   */
  get isReady(): boolean {
    return this.db !== null;
  }

  // =========================================================================
  // Event Ingestion — 实时写入
  // =========================================================================

  /**
   * 直接写入审计事件到 SQLite（用于实时双写模式）。
   *
   * 与 JSONL 导入互补 — 实时双写可保证数据不丢失。
   */
  ingestEvent(entry: AuditLogEntry): boolean {
    if (!this.db || !this.stmtInsertEvent) return false;

    try {
      this.stmtInsertEvent.run({
        event_id: entry.event_id,
        timestamp: entry.timestamp,
        key_prefix: entry.key_prefix,
        user_agent: entry.user_agent,
        client_ip: entry.client_ip,
        operation: entry.operation,
        project: entry.project,
        outcome: entry.outcome,
        outcome_detail: entry.outcome_detail,
        content_hash: entry.content_hash ?? null,
        content_preview: entry.content_preview ?? null,
        memory_id: entry.memory_id ?? null,
        embedding_model: entry.embedding_model ?? null,
        fact_type: entry.fact_type ?? null,
        source: entry.source ?? null,
        save_status: entry.save_status ?? null,
        query_preview: entry.query_preview ?? null,
        result_count: entry.result_count ?? null,
        top_score: entry.top_score ?? null,
        search_limit: entry.search_limit ?? null,
        search_threshold: entry.search_threshold ?? null,
        search_hit:
          entry.search_hit != null ? (entry.search_hit ? 1 : 0) : null,
        forget_target_id: entry.forget_target_id ?? null,
        forget_action: entry.forget_action ?? null,
        forget_reason: entry.forget_reason ?? null,
        elapsed_ms: entry.elapsed_ms,
        embedding_ms: entry.embedding_ms ?? null,
        qdrant_ms: entry.qdrant_ms ?? null,
        http_method: entry.http_method,
        http_path: entry.http_path,
        http_status: entry.http_status,
      });
      return true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to ingest audit event", {
        event_id: entry.event_id,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * 批量写入审计事件（用于 JSONL 导入）。
   * 使用事务保证原子性。
   */
  ingestBatch(entries: AuditLogEntry[]): number {
    if (!this.db || !this.stmtInsertEvent || entries.length === 0) return 0;

    let ingested = 0;
    const tx = this.db.transaction(() => {
      for (const entry of entries) {
        if (this.ingestEvent(entry)) {
          ingested++;
        }
      }
    });

    try {
      tx();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Batch ingest failed", {
        attempted: entries.length,
        error: error.message,
      });
    }

    return ingested;
  }

  // =========================================================================
  // JSONL Import — 从审计日志文件导入
  // =========================================================================

  /**
   * 从 JSONL 审计日志导入新增事件。
   *
   * 使用 byte_offset 游标实现增量导入，避免重复处理。
   * 处理 JSONL 行级别的容错（单行 JSON 损坏不影响其他行）。
   */
  async importFromJsonl(): Promise<{ imported: number; errors: number }> {
    if (!this.db) return { imported: 0, errors: 0 };

    let fileContent: string;
    try {
      fileContent = await readFile(this.config.auditLogPath, "utf-8");
    } catch {
      // 文件不存在或不可读 — 正常（首次运行）
      return { imported: 0, errors: 0 };
    }

    // P11-FIX: readFile 是 async，await 归来后 this.db 可能已被 close() 置为 null
    if (!this.db) return { imported: 0, errors: 0 };

    // 获取上次导入游标
    const cursor = this.db
      .prepare("SELECT byte_offset FROM import_cursor WHERE id = 1")
      .get() as { byte_offset: number } | undefined;
    let startOffset = cursor?.byte_offset ?? 0;

    // P12-FIX: Rotation 检测 — 如果文件长度小于 cursor 偏移量，
    // 说明 JSONL 文件已被轮转（旧文件 → .1），当前是新文件，需重置 cursor。
    if (startOffset > fileContent.length) {
      log.info("JSONL file appears rotated, resetting import cursor", {
        cursorOffset: startOffset,
        fileSize: fileContent.length,
      });
      startOffset = 0;
    }

    // 只处理新增内容
    const newContent = fileContent.slice(startOffset);
    if (!newContent.trim()) return { imported: 0, errors: 0 };

    const lines = newContent.split("\n").filter((l) => l.trim());
    const entries: AuditLogEntry[] = [];
    let errors = 0;

    // P4-FIX: 分批解析 + yield 给事件循环，避免大文件阻塞
    // 每 PARSE_BATCH_SIZE 行后 yield 一次，允许事件循环处理 HTTP 请求
    const PARSE_BATCH_SIZE = 1000;
    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
        // 兼容旧格式审计日志（type: "AUDIT:memory_save" → operation: "memory_save"）
        const entry = this.normalizeAuditEntry(parsed);
        if (entry) {
          entries.push(entry);
        }
      } catch {
        errors++;
        // 单行 JSON 损坏 — 跳过，不影响其他行
      }

      // 每 PARSE_BATCH_SIZE 行后 yield 给事件循环
      if ((i + 1) % PARSE_BATCH_SIZE === 0 && i + 1 < lines.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    // 分批 ingest 到 SQLite，每批之间 yield 给事件循环
    const INGEST_BATCH_SIZE = 2000;
    let totalImported = 0;
    for (let i = 0; i < entries.length; i += INGEST_BATCH_SIZE) {
      const chunk = entries.slice(i, i + INGEST_BATCH_SIZE);
      totalImported += this.ingestBatch(chunk);
      if (i + INGEST_BATCH_SIZE < entries.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    // 更新游标
    const newOffset = fileContent.length;
    this.db
      .prepare(
        `INSERT INTO import_cursor (id, file_path, byte_offset, last_event_id, updated_at)
         VALUES (1, @path, @offset, @lastId, @now)
         ON CONFLICT (id) DO UPDATE SET
           byte_offset = @offset,
           last_event_id = @lastId,
           updated_at = @now`,
      )
      .run({
        path: this.config.auditLogPath,
        offset: newOffset,
        lastId:
          entries.length > 0 ? entries[entries.length - 1]!.event_id : null,
        now: new Date().toISOString(),
      });

    log.info("JSONL import completed", {
      imported: totalImported,
      errors,
      newLines: lines.length,
    });
    return { imported: totalImported, errors };
  }

  /**
   * 将旧格式审计日志条目标准化为 AuditLogEntry。
   *
   * 旧格式示例:
   * { type: "AUDIT:memory_save", id: "...", project: "...", contentHash: "...", timestamp: "..." }
   */
  private normalizeAuditEntry(
    raw: Record<string, unknown>,
  ): AuditLogEntry | null {
    // 新格式: 直接含 event_id + operation
    if (raw.event_id && raw.operation) {
      return raw as unknown as AuditLogEntry;
    }

    // 旧格式: type 字段如 "AUDIT:memory_save"
    const type = String(raw.type ?? "");
    if (!type.startsWith("AUDIT:")) return null;

    const operation = type.replace("AUDIT:", "") as AuditOperation;
    const timestamp = String(raw.timestamp ?? new Date().toISOString());
    const project = String(raw.project ?? "");

    return {
      event_id: String(raw.id ?? `legacy-${Date.now()}-${Math.random()}`),
      timestamp,
      key_prefix: "",
      user_agent: "",
      client_ip: "",
      operation,
      project,
      outcome: "success" as AuditOutcome,
      outcome_detail: "",
      ...(raw.contentHash ? { content_hash: String(raw.contentHash) } : {}),
      ...(raw.id ? { memory_id: String(raw.id) } : {}),
      ...(raw.embeddingModel
        ? { embedding_model: String(raw.embeddingModel) }
        : {}),
      ...(raw.fact_type ? { fact_type: String(raw.fact_type) } : {}),
      ...(raw.source ? { source: String(raw.source) } : {}),
      ...(raw.action ? { forget_action: String(raw.action) } : {}),
      ...(raw.reason ? { forget_reason: String(raw.reason) } : {}),
      elapsed_ms: 0,
      http_method: "",
      http_path: "",
      http_status: 0,
    };
  }

  // =========================================================================
  // Aggregation — 定期聚合
  // =========================================================================

  /**
   * 启动聚合定时器。
   */
  private startAggregation(): void {
    if (this.aggregationTimer) return;
    this.aggregationTimer = setInterval(() => {
      void this.runAggregation();
    }, this.config.aggregationIntervalMs);
    if (this.aggregationTimer.unref) {
      this.aggregationTimer.unref();
    }
  }

  /**
   * 执行聚合 — 从 raw events 生成 hourly + daily rollups。
   *
   * 使用 SQL GROUP BY 在数据库内完成聚合（避免大量数据传输到 Node）。
   * 聚合范围: 未聚合的 events（通过时间窗口确定）。
   */
  async runAggregation(): Promise<void> {
    if (!this.db) return;

    try {
      // Step 1: 先尝试从 JSONL 导入新数据
      await this.importFromJsonl();

      // Step 2: Hourly 聚合
      this.aggregateHourly();

      // Step 3: Daily 聚合
      this.aggregateDaily();

      // Step 4: 数据保留策略 — 清理过期数据
      this.enforceRetention();

      log.info("Analytics aggregation completed");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Analytics aggregation failed", { error: error.message });
    }
  }

  /**
   * Hourly 聚合 — 按小时粒度汇总。
   */
  private aggregateHourly(): void {
    if (!this.db) return;

    this.db.exec(`
      INSERT OR REPLACE INTO analytics_rollups (
        time_bucket, granularity, key_prefix, project, operation,
        total_count, success_count, error_count, rejected_count, rate_limited_count,
        avg_elapsed_ms, max_elapsed_ms, p95_elapsed_ms,
        search_hit_count, search_total_count, avg_top_score, avg_result_count
      )
      SELECT
        strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS time_bucket,
        'hourly' AS granularity,
        COALESCE(key_prefix, '') AS key_prefix,
        COALESCE(project, '') AS project,
        operation,
        COUNT(*) AS total_count,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
        SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited_count,
        AVG(elapsed_ms) AS avg_elapsed_ms,
        MAX(elapsed_ms) AS max_elapsed_ms,
        AVG(elapsed_ms) AS p95_elapsed_ms,
        SUM(CASE WHEN search_hit = 1 THEN 1 ELSE 0 END) AS search_hit_count,
        SUM(CASE WHEN operation = 'memory_search' THEN 1 ELSE 0 END) AS search_total_count,
        COALESCE(AVG(CASE WHEN top_score IS NOT NULL THEN top_score END), 0) AS avg_top_score,
        COALESCE(AVG(CASE WHEN result_count IS NOT NULL THEN result_count END), 0) AS avg_result_count
      FROM audit_events
      WHERE timestamp >= strftime('%Y-%m-%dT%H:00:00Z', datetime('now', '-25 hours'))
      GROUP BY time_bucket, key_prefix, project, operation
    `);
  }

  /**
   * Daily 聚合 — 从 hourly rollups 再聚合。
   */
  private aggregateDaily(): void {
    if (!this.db) return;

    this.db.exec(`
      INSERT OR REPLACE INTO analytics_rollups (
        time_bucket, granularity, key_prefix, project, operation,
        total_count, success_count, error_count, rejected_count, rate_limited_count,
        avg_elapsed_ms, max_elapsed_ms, p95_elapsed_ms,
        search_hit_count, search_total_count, avg_top_score, avg_result_count
      )
      SELECT
        strftime('%Y-%m-%dT00:00:00Z', time_bucket) AS day_bucket,
        'daily' AS granularity,
        key_prefix,
        project,
        operation,
        SUM(total_count),
        SUM(success_count),
        SUM(error_count),
        SUM(rejected_count),
        SUM(rate_limited_count),
        SUM(avg_elapsed_ms * total_count) / SUM(total_count),
        MAX(max_elapsed_ms),
        MAX(p95_elapsed_ms),
        SUM(search_hit_count),
        SUM(search_total_count),
        CASE WHEN SUM(search_total_count) > 0
          THEN SUM(avg_top_score * search_total_count) / SUM(search_total_count)
          ELSE 0
        END,
        CASE WHEN SUM(search_total_count) > 0
          THEN SUM(avg_result_count * search_total_count) / SUM(search_total_count)
          ELSE 0
        END
      FROM analytics_rollups
      WHERE granularity = 'hourly'
        AND time_bucket >= strftime('%Y-%m-%dT00:00:00Z', datetime('now', '-2 days'))
      GROUP BY day_bucket, key_prefix, project, operation
    `);
  }

  /**
   * 数据保留策略 — 清理过期数据。
   */
  private enforceRetention(): void {
    if (!this.db) return;

    try {
      // Raw events: 30 天
      this.db
        .prepare(
          `DELETE FROM audit_events WHERE timestamp < datetime('now', '-' || @days || ' days')`,
        )
        .run({ days: this.config.rawRetentionDays });

      // Hourly rollups: 7 天
      this.db
        .prepare(
          `DELETE FROM analytics_rollups WHERE granularity = 'hourly' AND time_bucket < datetime('now', '-' || @days || ' days')`,
        )
        .run({ days: this.config.hourlyRetentionDays });

      // Daily rollups: 90 天
      this.db
        .prepare(
          `DELETE FROM analytics_rollups WHERE granularity = 'daily' AND time_bucket < datetime('now', '-' || @days || ' days')`,
        )
        .run({ days: this.config.dailyRetentionDays });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Retention enforcement failed", { error: error.message });
    }
  }

  // =========================================================================
  // Query API — Admin 查询
  // =========================================================================

  /**
   * 查询审计事件（分页 + 过滤）。
   */
  queryEvents(query: AuditQuery): PaginatedResponse<AuditLogEntry> {
    if (!this.db) {
      return {
        data: [],
        pagination: { page: 1, page_size: 50, total_count: 0, total_pages: 0 },
      };
    }

    const { from, to } = resolveTimeRange(query);
    const conditions: string[] = ["timestamp >= @from AND timestamp <= @to"];
    const params: Record<string, unknown> = { from, to };

    if (query.key_prefix) {
      conditions.push("key_prefix = @key_prefix");
      params.key_prefix = query.key_prefix;
    }
    if (query.project) {
      conditions.push("project = @project");
      params.project = query.project;
    }
    if (query.operation) {
      conditions.push("operation = @operation");
      params.operation = query.operation;
    }
    if (query.outcome) {
      conditions.push("outcome = @outcome");
      params.outcome = query.outcome;
    }

    const whereClause = conditions.join(" AND ");

    // Count
    const countResult = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM audit_events WHERE ${whereClause}`,
      )
      .get(params) as { count: number };
    const totalCount = countResult.count;

    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 50;
    const offset = (page - 1) * pageSize;

    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events WHERE ${whereClause}
         ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset }) as AuditLogEntry[];

    // Convert search_hit from 0/1 to boolean
    const data = rows.map((r) => ({
      ...r,
      search_hit:
        r.search_hit !== null && r.search_hit !== undefined
          ? Boolean(r.search_hit)
          : undefined,
    })) as AuditLogEntry[];

    return {
      data,
      pagination: {
        page,
        page_size: pageSize,
        total_count: totalCount,
        total_pages: Math.ceil(totalCount / pageSize),
      },
    };
  }

  /**
   * 查询聚合 rollups — 时间序列数据。
   */
  queryRollups(query: AnalyticsQuery): AnalyticsRollup[] {
    if (!this.db) return [];

    const { from, to } = resolveTimeRange(query);
    const conditions: string[] = [
      "time_bucket >= @from AND time_bucket <= @to",
      "granularity = @granularity",
    ];
    const params: Record<string, unknown> = {
      from,
      to,
      granularity: query.granularity ?? "hourly",
    };

    if (query.key_prefix) {
      conditions.push("key_prefix = @key_prefix");
      params.key_prefix = query.key_prefix;
    }
    if (query.project) {
      conditions.push("project = @project");
      params.project = query.project;
    }
    if (query.operation) {
      conditions.push("operation = @operation");
      params.operation = query.operation;
    }

    const whereClause = conditions.join(" AND ");

    return this.db
      .prepare(
        `SELECT * FROM analytics_rollups WHERE ${whereClause}
         ORDER BY time_bucket ASC`,
      )
      .all(params) as AnalyticsRollup[];
  }

  /**
   * 搜索 Hit Rate — 核心质量指标。
   * Hit = 搜索结果中至少一条 score > threshold。
   */
  getHitRate(params: {
    from?: string | undefined;
    to?: string | undefined;
    range?: string | undefined;
    project?: string | undefined;
  }): HitRateMetrics {
    if (!this.db) {
      return {
        from: "",
        to: "",
        total_searches: 0,
        searches_with_hits: 0,
        hit_rate: 0,
        avg_top_score: 0,
        avg_result_count: 0,
      };
    }

    const { from, to } = resolveTimeRange(params);
    const projectFilter = params.project ? "AND project = @project" : "";

    const queryParams: Record<string, unknown> = { from, to };
    if (params.project) queryParams.project = params.project;

    const result = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_searches,
          SUM(CASE WHEN search_hit = 1 THEN 1 ELSE 0 END) as searches_with_hits,
          COALESCE(AVG(top_score), 0) as avg_top_score,
          COALESCE(AVG(result_count), 0) as avg_result_count
        FROM audit_events
        WHERE operation = 'memory_search'
          AND timestamp >= @from AND timestamp <= @to
          ${projectFilter}`,
      )
      .get(queryParams) as {
      total_searches: number;
      searches_with_hits: number;
      avg_top_score: number;
      avg_result_count: number;
    };

    return {
      from,
      to,
      total_searches: result.total_searches,
      searches_with_hits: result.searches_with_hits ?? 0,
      hit_rate:
        result.total_searches > 0
          ? (result.searches_with_hits ?? 0) / result.total_searches
          : 0,
      avg_top_score: result.avg_top_score,
      avg_result_count: result.avg_result_count,
    };
  }

  /**
   * 按用户 (key_prefix) 汇总使用情况。
   */
  getUserUsage(params: {
    from?: string | undefined;
    to?: string | undefined;
    range?: string | undefined;
  }): UserUsageSummary[] {
    if (!this.db) return [];

    const { from, to } = resolveTimeRange(params);

    return this.db
      .prepare(
        `SELECT
          key_prefix,
          COUNT(*) as total_operations,
          SUM(CASE WHEN operation = 'memory_save' THEN 1 ELSE 0 END) as save_count,
          SUM(CASE WHEN operation = 'memory_search' THEN 1 ELSE 0 END) as search_count,
          SUM(CASE WHEN operation = 'memory_forget' THEN 1 ELSE 0 END) as forget_count,
          SUM(CASE WHEN operation = 'memory_status' THEN 1 ELSE 0 END) as status_count,
          SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as error_count,
          SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_count,
          GROUP_CONCAT(DISTINCT project) as projects_csv,
          MAX(timestamp) as last_active,
          MIN(timestamp) as first_seen
        FROM audit_events
        WHERE timestamp >= @from AND timestamp <= @to
        GROUP BY key_prefix
        ORDER BY total_operations DESC`,
      )
      .all({ from, to })
      .map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return {
          key_prefix: String(r.key_prefix ?? ""),
          total_operations: Number(r.total_operations ?? 0),
          save_count: Number(r.save_count ?? 0),
          search_count: Number(r.search_count ?? 0),
          forget_count: Number(r.forget_count ?? 0),
          status_count: Number(r.status_count ?? 0),
          error_count: Number(r.error_count ?? 0),
          rate_limited_count: Number(r.rate_limited_count ?? 0),
          projects: String(r.projects_csv ?? "")
            .split(",")
            .filter(Boolean),
          last_active: String(r.last_active ?? ""),
          first_seen: String(r.first_seen ?? ""),
        };
      });
  }

  /**
   * 按项目汇总使用情况。
   */
  getProjectUsage(params: {
    from?: string | undefined;
    to?: string | undefined;
    range?: string | undefined;
  }): ProjectUsageSummary[] {
    if (!this.db) return [];

    const { from, to } = resolveTimeRange(params);

    return this.db
      .prepare(
        `SELECT
          project,
          COUNT(*) as total_operations,
          SUM(CASE WHEN operation = 'memory_save' THEN 1 ELSE 0 END) as save_count,
          SUM(CASE WHEN operation = 'memory_search' THEN 1 ELSE 0 END) as search_count,
          SUM(CASE WHEN operation = 'memory_forget' THEN 1 ELSE 0 END) as forget_count,
          COUNT(DISTINCT key_prefix) as active_users,
          CASE
            WHEN SUM(CASE WHEN operation = 'memory_search' THEN 1 ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN operation = 'memory_search' AND search_hit = 1 THEN 1 ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN operation = 'memory_search' THEN 1 ELSE 0 END)
            ELSE 0
          END as search_hit_rate,
          MAX(timestamp) as last_active
        FROM audit_events
        WHERE timestamp >= @from AND timestamp <= @to
        GROUP BY project
        ORDER BY total_operations DESC`,
      )
      .all({ from, to })
      .map((row: unknown) => {
        const r = row as Record<string, unknown>;
        return {
          project: String(r.project ?? ""),
          total_operations: Number(r.total_operations ?? 0),
          save_count: Number(r.save_count ?? 0),
          search_count: Number(r.search_count ?? 0),
          forget_count: Number(r.forget_count ?? 0),
          active_users: Number(r.active_users ?? 0),
          search_hit_rate: Number(r.search_hit_rate ?? 0),
          last_active: String(r.last_active ?? ""),
        };
      });
  }

  /**
   * 错误率统计。
   */
  getErrorRate(params: {
    from?: string | undefined;
    to?: string | undefined;
    range?: string | undefined;
  }): ErrorRateMetrics {
    if (!this.db) {
      return {
        from: "",
        to: "",
        total_requests: 0,
        error_count: 0,
        error_rate: 0,
        rejected_count: 0,
        rate_limited_count: 0,
        by_operation: {},
      };
    }

    const { from, to } = resolveTimeRange(params);

    const overall = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_requests,
          SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as error_count,
          SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END) as rejected_count,
          SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_count
        FROM audit_events
        WHERE timestamp >= @from AND timestamp <= @to`,
      )
      .get({ from, to }) as {
      total_requests: number;
      error_count: number;
      rejected_count: number;
      rate_limited_count: number;
    };

    const byOp = this.db
      .prepare(
        `SELECT
          operation,
          COUNT(*) as total,
          SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as errors
        FROM audit_events
        WHERE timestamp >= @from AND timestamp <= @to
        GROUP BY operation`,
      )
      .all({ from, to }) as Array<{
      operation: string;
      total: number;
      errors: number;
    }>;

    const byOperation: Record<
      string,
      { errors: number; total: number; rate: number }
    > = {};
    for (const row of byOp) {
      byOperation[row.operation] = {
        errors: row.errors,
        total: row.total,
        rate: row.total > 0 ? row.errors / row.total : 0,
      };
    }

    return {
      from,
      to,
      total_requests: overall.total_requests,
      error_count: overall.error_count,
      error_rate:
        overall.total_requests > 0
          ? overall.error_count / overall.total_requests
          : 0,
      rejected_count: overall.rejected_count,
      rate_limited_count: overall.rate_limited_count,
      by_operation: byOperation,
    };
  }

  /**
   * 获取用于 CSV 导出的原始数据。
   */
  exportEvents(query: AuditQuery): AuditLogEntry[] {
    if (!this.db) return [];

    const { from, to } = resolveTimeRange(query);
    const conditions: string[] = ["timestamp >= @from AND timestamp <= @to"];
    const params: Record<string, unknown> = { from, to };

    if (query.key_prefix) {
      conditions.push("key_prefix = @key_prefix");
      params.key_prefix = query.key_prefix;
    }
    if (query.project) {
      conditions.push("project = @project");
      params.project = query.project;
    }
    if (query.operation) {
      conditions.push("operation = @operation");
      params.operation = query.operation;
    }

    const whereClause = conditions.join(" AND ");
    const limit = Math.min((query.page_size ?? 50) * (query.page ?? 1), 10000);

    return this.db
      .prepare(
        `SELECT * FROM audit_events WHERE ${whereClause}
         ORDER BY timestamp DESC LIMIT @limit`,
      )
      .all({ ...params, limit }) as AuditLogEntry[];
  }
}
