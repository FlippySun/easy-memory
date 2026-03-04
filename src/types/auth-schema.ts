/**
 * @module types/auth-schema
 * @description Auth/RBAC 数据契约 — Zod 严格模式。
 *
 * 设计:
 * - 用户角色: admin (全权限), user (受限权限)
 * - 密码: scrypt 哈希，格式 salt:hash
 * - JWT: HMAC-SHA256，2小时过期
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { z } from "zod";

// =========================================================================
// Roles & Permissions
// =========================================================================

export const UserRole = z.enum(["admin", "user"]);
export type UserRole = z.infer<typeof UserRole>;

/**
 * 权限映射 — admin 拥有全部权限，user 仅限只读操作。
 * 可扩展: 通过新增 role + permission 实现细粒度控制。
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly string[]> = {
  admin: [
    // User management
    "users:list",
    "users:create",
    "users:update",
    "users:delete",
    // API Keys
    "keys:list",
    "keys:create",
    "keys:update",
    "keys:delete",
    // Bans
    "bans:list",
    "bans:create",
    "bans:delete",
    // Analytics
    "analytics:read",
    // Audit
    "audit:read",
    "audit:export",
    // Config
    "config:read",
    "config:update",
    "config:reset",
    // Actions
    "actions:aggregate",
    // Memory operations
    "memory:save",
    "memory:search",
    "memory:forget",
    "memory:status",
  ],
  user: [
    "analytics:read",
    "audit:read",
    "memory:save",
    "memory:search",
    "memory:forget",
    "memory:status",
  ],
} as const;

// =========================================================================
// User record (SQLite row)
// =========================================================================

export const UserRecordSchema = z.object({
  id: z.number(),
  username: z.string(),
  password_hash: z.string(),
  role: UserRole,
  created_at: z.string(),
  updated_at: z.string(),
  last_login_at: z.string().nullable(),
  is_active: z.number().transform((v) => v === 1),
});

export type UserRecord = z.infer<typeof UserRecordSchema>;

/** 安全的用户记录 — 剥离 password_hash */
export interface SafeUserRecord {
  id: number;
  username: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  is_active: boolean;
}

// =========================================================================
// Auth API Input Schemas
// =========================================================================

export const LoginInputSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(128),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const RegisterInputSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(64)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username can only contain letters, numbers, underscores and hyphens",
    ),
  password: z.string().min(6).max(128),
});
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

export const UpdateUserInputSchema = z.object({
  role: UserRole.optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(6).max(128).optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

// =========================================================================
// JWT Payload
// =========================================================================

export interface JwtPayload {
  sub: number; // user ID
  role: UserRole;
  username: string;
  iat: number; // issued at (seconds)
  exp: number; // expiry (seconds)
}

// =========================================================================
// Refresh Token
// =========================================================================

/** Refresh Token 数据库行 */
export interface RefreshTokenRecord {
  id: string; // UUID
  user_id: number;
  token_hash: string; // SHA-256 hash of raw token
  family_id: string; // Token family UUID (rotation tracking)
  expires_at: string; // ISO datetime
  created_at: string; // ISO datetime
  revoked_at: string | null; // ISO datetime (null = active)
  replaced_by: string | null; // ID of replacement token (rotation)
}

// =========================================================================
// Cookie & Token Expiry Constants
// =========================================================================

/** Access token cookie 名称 */
export const COOKIE_ACCESS_TOKEN = "em_access";
/** Refresh token cookie 名称 */
export const COOKIE_REFRESH_TOKEN = "em_refresh";
/** Access token 有效期 (秒) — 15 分钟 */
export const ACCESS_TOKEN_EXPIRY_SECONDS = 900;
/** Refresh token 有效期 (秒) — 7 天 */
export const REFRESH_TOKEN_EXPIRY_SECONDS = 604_800;
/** Refresh token 轮转宽限期 (秒) — 并发多标签页场景 */
export const REFRESH_TOKEN_REUSE_GRACE_SECONDS = 60;

// =========================================================================
// Auth API Response Types
// =========================================================================

export interface LoginResponse {
  user: SafeUserRecord;
  expires_in: number; // seconds (access token)
}

export interface AuthMeResponse {
  user: SafeUserRecord;
  permissions: readonly string[];
}
