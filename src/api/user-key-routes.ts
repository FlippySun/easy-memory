/**
 * @module api/user-key-routes
 * @description 用户自助 API Key 管理路由 (v0.6.0)。
 *
 * 路由:
 * - GET  /api/user/keys — 列出当前用户的 API Keys
 * - POST /api/user/keys — 创建新 API Key (每用户最多 2 个活跃 key)
 * - DELETE /api/user/keys/:id — 吊销当前用户的 API Key
 *
 * 认证: JWT httpOnly cookie (复用 auth-routes 的 jwtAuth 中间件)
 * 权限: keys:self
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { log } from "../utils/logger.js";
import type { AuthService } from "../services/auth.js";
import type { ApiKeyManager } from "../services/api-key-manager.js";
import { COOKIE_ACCESS_TOKEN, ROLE_PERMISSIONS } from "../types/auth-schema.js";
import type { JwtPayload, UserRole } from "../types/auth-schema.js";
import { z } from "zod/v4";

// =========================================================================
// Types
// =========================================================================

type Env = {
  Variables: {
    jwtPayload?: JwtPayload;
  };
};

/** 创建用户 Key 的输入 Schema */
const CreateUserKeySchema = z.object({
  /** Key 名称 (1-128 字符) */
  name: z.string().min(1).max(128),
});

interface UserKeyRoutesConfig {
  authService: AuthService;
  apiKeyManager: ApiKeyManager;
  adminToken: string;
}

// =========================================================================
// JWT Auth Middleware (复用逻辑)
// =========================================================================

/**
 * JWT 认证中间件 — 从 httpOnly cookie 或 Authorization header 提取 JWT。
 * 验证后将 JwtPayload 注入 context。
 */
function jwtAuth(
  authService: AuthService,
  adminToken: string,
): (c: Context<Env>, next: Next) => Promise<Response | void> {
  return async (c: Context<Env>, next: Next) => {
    if (!adminToken) {
      return c.json({ error: "Authentication service not configured" }, 503);
    }

    let token: string | undefined;

    // 1. httpOnly cookie (优先)
    const cookieHeader = c.req.header("Cookie");
    if (cookieHeader) {
      const match = cookieHeader.match(
        new RegExp(`(?:^|;\\s*)${COOKIE_ACCESS_TOKEN}=([^;]+)`),
      );
      if (match) token = match[1];
    }

    // 2. Authorization: Bearer <token> (fallback)
    if (!token) {
      const authHeader = c.req.header("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7);
      }
    }

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const payload = authService.verifyToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // 校验用户仍存在且活跃 (ADMIN_TOKEN 虚拟用户 sub=0 跳过)
    if (payload.sub !== 0) {
      const user = authService.getUserById(payload.sub);
      if (!user || !user.is_active) {
        return c.json({ error: "User account disabled or deleted" }, 403);
      }
    }

    c.set("jwtPayload", payload);
    return next();
  };
}

/**
 * 权限检查中间件 — 检查当前用户是否拥有 keys:self 权限。
 */
function requirePermission(permission: string) {
  return async (c: Context<Env>, next: Next) => {
    const payload = c.get("jwtPayload");
    if (!payload) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const role = payload.role as UserRole;
    const perms = ROLE_PERMISSIONS[role] ?? [];
    // admin 拥有所有权限
    if (role !== "admin" && !perms.includes(permission)) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    return next();
  };
}

// =========================================================================
// Route Factory
// =========================================================================

export function createUserKeyRoutes(config: UserKeyRoutesConfig) {
  const { authService, apiKeyManager, adminToken } = config;
  const app = new Hono<Env>();

  // 全局中间件: JWT 认证 + keys:self 权限
  app.use("/*", jwtAuth(authService, adminToken));
  app.use("/*", requirePermission("keys:self"));

  // ===== GET / — 列出当前用户的 API Keys =====
  app.get("/", (c) => {
    const payload = c.get("jwtPayload")!;
    const keys = apiKeyManager.listKeysByUser(payload.sub);

    return c.json({
      keys,
      total: keys.length,
      max_keys: 2,
    });
  });

  // ===== POST / — 创建新 API Key =====
  app.post("/", async (c) => {
    const payload = c.get("jwtPayload")!;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateUserKeySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    try {
      const result = apiKeyManager.createKeyForUser(
        {
          name: parsed.data.name,
          // 用户自助创建的 key 使用默认 scopes
        },
        payload.sub,
        payload.username,
        2, // 每用户最多 2 个活跃 key
      );

      log.info("User created API key", {
        userId: payload.sub,
        username: payload.username,
        keyId: result.id,
        keyPrefix: result.prefix,
      });

      return c.json(result, 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes("max:")) {
        return c.json({ error: err.message }, 409);
      }
      log.error("Failed to create user API key", {
        error: err instanceof Error ? err.message : String(err),
        userId: payload.sub,
      });
      return c.json({ error: "Failed to create API key" }, 500);
    }
  });

  // ===== DELETE /:id — 吊销 API Key =====
  app.delete("/:id", (c) => {
    const payload = c.get("jwtPayload")!;
    const keyId = c.req.param("id");

    const success = apiKeyManager.revokeKeyForUser(keyId, payload.sub);
    if (!success) {
      return c.json({ error: "Key not found or not owned by you" }, 404);
    }

    log.info("User revoked API key", {
      userId: payload.sub,
      username: payload.username,
      keyId,
    });

    return c.json({ success: true });
  });

  return app;
}
