/**
 * @module admin-schema
 * @description Admin Management API 的类型定义和 Zod Schema。
 *
 * 覆盖:
 * - API Key 管理 (CRUD + rotate)
 * - Ban 管理 (by key / IP with CIDR)
 * - Runtime 配置变更
 * - Admin 操作审计
 *
 * 安全铁律:
 * - API Key 明文仅在创建/轮转时返回一次，之后不可恢复
 * - 存储时只保存 SHA-256 hash
 * - 展示时只暴露 prefix (前 8 字符)
 */

import { z } from "zod/v4";

// =========================================================================
// Enums & Constants
// =========================================================================

/** API Key 作用域 — 细粒度权限控制 */
export const API_KEY_SCOPE = [
  "memory:read",
  "memory:write",
  "memory:delete",
  "status:read",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPE)[number];

/** 默认作用域 — 新 key 如果未指定 scopes，使用此默认集合 */
export const DEFAULT_SCOPES: ApiKeyScope[] = [
  "memory:read",
  "memory:write",
  "memory:delete",
  "status:read",
];

/** Ban 类型 */
export const BAN_TYPE = ["api_key", "ip"] as const;
export type BanType = (typeof BAN_TYPE)[number];

/** Admin 操作类型 */
export const ADMIN_ACTION = [
  "key_create",
  "key_revoke",
  "key_update",
  "key_rotate",
  "ban_create",
  "ban_remove",
  "config_update",
  "config_reset",
] as const;
export type AdminAction = (typeof ADMIN_ACTION)[number];

/** 排序方向 */
export const SORT_ORDER = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDER)[number];

// =========================================================================
// API Key — 数据模型
// =========================================================================

/**
 * API Key 数据库记录 — 完整数据模型。
 * SQLite `api_keys` 表的 TypeScript 映射。
 */
export interface ApiKeyRecord {
  /** UUID v4, 主键 */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** Key 的前 8 字符 (展示用，不足以恢复完整 key) */
  prefix: string;
  /** SHA-256(plaintext_key) — 唯一约束 */
  key_hash: string;
  /** 创建时间 ISO 8601 UTC */
  created_at: string;
  /** 过期时间 — null 表示永不过期 */
  expires_at: string | null;
  /** 吊销时间 — null 表示未吊销 */
  revoked_at: string | null;
  /** 最近使用时间 */
  last_used_at: string | null;
  /** Per-key 每分钟限流 — null 表示使用全局默认 */
  rate_limit_per_minute: number | null;
  /** 权限作用域 (JSON 序列化的字符串数组) */
  scopes: string;
  /** 自定义元数据 (JSON 序列化) */
  metadata: string;
  /** 累计请求数 */
  total_requests: number;
  /** 创建者 (admin key prefix 或 'system') */
  created_by: string;
}

/**
 * API Key 响应对象 — 安全地暴露给 admin API 调用方。
 * 与 ApiKeyRecord 的区别: scopes/metadata 已反序列化, 新增 is_active 计算字段。
 */
export interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  rate_limit_per_minute: number | null;
  scopes: ApiKeyScope[];
  metadata: Record<string, unknown>;
  total_requests: number;
  created_by: string;
  /** 计算字段: not revoked AND not expired */
  is_active: boolean;
}

/**
 * API Key 创建响应 — 只有在创建/轮转时返回明文 key。
 * ⚠️ 明文 key 仅此一次机会，不可恢复。
 */
export interface ApiKeyCreateResponse extends ApiKeyResponse {
  /** 明文 API Key — 仅在创建/轮转时返回 */
  key: string;
}

// =========================================================================
// API Key — Zod Input Schemas
// =========================================================================

/** POST /admin/keys — 创建新 API Key */
export const CreateApiKeySchema = z
  .object({
    /** 人类可读名称 (1-128 字符) */
    name: z.string().min(1).max(128),
    /** 过期时间 ISO 8601 — 可选 */
    expires_at: z.string().datetime().optional(),
    /** Per-key 每分钟限流 — 可选 */
    rate_limit_per_minute: z.number().int().min(1).max(10000).optional(),
    /** 权限作用域 — 可选，默认全部 */
    scopes: z.array(z.enum(API_KEY_SCOPE)).optional(),
    /** 自定义元数据 */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

/** PATCH /admin/keys/:id — 更新 API Key */
export const UpdateApiKeySchema = z
  .object({
    /** 更新名称 */
    name: z.string().min(1).max(128).optional(),
    /** 更新过期时间 */
    expires_at: z.string().datetime().nullable().optional(),
    /** 更新限流 — null 表示移除自定义限流 */
    rate_limit_per_minute: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .nullable()
      .optional(),
    /** 更新作用域 */
    scopes: z.array(z.enum(API_KEY_SCOPE)).optional(),
    /** 更新元数据 (合并，不替换) */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export type UpdateApiKeyInput = z.infer<typeof UpdateApiKeySchema>;

/** GET /admin/keys — 列表查询参数 */
export const ListApiKeysQuerySchema = z
  .object({
    /** 按名称搜索 (模糊匹配) */
    name: z.string().optional(),
    /** 过滤: 仅活跃 / 仅吊销 / 全部 */
    status: z.enum(["active", "revoked", "all"]).default("all"),
    /** 排序字段 */
    sort_by: z
      .enum(["created_at", "last_used_at", "total_requests", "name"])
      .default("created_at"),
    /** 排序方向 */
    sort_order: z.enum(SORT_ORDER).default("desc"),
    /** 分页 */
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strip();

export type ListApiKeysQuery = z.infer<typeof ListApiKeysQuerySchema>;

// =========================================================================
// Ban — 数据模型
// =========================================================================

/**
 * Ban 数据库记录。
 */
export interface BanRecord {
  /** UUID v4, 主键 */
  id: string;
  /** Ban 类型: api_key (按 key ID) 或 ip (按 IP/CIDR) */
  type: BanType;
  /** Ban 目标: key ID 或 IP/CIDR 表达式 */
  target: string;
  /** Ban 原因 */
  reason: string;
  /** 创建时间 ISO 8601 UTC */
  created_at: string;
  /** 过期时间 — null 表示永久 ban */
  expires_at: string | null;
  /** 创建者 (admin key prefix) */
  created_by: string;
  /** 是否活跃 (1 = active, 0 = removed) */
  is_active: number;
}

/**
 * Ban 响应对象。
 */
export interface BanResponse {
  id: string;
  type: BanType;
  target: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  created_by: string;
  is_active: boolean;
  /** 计算字段: 是否为临时 ban 且已过期 */
  is_expired: boolean;
}

// =========================================================================
// Ban — Zod Input Schemas
// =========================================================================

/** POST /admin/bans — 创建 Ban */
export const CreateBanSchema = z
  .object({
    /** Ban 类型 */
    type: z.enum(BAN_TYPE),
    /** Ban 目标: key ID (UUID) 或 IP/CIDR (e.g., "192.168.1.0/24") */
    target: z.string().min(1).max(256),
    /** Ban 原因 */
    reason: z.string().min(1).max(1024),
    /** 过期时间 ISO 8601 — 可选，null = 永久 */
    expires_at: z.string().datetime().optional(),
    /** TTL 秒数 — 与 expires_at 二选一 */
    ttl_seconds: z.number().int().min(60).max(31536000).optional(),
  })
  .strip()
  .refine((data) => !(data.expires_at && data.ttl_seconds), {
    message: "Cannot specify both expires_at and ttl_seconds",
  });

export type CreateBanInput = z.infer<typeof CreateBanSchema>;

/** GET /admin/bans — 列表查询参数 */
export const ListBansQuerySchema = z
  .object({
    /** 过滤 ban 类型 */
    type: z.enum(BAN_TYPE).optional(),
    /** 过滤: 仅活跃 / 仅过期 / 全部 */
    status: z.enum(["active", "expired", "removed", "all"]).default("active"),
    /** 分页 */
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strip();

export type ListBansQuery = z.infer<typeof ListBansQuerySchema>;

// =========================================================================
// Runtime Configuration — 数据模型
// =========================================================================

/**
 * 可在运行时变更的配置项。
 * 不包含不可变配置（如 Qdrant URL、embedding provider 类型）。
 */
export interface RuntimeConfig {
  /** 全局每分钟限流 */
  rate_limit_per_minute: number;
  /** Gemini 每小时上限 */
  gemini_max_per_hour: number;
  /** Gemini 每日上限 */
  gemini_max_per_day: number;
  /** 默认 project 名称 */
  default_project: string;
  /** 是否要求 TLS */
  require_tls: boolean;
  /** 审计日志是否启用 */
  audit_enabled: boolean;
  /** 数据保留: raw events 天数 */
  raw_retention_days: number;
  /** 数据保留: hourly rollup 天数 */
  hourly_retention_days: number;
  /** 数据保留: daily rollup 天数 */
  daily_retention_days: number;
}

/** PATCH /admin/config — 更新运行时配置 */
export const UpdateRuntimeConfigSchema = z
  .object({
    rate_limit_per_minute: z.number().int().min(1).max(10000).optional(),
    gemini_max_per_hour: z.number().int().min(1).max(10000).optional(),
    gemini_max_per_day: z.number().int().min(1).max(100000).optional(),
    default_project: z.string().min(1).max(128).optional(),
    require_tls: z.boolean().optional(),
    audit_enabled: z.boolean().optional(),
    raw_retention_days: z.number().int().min(1).max(365).optional(),
    hourly_retention_days: z.number().int().min(1).max(90).optional(),
    daily_retention_days: z.number().int().min(1).max(365).optional(),
  })
  .strip()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateRuntimeConfigInput = z.infer<
  typeof UpdateRuntimeConfigSchema
>;

// =========================================================================
// Admin Action Audit — 每个 Admin 操作自身的审计追踪
// =========================================================================

/**
 * Admin 操作审计记录。
 */
export interface AdminActionRecord {
  /** UUID v4 */
  id: string;
  /** ISO 8601 UTC */
  timestamp: string;
  /** 操作者 key prefix */
  admin_key_prefix: string;
  /** 操作类型 */
  action: AdminAction;
  /** 目标类型 (key, ban, config) */
  target_type: string;
  /** 目标 ID */
  target_id: string;
  /** 操作详情 JSON */
  details: string;
  /** 客户端 IP */
  client_ip: string;
}

// =========================================================================
// Paginated Response (generic)
// =========================================================================

/**
 * 分页响应的通用包装。
 */
export interface AdminPaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    page_size: number;
    total_count: number;
    total_pages: number;
  };
}

// =========================================================================
// Analytics — 增强的响应类型
// =========================================================================

/** 系统总览 */
export interface SystemOverview {
  /** 总记忆数 (Qdrant points count) */
  total_memories: number;
  /** 活跃 API Key 数 */
  active_keys: number;
  /** 活跃 Ban 数 */
  active_bans: number;
  /** 今日请求数 */
  requests_today: number;
  /** 今日错误数 */
  errors_today: number;
  /** 系统运行时间 (ms) */
  uptime_ms: number;
  /** 当前 RateLimiter 状态 */
  rate_limiter: {
    calls_last_minute: number;
    gemini_circuit_open: boolean;
  };
}

/** 操作类型分布 */
export interface OperationDistribution {
  operation: string;
  count: number;
  percentage: number;
  avg_elapsed_ms: number;
  error_rate: number;
}

// =========================================================================
// Utility Functions
// =========================================================================

/**
 * 将 ApiKeyRecord 转换为安全的 ApiKeyResponse。
 * 反序列化 JSON 字段，计算 is_active 标志。
 */
export function toApiKeyResponse(record: ApiKeyRecord): ApiKeyResponse {
  const now = new Date().toISOString();
  const isExpired = record.expires_at ? record.expires_at < now : false;
  const isRevoked = !!record.revoked_at;

  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    created_at: record.created_at,
    expires_at: record.expires_at,
    revoked_at: record.revoked_at,
    last_used_at: record.last_used_at,
    rate_limit_per_minute: record.rate_limit_per_minute,
    scopes: safeJsonParse<ApiKeyScope[]>(record.scopes, []),
    metadata: safeJsonParse<Record<string, unknown>>(record.metadata, {}),
    total_requests: record.total_requests,
    created_by: record.created_by,
    is_active: !isRevoked && !isExpired,
  };
}

/**
 * 将 BanRecord 转换为 BanResponse。
 */
export function toBanResponse(record: BanRecord): BanResponse {
  const now = new Date().toISOString();
  const isExpired = record.expires_at ? record.expires_at < now : false;

  return {
    id: record.id,
    type: record.type as BanType,
    target: record.target,
    reason: record.reason,
    created_at: record.created_at,
    expires_at: record.expires_at,
    created_by: record.created_by,
    is_active: record.is_active === 1 && !isExpired,
    is_expired: isExpired,
  };
}

/**
 * 安全 JSON 解析 — 失败时返回默认值。
 */
function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * 检查 IPv4 地址是否在 CIDR 范围内。
 *
 * 支持:
 * - 精确 IP 匹配 (e.g., "192.168.1.1")
 * - CIDR 范围匹配 (e.g., "192.168.1.0/24")
 *
 * ⚠️ 仅支持 IPv4。IPv6 仅做精确匹配。
 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  // IPv6 or non-IPv4 → 仅精确匹配
  if (ip.includes(":") || cidr.includes(":")) {
    return ip === cidr;
  }

  const slashIdx = cidr.indexOf("/");
  if (slashIdx === -1) {
    // 无 CIDR 后缀 → 精确匹配
    return ip === cidr;
  }

  const rangeIp = cidr.slice(0, slashIdx);
  const prefixLen = parseInt(cidr.slice(slashIdx + 1), 10);

  if (Number.isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    return ip === cidr;
  }

  const ipNum = ipv4ToNumber(ip);
  const rangeNum = ipv4ToNumber(rangeIp);

  if (ipNum === null || rangeNum === null) {
    return ip === cidr;
  }

  // 前缀长度为 0 → 匹配所有
  if (prefixLen === 0) return true;

  const mask = (~0 << (32 - prefixLen)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

/**
 * 将 IPv4 点分十进制转换为 32 位无符号整数。
 * 返回 null 表示格式无效。
 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return null;
    num = ((num << 8) | octet) >>> 0;
  }
  return num;
}

/**
 * 构建 admin 分页响应。
 */
export function buildPaginatedResponse<T>(
  data: T[],
  totalCount: number,
  page: number,
  pageSize: number,
): AdminPaginatedResponse<T> {
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
