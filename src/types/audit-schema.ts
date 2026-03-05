/**
 * @module audit-schema
 * @description 审计日志 & 分析系统的类型定义和 Zod Schema。
 *
 * 设计原则:
 * - 每条审计日志必须可追溯到：谁(who)、何时(when)、做了什么(what)、对什么(target)、结果(outcome)
 * - 绝不记录完整内容 — 仅 hash + 截断预览
 * - API Key 仅记录前缀（`key_prefix`）— 永不明文
 * - 所有时间戳使用 ISO 8601 UTC（消除时区歧义）
 */

import { z } from "zod/v4";

// =========================================================================
// Audit Log Entry — 每次操作的完整审计记录
// =========================================================================

/** 操作类型枚举 */
export const AUDIT_OPERATION = [
  "memory_save",
  "memory_search",
  "memory_forget",
  "memory_status",
  "auth_login",
  "auth_login_failed",
  "auth_logout",
  "auth_refresh",
  "auth_refresh_failed",
  "auth_register",
  "auth_user_update",
  "auth_user_delete",
] as const;

export type AuditOperation = (typeof AUDIT_OPERATION)[number];

/** 操作结果枚举 */
export const AUDIT_OUTCOME = [
  "success",
  "rejected",
  "error",
  "rate_limited",
  "unauthorized",
] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOME)[number];

/**
 * 审计日志条目 — 核心数据契约。
 *
 * 每个字段的选择理由：
 * - `event_id`: UUID v4, 全局唯一，用于日志关联和幂等性校验
 * - `key_prefix`: API Key 的前 8 字符（足够区分用户，不足以泄露密钥）
 * - `content_preview`: 截断至 80 字符 + "..."（日志可读性 vs 安全性的平衡点）
 */
export interface AuditLogEntry {
  /** UUID v4，每条日志唯一 */
  event_id: string;
  /** ISO 8601 UTC 时间戳 */
  timestamp: string;

  // === Who ===
  /** API Key 前缀 (前 8 字符)，空串表示无认证/开发模式 */
  key_prefix: string;
  /** 客户端 User-Agent */
  user_agent: string;
  /** 客户端 IP（trust proxy 时为 X-Forwarded-For） */
  client_ip: string;

  // === What ===
  /** 操作类型 */
  operation: AuditOperation;
  /** 目标 project */
  project: string;
  /** 操作结果 */
  outcome: AuditOutcome;
  /** 结果详细消息（拒绝原因、错误信息等） */
  outcome_detail: string;

  // === Operation-specific 元数据 ===
  /** Save: content_hash */
  content_hash?: string;
  /** Save: 内容预览（截断至 80 字符） */
  content_preview?: string;
  /** Save: 保存后的 memory ID */
  memory_id?: string;
  /** Save: 使用的 embedding 模型 */
  embedding_model?: string;
  /** Save: fact_type */
  fact_type?: string;
  /** Save: source */
  source?: string;
  /** Save: 保存状态 */
  save_status?: string;

  /** Search: 查询预览（截断至 80 字符） */
  query_preview?: string;
  /** Search: 返回结果数量 */
  result_count?: number;
  /** Search: 最高分数 */
  top_score?: number;
  /** Search: 请求的 limit */
  search_limit?: number;
  /** Search: score 阈值 */
  search_threshold?: number;
  /** Search: 是否有结果超过阈值（hit = true） */
  search_hit?: boolean;

  /** Forget: 目标 memory ID */
  forget_target_id?: string;
  /** Forget: 动作类型 */
  forget_action?: string;
  /** Forget: 原因 */
  forget_reason?: string;

  // === Performance 指标 ===
  /** 请求总耗时 (ms) */
  elapsed_ms: number;
  /** Embedding 生成耗时 (ms)，仅 save/search */
  embedding_ms?: number;
  /** Qdrant 操作耗时 (ms) */
  qdrant_ms?: number;

  // === 环境 ===
  /** HTTP 方法 */
  http_method: string;
  /** 请求路径 */
  http_path: string;
  /** HTTP 状态码 */
  http_status: number;
}

// =========================================================================
// Analytics — 预聚合数据模型
// =========================================================================

/** 时间粒度 */
export type TimeGranularity = "hourly" | "daily";

/**
 * 聚合统计桶 — 按 (time_bucket, key_prefix, project, operation) 分组。
 *
 * SQLite 中对应 `analytics_rollup` 表。
 * hourly 桶保留 7 天，daily 桶保留 90 天。
 */
export interface AnalyticsRollup {
  /** 时间桶起始 (ISO 8601 UTC) */
  time_bucket: string;
  /** 粒度: hourly | daily */
  granularity: TimeGranularity;
  /** API Key 前缀 */
  key_prefix: string;
  /** 项目名 */
  project: string;
  /** 操作类型 */
  operation: AuditOperation;

  // === 计数 ===
  total_count: number;
  success_count: number;
  error_count: number;
  rejected_count: number;
  rate_limited_count: number;

  // === 性能分位（仅 success） ===
  avg_elapsed_ms: number;
  max_elapsed_ms: number;
  p95_elapsed_ms: number;

  // === Search-specific ===
  /** search 操作: 有结果(score > threshold)的次数 */
  search_hit_count: number;
  /** search 操作: 总搜索次数 (= total_count for search) */
  search_total_count: number;
  /** search 操作: 平均 top_score */
  avg_top_score: number;
  /** search 操作: 平均返回结果数 */
  avg_result_count: number;
}

/**
 * Hit Rate 指标 — 搜索质量的核心衡量。
 */
export interface HitRateMetrics {
  /** 时间范围起始 */
  from: string;
  /** 时间范围结束 */
  to: string;
  /** 总搜索次数 */
  total_searches: number;
  /** 有结果的搜索次数（至少一条 result score > threshold） */
  searches_with_hits: number;
  /** Hit Rate = searches_with_hits / total_searches */
  hit_rate: number;
  /** 平均 top score */
  avg_top_score: number;
  /** 平均结果数 */
  avg_result_count: number;
}

/**
 * 用户使用概要。
 */
export interface UserUsageSummary {
  key_prefix: string;
  total_operations: number;
  save_count: number;
  search_count: number;
  forget_count: number;
  status_count: number;
  error_count: number;
  rate_limited_count: number;
  /** 使用的项目列表 */
  projects: string[];
  /** 最近活跃时间 */
  last_active: string;
  /** 首次活跃时间 */
  first_seen: string;
}

/**
 * 项目使用概要。
 */
export interface ProjectUsageSummary {
  project: string;
  total_operations: number;
  save_count: number;
  search_count: number;
  forget_count: number;
  /** 活跃用户数 */
  active_users: number;
  /** 搜索 hit rate */
  search_hit_rate: number;
  /** 最近活跃时间 */
  last_active: string;
}

/**
 * 错误率统计。
 */
export interface ErrorRateMetrics {
  /** 时间范围起始 */
  from: string;
  /** 时间范围结束 */
  to: string;
  /** 总请求数 */
  total_requests: number;
  /** 错误数 */
  error_count: number;
  /** 错误率 */
  error_rate: number;
  /** 拒绝数 */
  rejected_count: number;
  /** 限流数 */
  rate_limited_count: number;
  /** 按操作类型分组的错误详情 */
  by_operation: Record<string, { errors: number; total: number; rate: number }>;
}

// =========================================================================
// Admin API Query Schemas
// =========================================================================

/** 时间范围查询参数 */
export const TimeRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** 快捷时间范围: 1h, 6h, 24h, 7d, 30d */
  range: z
    .enum(["1h", "6h", "24h", "7d", "30d", "90d"])
    .optional()
    .default("24h"),
});

export type TimeRangeQuery = z.infer<typeof TimeRangeQuerySchema>;

/** 分页参数 */
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});

export type PaginationParams = z.infer<typeof PaginationSchema>;

/** 审计日志查询过滤器 */
export const AuditQuerySchema = z
  .object({
    key_prefix: z.string().optional(),
    project: z.string().optional(),
    operation: z.enum(AUDIT_OPERATION).optional(),
    outcome: z.enum(AUDIT_OUTCOME).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    range: z
      .enum(["1h", "6h", "24h", "7d", "30d", "90d"])
      .optional()
      .default("24h"),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strip();

export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/** 分析数据查询参数 */
export const AnalyticsQuerySchema = z
  .object({
    key_prefix: z.string().optional(),
    project: z.string().optional(),
    operation: z.enum(AUDIT_OPERATION).optional(),
    granularity: z.enum(["hourly", "daily"]).default("hourly"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    range: z
      .enum(["1h", "6h", "24h", "7d", "30d", "90d"])
      .optional()
      .default("24h"),
  })
  .strip();

export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/** 分页响应包装 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    page_size: number;
    total_count: number;
    total_pages: number;
  };
}

// =========================================================================
// Utility Functions
// =========================================================================

/**
 * 从 Bearer token 提取前缀 (前 8 字符)。
 * 永不暴露完整 token。
 */
export function extractKeyPrefix(authHeader: string | undefined): string {
  if (!authHeader) return "";
  const spaceIdx = authHeader.indexOf(" ");
  if (spaceIdx === -1) return "";
  const token = authHeader.slice(spaceIdx + 1).trim();
  if (!token) return "";
  return token.slice(0, 8);
}

/**
 * 将内容截断为安全预览（80 字符 + "..."）。
 * 绝不在审计日志中保存完整内容。
 */
export function truncatePreview(content: string, maxLen = 80): string {
  if (!content) return "";
  const singleLine = content.replace(/[\n\r]+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen) + "...";
}

/**
 * 解析快捷时间范围为 { from, to } ISO 8601 UTC 字符串。
 *
 * ⚠️ 时区处理: 所有内部计算强制使用 UTC，消除时区歧义。
 */
export function resolveTimeRange(params: {
  from?: string | undefined;
  to?: string | undefined;
  range?: string | undefined;
}): { from: string; to: string } {
  const now = new Date();
  const to = params.to ?? now.toISOString();

  if (params.from) {
    return { from: params.from, to };
  }

  const rangeMs: Record<string, number> = {
    "1h": 3_600_000,
    "6h": 21_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
    "30d": 2_592_000_000,
    "90d": 7_776_000_000,
  };

  const offset = rangeMs[params.range ?? "24h"] ?? 86_400_000;
  const from = new Date(now.getTime() - offset).toISOString();
  return { from, to };
}
