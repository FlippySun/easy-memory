/**
 * @module api/auth-routes
 * @description Auth API 路由 — 登录、注册、用户管理。
 *
 * 路由:
 * - POST /api/auth/login — 登录 (公开)
 * - POST /api/auth/register — 注册 (需 admin JWT 或 ADMIN_TOKEN)
 * - GET  /api/auth/me — 当前用户信息 (需 JWT)
 * - GET  /api/auth/users — 用户列表 (需 admin)
 * - PATCH /api/auth/users/:id — 更新用户 (需 admin)
 * - DELETE /api/auth/users/:id — 删除用户 (需 admin)
 *
 * 安全修复:
 * - C1: ADMIN_TOKEN 使用 timing-safe 比较
 * - C3: 登录接口内置 IP 限流 (10 次/分钟)
 * - C4: 自我降级/停用防护 (后端强制)
 * - I1: 所有 auth 操作审计记录
 * - I3: JWT 用户存在性 + is_active 校验
 * - I5: Admin 自我停用防护
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { log } from "../utils/logger.js";
import type { AuthService } from "../services/auth.js";
import type { AuditService } from "../services/audit.js";
import type { AnalyticsService } from "../services/analytics.js";
import { getClientIp } from "../utils/ip.js";
import {
  LoginInputSchema,
  RegisterInputSchema,
  UpdateUserInputSchema,
  ROLE_PERMISSIONS,
} from "../types/auth-schema.js";
import type { JwtPayload, UserRole } from "../types/auth-schema.js";
import type {
  AuditOperation,
  AuditOutcome,
} from "../types/audit-schema.js";

// =========================================================================
// Types
// =========================================================================

type Env = {
  Variables: {
    jwtPayload?: JwtPayload;
  };
};

interface AuthRoutesConfig {
  authService: AuthService;
  adminToken: string;
  /** AuditService for auth operation logging (I1) */
  audit?: AuditService;
  /** AnalyticsService for event ingestion (I1) */
  analytics?: AnalyticsService;
  /** Whether to trust X-Forwarded-For header */
  trustProxy?: boolean;
}

// =========================================================================
// Timing-safe string comparison (C1 FIX)
// =========================================================================

/**
 * Timing-safe 字符串比较 (复用 admin-auth.ts 的模式)。
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// =========================================================================
// Login Rate Limiter (C3 FIX) — 内置 IP 限流
// =========================================================================

/** 登录限流桶 (per IP) */
const loginAttempts = new Map<string, number[]>();
const MAX_LOGIN_ATTEMPTS_PER_MIN = 10;
const ONE_MINUTE_MS = 60_000;
/** 定期清理计数器 */
let loginCleanupCounter = 0;

/**
 * 检查 IP 是否超出登录限制。
 * @returns true 如果应被限流
 */
function isLoginRateLimited(clientIp: string): boolean {
  const now = Date.now();
  let timestamps = loginAttempts.get(clientIp);
  if (!timestamps) {
    timestamps = [];
    loginAttempts.set(clientIp, timestamps);
  }

  // 过滤过期时间戳
  const filtered = timestamps.filter((t) => now - t < ONE_MINUTE_MS);
  loginAttempts.set(clientIp, filtered);

  if (filtered.length >= MAX_LOGIN_ATTEMPTS_PER_MIN) {
    return true;
  }

  filtered.push(now);

  // 定期清理不活跃 IP (防止 Map 无限增长)
  loginCleanupCounter++;
  if (loginCleanupCounter >= 50) {
    loginCleanupCounter = 0;
    for (const [ip, ts] of loginAttempts) {
      const active = ts.filter((t) => now - t < ONE_MINUTE_MS);
      if (active.length === 0) {
        loginAttempts.delete(ip);
      }
    }
  }

  return false;
}

// =========================================================================
// JWT Auth Middleware (for auth routes)
// =========================================================================

/**
 * JWT 认证中间件 — 从 Authorization header 提取并验证 JWT。
 * 同时支持 ADMIN_TOKEN (向后兼容，timing-safe 比较)。
 *
 * 安全修复:
 * - C1: ADMIN_TOKEN 使用 timing-safe 比较 (非 ===)
 * - I3: 验证 JWT 对应的用户仍然存在且活跃
 */
function jwtAuth(authService: AuthService, adminToken: string) {
  return async (c: Context, next: Next) => {
    // 安全防护: 未配置 ADMIN_TOKEN 时拒绝所有认证请求
    // 空 ADMIN_TOKEN 会导致可预测的 JWT 密钥 → 可伪造 token
    if (!adminToken) {
      return c.json(
        { error: "Authentication service not configured (ADMIN_TOKEN required)" },
        503,
      );
    }

    const authorization = c.req.header("Authorization");
    if (!authorization) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const spaceIdx = authorization.indexOf(" ");
    if (spaceIdx === -1) {
      return c.json({ error: "Invalid authorization format" }, 401);
    }

    const scheme = authorization.slice(0, spaceIdx);
    const token = authorization.slice(spaceIdx + 1).trim();

    if (scheme.toLowerCase() !== "bearer" || !token) {
      return c.json({ error: "Invalid authorization format" }, 401);
    }

    // 尝试 JWT 验证
    const payload = authService.verifyToken(token);
    if (payload) {
      // I3 FIX: 验证用户仍然存在且活跃 (防止已删除/停用用户的 JWT 继续使用)
      // ADMIN_TOKEN 虚拟用户 (sub=0) 跳过此检查
      if (payload.sub !== 0) {
        const user = authService.getUserById(payload.sub);
        if (!user || !user.is_active) {
          return c.json({ error: "User account has been deactivated or deleted" }, 401);
        }
      }
      c.set("jwtPayload", payload);
      await next();
      return;
    }

    // 回退: ADMIN_TOKEN — C1 FIX: 使用 timing-safe 比较 (非 ===)
    if (adminToken && safeCompare(token, adminToken)) {
      c.set("jwtPayload", {
        sub: 0,
        role: "admin" as UserRole,
        username: "admin_token",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      await next();
      return;
    }

    return c.json({ error: "Invalid or expired token" }, 401);
  };
}

/**
 * 要求 admin 角色的中间件。
 */
function requireAdmin() {
  return async (c: Context, next: Next) => {
    const payload = c.get("jwtPayload") as JwtPayload | undefined;
    if (!payload || payload.role !== "admin") {
      return c.json({ error: "Forbidden: admin role required" }, 403);
    }
    await next();
  };
}

// =========================================================================
// Route Factory
// =========================================================================

export function createAuthRoutes(config: AuthRoutesConfig): Hono<Env> {
  const { authService, adminToken, audit, analytics, trustProxy } = config;
  const app = new Hono<Env>();

  // ---- 内部: 审计记录辅助 ----
  function recordAuthAudit(
    c: Context,
    operation: AuditOperation | string,
    outcome: AuditOutcome,
    start: number,
    detail: string = "",
  ): void {
    if (!audit) return;
    try {
      const entry = audit.buildEntry({
        operation: operation as AuditOperation,
        project: "_auth",
        outcome,
        outcomeDetail: detail,
        elapsedMs: Date.now() - start,
        httpMethod: c.req.method,
        httpPath: c.req.path,
        httpStatus: outcome === "success" ? 200 : outcome === "unauthorized" ? 401 : outcome === "rejected" ? 400 : 500,
        clientIp: getClientIp(c, trustProxy),
        userAgent: c.req.header("User-Agent") ?? "",
        keyPrefix: "auth",
      });
      audit.record(entry);
      if (analytics) analytics.ingestEvent(entry);
    } catch {
      // 审计记录失败不影响请求 (防御性)
    }
  }

  // ===== POST /login — 公开，内置限流 (C3 FIX) =====
  app.post("/login", async (c) => {
    const start = Date.now();
    const clientIp = getClientIp(c, trustProxy);

    // C3 FIX: 登录限流 — 10 次/分钟/IP
    if (isLoginRateLimited(clientIp)) {
      recordAuthAudit(c, "auth_login_failed", "rate_limited", start, "Login rate limited");
      return c.json({ error: "Too many login attempts. Please try again later." }, 429);
    }

    const body = await c.req.json();
    const parsed = LoginInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const result = authService.login(
      parsed.data.username,
      parsed.data.password,
    );
    if (!result) {
      recordAuthAudit(c, "auth_login_failed", "unauthorized", start, "Invalid credentials");
      log.info("Failed login attempt", { username: parsed.data.username, ip: clientIp });
      // 故意模糊错误信息，防止用户名枚举
      return c.json({ error: "Invalid username or password" }, 401);
    }

    recordAuthAudit(c, "auth_login", "success", start);
    log.info("User logged in", { username: parsed.data.username });
    return c.json(result);
  });

  // ===== GET /me — 需要 JWT =====
  app.get("/me", jwtAuth(authService, adminToken), async (c) => {
    const payload = c.get("jwtPayload") as JwtPayload;

    // ADMIN_TOKEN 虚拟用户
    if (payload.sub === 0 && payload.username === "admin_token") {
      return c.json({
        user: {
          id: 0,
          username: "admin_token",
          role: "admin",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_login_at: null,
          is_active: true,
        },
        permissions: ROLE_PERMISSIONS.admin,
      });
    }

    const user = authService.getUserById(payload.sub);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json({
      user,
      permissions: authService.getPermissions(user.role),
    });
  });

  // ===== POST /register — 需要 admin =====
  app.post(
    "/register",
    jwtAuth(authService, adminToken),
    requireAdmin(),
    async (c) => {
      const start = Date.now();
      const body = await c.req.json();
      const parsed = RegisterInputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Validation failed", details: parsed.error.issues },
          400,
        );
      }

      const user = authService.register(
        parsed.data.username,
        parsed.data.password,
      );
      if (!user) {
        return c.json({ error: "Username already exists" }, 409);
      }

      const createdBy = (c.get("jwtPayload") as JwtPayload).username;
      recordAuthAudit(c, "auth_register", "success", start, `Created user: ${parsed.data.username}`);
      log.info("User registered", {
        username: parsed.data.username,
        createdBy,
      });
      return c.json({ user }, 201);
    },
  );

  // ===== GET /users — 需要 admin =====
  app.get(
    "/users",
    jwtAuth(authService, adminToken),
    requireAdmin(),
    async (c) => {
      const users = authService.listUsers();
      return c.json({ users, total: users.length });
    },
  );

  // ===== PATCH /users/:id — 需要 admin =====
  app.patch(
    "/users/:id",
    jwtAuth(authService, adminToken),
    requireAdmin(),
    async (c) => {
      const start = Date.now();
      const id = parseInt(c.req.param("id"), 10);
      if (isNaN(id)) {
        return c.json({ error: "Invalid user ID" }, 400);
      }

      const body = await c.req.json();
      const parsed = UpdateUserInputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Validation failed", details: parsed.error.issues },
          400,
        );
      }

      const payload = c.get("jwtPayload") as JwtPayload;

      // C4 FIX: 禁止自我降级 (后端强制，不依赖前端)
      if (payload.sub === id) {
        if (parsed.data.role !== undefined && parsed.data.role !== payload.role) {
          return c.json({ error: "Cannot change your own role" }, 400);
        }
        // I5 FIX: 禁止自我停用
        if (parsed.data.is_active === false) {
          return c.json({ error: "Cannot deactivate your own account" }, 400);
        }
      }

      const updateData: {
        role?: UserRole;
        is_active?: boolean;
        password?: string;
      } = {};
      if (parsed.data.role !== undefined) updateData.role = parsed.data.role;
      if (parsed.data.is_active !== undefined)
        updateData.is_active = parsed.data.is_active;
      if (parsed.data.password !== undefined)
        updateData.password = parsed.data.password;

      const result = authService.updateUser(id, updateData);

      // C4 FIX: 区分 "not found" 和 "last admin" 保护
      if (result === "last_admin") {
        return c.json(
          { error: "Cannot demote or deactivate the last admin user" },
          400,
        );
      }
      if (!result) {
        return c.json({ error: "User not found" }, 404);
      }

      recordAuthAudit(c, "auth_user_update", "success", start, `Updated user ${id}: ${Object.keys(parsed.data).join(", ")}`);
      log.info("User updated", {
        userId: id,
        updatedBy: payload.username,
        updates: Object.keys(parsed.data),
      });
      return c.json({ user: result });
    },
  );

  // ===== DELETE /users/:id — 需要 admin =====
  app.delete(
    "/users/:id",
    jwtAuth(authService, adminToken),
    requireAdmin(),
    async (c) => {
      const start = Date.now();
      const id = parseInt(c.req.param("id"), 10);
      if (isNaN(id)) {
        return c.json({ error: "Invalid user ID" }, 400);
      }

      // 不允许删除自己
      const payload = c.get("jwtPayload") as JwtPayload;
      if (payload.sub === id) {
        return c.json({ error: "Cannot delete yourself" }, 400);
      }

      const success = authService.deleteUser(id);
      if (!success) {
        return c.json(
          { error: "Cannot delete user (not found or last admin)" },
          400,
        );
      }

      recordAuthAudit(c, "auth_user_delete", "success", start, `Deleted user ${id}`);
      log.info("User deleted", {
        userId: id,
        deletedBy: payload.username,
      });
      return c.json({ success: true });
    },
  );

  return app;
}
