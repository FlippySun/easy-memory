/**
 * @module admin-auth
 * @description Admin 认证中间件 — 双路径认证 (ADMIN_TOKEN + JWT admin)。
 *
 * 设计:
 * - ADMIN_TOKEN 环境变量: 独立于 HTTP_AUTH_TOKEN (原有行为)
 * - JWT admin token: Web UI 用户登录后获取的 JWT (admin 角色)
 * - Admin 路由同时支持两种认证方式
 * - SEC-COOKIE: 优先从 httpOnly cookie 读取 JWT
 *
 * 安全考量:
 * - Timing-safe 比较防止侧信道攻击
 * - Admin token 为空 = admin 功能完全禁用 (返回 403，非跳过)
 * - JWT 验证复用 AuthService (签名 + 过期 + 角色检查)
 * - 所有 admin 操作记录审计
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { log } from "../utils/logger.js";
import { getClientIp as getClientIpShared } from "../utils/ip.js";
import type { AuthService } from "../services/auth.js";
import { COOKIE_ACCESS_TOKEN, ROLE_PERMISSIONS } from "../types/auth-schema.js";

/**
 * 从请求中解析指定 cookie 值。
 */
function parseCookie(c: Context, name: string): string | undefined {
  const header = c.req.header("Cookie");
  if (!header) return undefined;

  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * Timing-safe 字符串比较。
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

/**
 * 创建 Admin Token 认证中间件。
 *
 * @param adminToken - ADMIN_TOKEN 环境变量值
 * @param authService - 可选的 AuthService，用于 JWT 认证回退
 * @returns Hono 中间件
 *
 * 行为:
 * - adminToken 为空 → 403 Forbidden (admin 功能禁用)
 * - SEC-COOKIE: 优先从 httpOnly cookie 读取 JWT
 * - Token 匹配 ADMIN_TOKEN → 放行
 * - Token 为有效 JWT 且角色为 admin → 放行
 * - 其他 → 401
 */
export function adminAuth(adminToken: string, authService?: AuthService) {
  return async (c: Context, next: Next) => {
    // Admin 功能未配置 → 403 (非 401，因为不是认证问题而是功能禁用)
    if (!adminToken) {
      return c.json(
        {
          error: "Admin API is not configured",
          detail:
            "Set ADMIN_TOKEN environment variable to enable admin functionality",
        },
        403,
      );
    }

    // SEC-COOKIE: 优先从 httpOnly Cookie 读取 JWT
    const cookieToken = parseCookie(c, COOKIE_ACCESS_TOKEN);

    // 回退: 从 Authorization header 读取
    let headerToken: string | undefined;
    const authorization = c.req.header("Authorization");
    if (authorization) {
      const spaceIdx = authorization.indexOf(" ");
      if (spaceIdx !== -1) {
        const scheme = authorization.slice(0, spaceIdx);
        const t = authorization.slice(spaceIdx + 1).trim();
        if (scheme.toLowerCase() === "bearer" && t) {
          headerToken = t;
        }
      }
    }

    // 如果两者都不存在
    if (!cookieToken && !headerToken) {
      return c.json({ error: "Missing authentication credentials" }, 401);
    }

    // 尝试认证 — Cookie 路径 (JWT only, ADMIN_TOKEN 不通过 cookie 传递)
    if (cookieToken && authService) {
      const payload = authService.verifyToken(cookieToken);
      if (payload) {
        const user = authService.getUserById(payload.sub);
        if (user && user.is_active && user.role === "admin") {
          await next();
          return;
        }
      }
    }

    // 尝试认证 — Authorization header 路径
    if (headerToken) {
      // Path 1: ADMIN_TOKEN — timing-safe 比较
      if (safeCompare(headerToken, adminToken)) {
        await next();
        return;
      }

      // Path 2: JWT — 验证签名 + 过期 + admin 角色 (C2 FIX)
      if (authService) {
        const payload = authService.verifyToken(headerToken);
        if (payload) {
          const user = authService.getUserById(payload.sub);
          if (user && user.is_active && user.role === "admin") {
            await next();
            return;
          }
        }
      }
    }

    log.warn("Admin auth failed", {
      path: c.req.path,
      ip: getClientIpShared(c),
    });
    return c.json({ error: "Invalid admin credentials" }, 401);
  };
}

/**
 * 从请求中提取 admin key prefix (认证后调用)。
 * Admin token 没有 prefix 概念，固定返回 "admin"。
 */
export function getAdminKeyPrefix(c: Context): string {
  const authorization = c.req.header("Authorization");
  if (!authorization) return "admin";
  const token = authorization.slice(authorization.indexOf(" ") + 1).trim();
  return token ? token.slice(0, 8) : "admin";
}

/**
 * 从请求中提取客户端 IP。
 *
 * @deprecated 导入 `../utils/ip.js` 的 `getClientIp` 替代本函数。
 * 此处保留为向后兼容的委托，admin-routes.ts 已有大量调用。
 */
export function getClientIp(c: Context): string {
  return getClientIpShared(c);
}

/**
 * 创建 Admin-or-User 认证中间件 — 允许 admin 角色或拥有指定权限的 user 角色通过。
 *
 * 用于 Analytics / Audit / Memory Browser 等面板,
 * admin 全权通过, user 需要指定权限 (analytics:read, audit:read, memories:browse)。
 *
 * @param adminToken - ADMIN_TOKEN 环境变量值
 * @param authService - AuthService 用于 JWT 验证
 * @param requiredPermission - 所需权限 (user 角色时检查)
 */
export function adminOrUserAuth(
  adminToken: string,
  authService: AuthService,
  requiredPermission: string,
) {
  return async (c: Context, next: Next) => {
    // Admin 功能未配置 → 403
    if (!adminToken) {
      return c.json(
        {
          error: "Admin API is not configured",
          detail:
            "Set ADMIN_TOKEN environment variable to enable admin functionality",
        },
        403,
      );
    }

    // SEC-COOKIE: 优先从 httpOnly Cookie 读取 JWT
    const cookieToken = parseCookie(c, COOKIE_ACCESS_TOKEN);

    // 回退: 从 Authorization header 读取
    let headerToken: string | undefined;
    const authorization = c.req.header("Authorization");
    if (authorization) {
      const spaceIdx = authorization.indexOf(" ");
      if (spaceIdx !== -1) {
        const scheme = authorization.slice(0, spaceIdx);
        const t = authorization.slice(spaceIdx + 1).trim();
        if (scheme.toLowerCase() === "bearer" && t) {
          headerToken = t;
        }
      }
    }

    if (!cookieToken && !headerToken) {
      return c.json({ error: "Missing authentication credentials" }, 401);
    }

    // 尝试 Cookie JWT 路径
    if (cookieToken) {
      const payload = authService.verifyToken(cookieToken);
      if (payload) {
        const user = authService.getUserById(payload.sub);
        if (user && user.is_active) {
          // 注入用户上下文供下游中间件使用
          c.set("authUserId" as never, payload.sub as never);
          c.set("authUserRole" as never, user.role as never);
          // admin 全权通过
          if (user.role === "admin") {
            await next();
            return;
          }
          // user 角色需检查权限
          const permissions =
            ROLE_PERMISSIONS[user.role as keyof typeof ROLE_PERMISSIONS];
          if (
            permissions &&
            (permissions as readonly string[]).includes(requiredPermission)
          ) {
            await next();
            return;
          }
        }
      }
    }

    // 尝试 Authorization header 路径
    if (headerToken) {
      // Path 1: ADMIN_TOKEN — timing-safe 比较
      if (safeCompare(headerToken, adminToken)) {
        c.set("authUserRole" as never, "admin" as never);
        await next();
        return;
      }

      // Path 2: JWT — 验证签名 + 过期 + 角色/权限
      const payload = authService.verifyToken(headerToken);
      if (payload) {
        const user = authService.getUserById(payload.sub);
        if (user && user.is_active) {
          // 注入用户上下文供下游中间件使用
          c.set("authUserId" as never, payload.sub as never);
          c.set("authUserRole" as never, user.role as never);
          if (user.role === "admin") {
            await next();
            return;
          }
          const permissions =
            ROLE_PERMISSIONS[user.role as keyof typeof ROLE_PERMISSIONS];
          if (
            permissions &&
            (permissions as readonly string[]).includes(requiredPermission)
          ) {
            await next();
            return;
          }
        }
      }
    }

    log.warn("Admin/User auth failed", {
      path: c.req.path,
      ip: getClientIpShared(c),
      requiredPermission,
    });
    return c.json({ error: "Insufficient permissions" }, 403);
  };
}
