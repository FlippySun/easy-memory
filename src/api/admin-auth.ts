/**
 * @module admin-auth
 * @description Admin 认证中间件 — 独立于用户 Token 的管理端认证层。
 *
 * 设计:
 * - ADMIN_TOKEN 环境变量: 独立于 HTTP_AUTH_TOKEN
 * - Admin 路由使用此中间件
 * - 用户路由使用原有的 bearerAuth (支持 master token + managed API keys)
 *
 * 安全考量:
 * - Timing-safe 比较防止侧信道攻击
 * - Admin token 为空 = admin 功能完全禁用 (返回 403，非跳过)
 * - 所有 admin 操作记录审计
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { log } from "../utils/logger.js";
import { getClientIp as getClientIpShared } from "../utils/ip.js";

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
 * @returns Hono 中间件
 *
 * 行为:
 * - adminToken 为空 → 403 Forbidden (admin 功能禁用)
 * - 无 Authorization 头 → 401
 * - Token 不匹配 → 401
 * - Token 匹配 → 放行
 */
export function adminAuth(adminToken: string) {
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

    if (
      scheme.toLowerCase() !== "bearer" ||
      !token ||
      !safeCompare(token, adminToken)
    ) {
      log.warn("Admin auth failed", {
        path: c.req.path,
        ip: getClientIpShared(c),
      });
      return c.json({ error: "Invalid admin credentials" }, 401);
    }

    await next();
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
