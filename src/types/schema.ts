/**
 * @module schema
 * @description MemoryMetadataSchema v2 的 Zod 实现 + 所有 MCP Tool I/O Schema。
 * 此文件是唯一事实来源 (Single Source of Truth)。
 *
 * 基于 CORE_SCHEMA.md §1 和 §2。
 */

import { z } from "zod/v4";

// ===== 枚举常量 =====
export const SOURCE_ENUM = ["conversation", "file_watch", "manual"] as const;

export const FACT_TYPE_ENUM = [
  "verified_fact",
  "decision",
  "hypothesis",
  "discussion",
  "observation",
] as const;

export const LIFECYCLE_ENUM = [
  "active",
  "disputed",
  "outdated",
  "archived",
] as const;

// ===== 核心 Metadata Schema =====
export const MemoryMetadataSchema = z.object({
  content: z.string().min(1, "内容不能为空"),
  content_hash: z.string(),

  project: z.string().min(1),
  source: z.enum(SOURCE_ENUM).default("conversation"),
  fact_type: z.enum(FACT_TYPE_ENUM).default("observation"),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
  quality_score: z.number().min(0).max(1).optional(),

  source_file: z.string().optional(),
  source_line: z.number().int().positive().optional(),
  conversation_id: z.string().optional(),

  related_ids: z.array(z.string()).default([]),
  chunk_index: z.number().int().nonnegative().optional(),
  parent_id: z.string().optional(),

  lifecycle: z.enum(LIFECYCLE_ENUM).default("active"),
  access_count: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_accessed_at: z.string().datetime(),

  schema_version: z.number().int().positive().default(2),
  embedding_model: z.string().default("unknown"),
});

// ===== 类型导出 =====
export type MemoryMetadata = z.infer<typeof MemoryMetadataSchema>;
export type MemorySource = (typeof SOURCE_ENUM)[number];
export type FactType = (typeof FACT_TYPE_ENUM)[number];
export type Lifecycle = (typeof LIFECYCLE_ENUM)[number];

// ===== Schema 版本常量 =====
export const CURRENT_SCHEMA_VERSION = 2;

// ===== MCP Tool Input Schemas =====
// D1-1: All input schemas use .passthrough() for forward compatibility
export const MemorySaveInputSchema = z
  .object({
    content: z.string().min(1),
    project: z.string().optional(),
    source: z.enum(SOURCE_ENUM).optional(),
    fact_type: z.enum(FACT_TYPE_ENUM).optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    source_file: z.string().optional(),
    source_line: z.number().int().positive().optional(),
    related_ids: z.array(z.string()).optional(),
  })
  .passthrough();

export type MemorySaveInput = z.infer<typeof MemorySaveInputSchema>;

export const MemorySearchInputSchema = z
  .object({
    query: z.string().min(1),
    project: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(5),
    threshold: z.number().min(0).max(1).default(0.65),
    include_outdated: z.boolean().default(false),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const MemoryForgetInputSchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum(["archive", "outdated", "delete"]),
    reason: z.string().min(1),
    project: z.string().optional(),
  })
  .passthrough();

export type MemoryForgetInput = z.infer<typeof MemoryForgetInputSchema>;

export const MemoryStatusInputSchema = z
  .object({
    project: z.string().optional(),
  })
  .passthrough();

export type MemoryStatusInput = z.infer<typeof MemoryStatusInputSchema>;

// ===== MCP Tool Output Types =====
// D1-2: Added pending_embedding + rejected_prompt_injection statuses
export type MemorySaveStatus =
  | "saved"
  | "duplicate_merged"
  | "rejected_sensitive"
  | "rejected_low_quality"
  | "pending_embedding"
  | "rejected_prompt_injection";

export interface MemorySaveOutput {
  id: string;
  status: MemorySaveStatus;
  message: string;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  fact_type: FactType;
  tags: string[];
  source: MemorySource;
  confidence: number;
  lifecycle: Lifecycle;
  created_at: string;
  source_file?: string;
  source_line?: number;
}

export interface MemorySearchOutput {
  memories: MemorySearchResult[];
  total_found: number;
  system_note: string;
}

// D1-8: Added "error" status for non-404 failures
export interface MemoryForgetOutput {
  status: "forgotten" | "archived" | "not_found" | "error";
  message: string;
}

// D1-3: Added session and pending_count fields
export interface MemoryStatusOutput {
  qdrant: "ready" | "connecting" | "unavailable";
  embedding:
    | "ready"
    | "warming_up"
    | "reconnecting"
    | "permanently_unavailable";
  collection: {
    name: string;
    points_count: number;
    schema_version: number;
  } | null;
  session: {
    uptime_seconds: number;
    started_at: string;
  };
  pending_count: number;
  /** API 预算护城河统计 (仅在 RateLimiter 已注入时存在) */
  cost_guard?: {
    calls_last_minute: number;
    gemini_calls_last_hour: number;
    gemini_calls_today: number;
    gemini_circuit_open: boolean;
  };
}

// ===== 统一阈值表 [CORE_SCHEMA §5] =====
export const THRESHOLDS = {
  // 写入管道
  DEDUP_HASH_EXACT: "exact" as const,
  QUALITY_ACCEPT: 0.6,
  QUALITY_REJECT: 0.4,

  // 搜索管道
  SEARCH_MIN_SCORE: 0.65,
  SEARCH_DEFAULT_LIMIT: 5,
  SEARCH_MAX_LIMIT: 20,

  // 通信
  STDIO_MAX_BYTES: 61_440, // 60KB

  // GracefulShutdown
  SHUTDOWN_DRAIN_MS: 5000,
} as const;

// ===== Collection 命名 [CORE_SCHEMA §3.7] =====
// D1-7: Handle CJK and non-ASCII characters by hex-encoding them
// D-AUDIT: 保留下划线以防止 "my_project" 和 "my-project" 碰撞导致跨项目数据污染
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/g, "-") // keep CJK/kana + underscore
    .replace(
      /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g,
      (ch) => `u${ch.codePointAt(0)!.toString(16)}`,
    ) // hex-encode CJK
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  // Fallback: if slug is empty after processing, use hex of first chars
  if (slug.length === 0) {
    return Array.from(name.slice(0, 16))
      .map((ch) => `u${ch.codePointAt(0)!.toString(16)}`)
      .join("")
      .slice(0, 64);
  }
  return slug;
}

export function collectionName(projectSlug: string): string {
  return `em_${slugify(projectSlug)}`;
}
