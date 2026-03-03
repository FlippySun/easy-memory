/**
 * @module save
 * @description memory_save MCP Tool Handler — 安全写入管道。
 *
 * Pipeline: Input → safeParse → Injection Check → Length Check →
 *           basicSanitize → computeHash → ProjectLock → dedup → embed → Qdrant.upsert
 *
 * 铁律:
 * - [CORE_SCHEMA §3.1]: upsert 必须 wait:true (已在 QdrantService 中强制)
 * - [CORE_SCHEMA §7 #8]: 写入前必须经过 basicSanitize
 * - [CORE_SCHEMA §3]: content_hash 去重
 * - [CORE_SCHEMA §3.10]: per-project 写入串行化（D5-1）
 */

import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { QdrantService } from "../services/qdrant.js";
import type {
  EmbeddingService,
  EmbeddingResult,
} from "../services/embedding.js";
import type { BM25Encoder } from "../services/bm25.js";
import { basicSanitize, isFullyRedacted } from "../utils/sanitize.js";
import { computeHash } from "../utils/hash.js";
import { log } from "../utils/logger.js";
import {
  MemorySaveInputSchema,
  CURRENT_SCHEMA_VERSION,
  type MemorySaveOutput,
  slugify,
} from "../types/schema.js";

// ===== D-AUDIT: Save 审计日志 =====
const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH ??
  join(process.env.HOME ?? "/tmp", ".easy-memory-audit.jsonl");

/**
 * D-AUDIT: 审计日志写入（fire-and-forget 异步）。
 * 竞态安全：JSONL 每条 < PIPE_BUF (4096B)，OS 保证原子写入。
 */
function writeAuditLog(entry: Record<string, unknown>): void {
  appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n").catch(() => {
    // JSONL 写入失败时静默处理 — stderr 日志已作为兜底
  });
}

// ===== D4-6: 内容长度限制 =====
const MAX_CONTENT_LENGTH = 50_000;

// ===== D5-6: 内存 hashSet 容量上限 =====
const MAX_HASH_SET_SIZE = 10_000;

// ===== [FIX H-1]: Boundary Marker 剥离 =====
/**
 * 剥离 content 中的 boundary markers，防止存储的内容包含
 * [MEMORY_CONTENT_START] / [MEMORY_CONTENT_END] 导致 search 输出时
 * prompt injection 边界被攻击者提前关闭。
 *
 * 替换为无害形式 "(boundary marker removed)"
 */
const BOUNDARY_MARKER_PATTERN = /\[MEMORY_CONTENT_(?:START|END)\]/gi;

function stripBoundaryMarkers(content: string): string {
  return content.replace(BOUNDARY_MARKER_PATTERN, "(boundary marker removed)");
}

// ===== D4-2: Prompt Injection 检测模式 =====
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i,
  /disregard\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|rules)/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /\bsystem\s*:\s*/i,
  /\[system\]/i,
  /```system\b/i,
  /\bact\s+as\s+(?:a|an)\s+/i,
  /\bpretend\s+(?:you(?:'re| are)\s+)/i,
  /\bnew\s+instructions?\s*:/i,
  /\boverride\s+(?:all\s+)?(?:previous|prior)?\s*(?:instructions|rules|constraints)/i,
];

/**
 * D4-2: 检测内容是否包含 Prompt Injection 模式。
 */
function detectPromptInjection(content: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(content));
}

// ===== D5-1: Per-project 异步写入锁 =====
const projectLocks = new Map<string, Promise<void>>();

/**
 * 保证同一 project 的写入操作串行执行，防止并发去重竞态。
 * 使用 Promise chain 模式实现轻量级互斥锁。
 */
function withProjectLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectLocks.get(project) ?? Promise.resolve();
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  projectLocks.set(project, lockPromise);

  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      releaseLock!();
      // S2: 清理已完成且无后续排队者的 lock 条目，防止内存泄漏
      if (projectLocks.get(project) === lockPromise) {
        projectLocks.delete(project);
      }
    }
  });
}

/** 内存中的 content_hash 去重集合 (per-project) */
const hashSets = new Map<string, Set<string>>();

function getHashSet(project: string): Set<string> {
  let set = hashSets.get(project);
  if (!set) {
    set = new Set<string>();
    hashSets.set(project, set);
  }
  return set;
}

/**
 * D5-6: 当 hashSet 达到容量上限时，淘汰最早的 20% 条目。
 * Set 的迭代顺序与插入顺序一致，因此最早的条目在前。
 */
function evictIfNeeded(hashSet: Set<string>): void {
  if (hashSet.size < MAX_HASH_SET_SIZE) return;
  const removeCount = Math.floor(MAX_HASH_SET_SIZE * 0.2);
  let removed = 0;
  for (const hash of hashSet) {
    if (removed >= removeCount) break;
    hashSet.delete(hash);
    removed++;
  }
}

export interface SaveHandlerDeps {
  qdrant: QdrantService;
  embedding: EmbeddingService;
  /** [ADR 补充二十] BM25 稀疏编码器 — 可选，缺失时跳过稀疏向量 */
  bm25?: BM25Encoder;
  defaultProject: string;
  /** D3-5: 嵌入模型名称，避免硬编码 */
  embeddingModel?: string;
}

/**
 * memory_save handler — 安全写入管道。
 *
 * D1-6: 使用 safeParse 代替 parse
 * D4-6: 内容长度限制
 * D4-2: Prompt Injection 检测
 * D5-1: per-project 写入串行化
 * D1-2: embed() 失败优雅降级
 * D3-5: 模型名称从 deps 获取
 * D5-6: hashSet 容量管理
 */
export async function handleSave(
  rawInput: unknown,
  deps: SaveHandlerDeps,
): Promise<MemorySaveOutput> {
  // D1-6: 使用 safeParse 代替 parse，避免抛异常
  const parsed = MemorySaveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    log.warn("Save input validation failed", { issues });
    return {
      id: "",
      status: "rejected_low_quality",
      message: `Invalid input: ${issues}`,
    };
  }
  const input = parsed.data;
  const project = input.project ?? deps.defaultProject;

  // D4-6: 内容长度限制
  if (input.content.length > MAX_CONTENT_LENGTH) {
    log.warn("Content too long", {
      project,
      length: input.content.length,
      limit: MAX_CONTENT_LENGTH,
    });
    return {
      id: "",
      status: "rejected_low_quality",
      message: `Content too long: ${input.content.length} chars exceeds limit of ${MAX_CONTENT_LENGTH}.`,
    };
  }

  // D4-2: Prompt Injection 检测
  // [FIX H-5]: NFKC 归一化前置到 injection 检测之前
  // 防止全角 Unicode (ｓｙｓｔｅｍ) 绕过正则
  const normalizedContent = input.content.normalize("NFKC");
  if (detectPromptInjection(normalizedContent)) {
    log.warn("Prompt injection detected, rejecting save", { project });
    return {
      id: "",
      status: "rejected_prompt_injection",
      message:
        "Content contains patterns that appear to be prompt injection attempts.",
    };
  }

  // D5-1: per-project 串行化，防止并发去重竞态
  // [FIX M-2]: 使用 slugify 后的 project name 作为锁 key
  // 防止 "my-project" 和 "my project" 等变体绕过去重
  const projectSlug = slugify(project);
  return withProjectLock(projectSlug, async () => {
    // Step 2: 安全脱敏
    const sanitizedContent = basicSanitize(input.content);

    // [FIX H-1]: 剥离 boundary markers 防止 Prompt Injection 绕过
    // 攻击者可在 content 中嵌入 [MEMORY_CONTENT_END] 来提前关闭边界标记
    const cleanedContent = stripBoundaryMarkers(sanitizedContent);

    // 注意: 使用 cleanedContent（脱敏+marker剥离后）而非 sanitizedContent
    // marker 替换文本 "(boundary marker removed)" 视为有效内容，行为等价于修复前
    if (isFullyRedacted(input.content, cleanedContent)) {
      log.warn("Content fully redacted, rejecting save", { project });
      return {
        id: "",
        status: "rejected_sensitive",
        message:
          "Content appears to be entirely sensitive data and was rejected.",
      };
    }

    // Step 3: Hash 去重
    const contentHash = computeHash(cleanedContent);
    // [FIX M-2]: hashSet key 也使用 slug，与 lock key 一致
    const hashSet = getHashSet(projectSlug);

    if (hashSet.has(contentHash)) {
      log.info("Duplicate content detected", { project, contentHash });
      return {
        id: "",
        status: "duplicate_merged",
        message: "This content already exists (exact hash match).",
      };
    }

    // D1-2: 生成 embedding — 失败时优雅降级
    // 使用 embedWithMeta() 获取实际使用的 model（降级场景下尤为重要）
    let embeddingResult: EmbeddingResult;
    try {
      embeddingResult = await deps.embedding.embedWithMeta(cleanedContent);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Embedding failed, cannot save memory", {
        error: error.message,
        project,
      });
      return {
        id: "",
        status: "pending_embedding",
        message: `Embedding service unavailable. Memory not saved. Error: ${error.message}`,
      };
    }

    // 解构实际使用的向量和模型（降级时 model 会反映真实 Provider）
    const { vector, model: embeddingModel } = embeddingResult;

    // [ADR 补充二十] 生成 BM25 稀疏向量（可选）
    const sparseVector = deps.bm25?.encode(cleanedContent);

    // Step 5: 写入 Qdrant
    const id = randomUUID();
    const now = new Date().toISOString();

    const payload: Record<string, unknown> = {
      content: cleanedContent,
      content_hash: contentHash,
      project,
      source: input.source ?? "conversation",
      fact_type: input.fact_type ?? "observation",
      tags: input.tags ?? [],
      confidence: input.confidence ?? 0.7,
      lifecycle: "active",
      access_count: 0,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      schema_version: CURRENT_SCHEMA_VERSION,
      embedding_model: embeddingModel,
      related_ids: input.related_ids ?? [],
      ...(input.source_file ? { source_file: input.source_file } : {}),
      ...(input.source_line ? { source_line: input.source_line } : {}),
    };

    await deps.qdrant.upsert(project, [
      {
        id,
        vector,
        ...(sparseVector ? { sparseVector } : {}),
        payload,
      },
    ]);

    // D5-6: 容量管理 — 淘汰过老的 hash 条目
    evictIfNeeded(hashSet);

    // 成功后加入去重集
    hashSet.add(contentHash);

    // D-AUDIT: 审计日志 — 同时写入 stderr 和 JSONL 文件
    const auditEntry = {
      type: "AUDIT:memory_save",
      id,
      project,
      contentHash,
      source: input.source ?? "conversation",
      fact_type: input.fact_type ?? "observation",
      embeddingModel,
      timestamp: now,
    };
    log.info("AUDIT:memory_save", auditEntry);
    writeAuditLog(auditEntry);

    return {
      id,
      status: "saved",
      message: `Memory saved successfully. ID: ${id}`,
    };
  });
}

/**
 * 清除指定项目的内存 hash 缓存（用于测试）。
 * [FIX M-2]: 同时支持原始名和 slug 名清理
 */
export function clearHashCache(project?: string): void {
  if (project) {
    // hashSets 的 key 统一为 slugify(project)，因此只需删除 slug 版本
    hashSets.delete(slugify(project));
  } else {
    hashSets.clear();
  }
}

/**
 * 清除所有 project 锁（用于测试清理）。
 */
export function clearProjectLocks(): void {
  projectLocks.clear();
}
