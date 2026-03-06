/**
 * @module api/middlewares
 * @description HTTP 外壳中间件集合 — 认证、全局错误边界、限流。
 *
 * 铁律 [shell-interfaces-constraints.md §3]:
 * - 所有修改/读取路由必须经过 Token 鉴权
 * - 核心层 Error 不得暴露 stack 给调用方
 * - 全局异常处理中间件，防止进程崩溃
 */

import type { Context, Next, ErrorHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { log } from "../utils/logger.js";
import type { ApiKeyManager } from "../services/api-key-manager.js";
import type { BanManager } from "../services/ban-manager.js";
import type { RateLimiter } from "../utils/rate-limiter.js";

/**
 * Timing-safe 字符串比较 — 防御 timing attack。
 * 如果长度不同，仍然执行固定时间比较以避免泄露长度信息。
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // 长度不同时，仍然执行 timingSafeEqual 以确保固定时间
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// =========================================================================
// Bearer Token Authentication — 双层鉴权 (Master Token + Managed API Key)
// =========================================================================

/**
 * 双层鉴权中间件配置。
 */
export interface BearerAuthConfig {
  /** 全局主 Token (HTTP_AUTH_TOKEN 环境变量) — 空串 = 开发模式跳过认证 */
  masterToken: string;
  /** API Key 管理器 — 用于 managed key 验证 */
  apiKeyManager: ApiKeyManager;
  /** Ban 管理器 — 用于 per-key ban 检查 */
  banManager: BanManager;
  /** 限流器 — 用于 per-key 限流 */
  rateLimiter: RateLimiter;
  /** 是否信任代理 */
  trustProxy: boolean;
}

/**
 * 创建双层 Bearer Token 认证中间件。
 *
 * 鉴权优先级:
 * 1. Master Token (HTTP_AUTH_TOKEN) — 直通 (无 per-key 限制)
 * 2. Managed API Key — validateKey → ban 检查 → per-key 限流 → recordUsage
 *
 * 如果 masterToken 为空字符串，跳过认证（开发模式）。
 * 成功认证后将 API Key 记录注入 Hono Context 的 `apiKeyRecord` 变量。
 */
export function bearerAuth(config: BearerAuthConfig) {
  const { masterToken, apiKeyManager, banManager, rateLimiter } = config;

  return async (c: Context, next: Next) => {
    // 空 masterToken = 开发模式，跳过认证
    if (!masterToken) {
      await next();
      return;
    }

    const authorization = c.req.header("Authorization");
    if (!authorization) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    // 健壮性: 处理 "Bearer" 无 token、多空格、scheme 不匹配等边界情况
    const spaceIdx = authorization.indexOf(" ");
    if (spaceIdx === -1) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    const scheme = authorization.slice(0, spaceIdx);
    const token = authorization.slice(spaceIdx + 1).trim();

    // RFC 7235 §2.1: auth scheme 是 case-insensitive
    if (scheme.toLowerCase() !== "bearer" || !token) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // Layer 1: Master Token — 直通 (跳过 per-key 限制)
    if (safeCompare(token, masterToken)) {
      c.set("authMode", "master");
      await next();
      return;
    }

    // Layer 2: Managed API Key
    const keyRecord = apiKeyManager.validateKey(token);
    if (!keyRecord) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // Per-key ban 检查
    const keyBanCheck = banManager.isKeyBanned(keyRecord.id);
    if (keyBanCheck.banned) {
      return c.json(
        {
          error: "Forbidden",
          reason: "API key is banned",
          ban_reason: keyBanCheck.reason,
          expires_at: keyBanCheck.expires_at,
        },
        403,
      );
    }

    // Per-key 限流
    try {
      rateLimiter.checkPerKeyRate(
        keyRecord.key_hash,
        keyRecord.rate_limit_per_minute,
      );
    } catch (err: unknown) {
      // P7-FIX: 仅捕获 rate-limit 异常，其他内部错误向上抛出由 globalErrorHandler 处理
      if (err instanceof Error && err.message.includes("Rate limit exceeded")) {
        return c.json({ error: "Too many requests for this key" }, 429);
      }
      throw err;
    }

    // 记录使用 (非阻塞)
    apiKeyManager.recordUsage(keyRecord.key_hash);

    // 注入 key 信息到 context
    c.set("authMode", "api_key");
    c.set("apiKeyRecord", keyRecord);

    await next();
  };
}

/**
 * @deprecated 兼容旧版签名 — 仅用 master token 鉴权（无 managed key 支持）。
 * 新代码应使用 bearerAuth(BearerAuthConfig)。
 */
export function bearerAuthSimple(authToken: string) {
  return async (c: Context, next: Next) => {
    // 空 token = 开发模式，跳过认证
    if (!authToken) {
      await next();
      return;
    }

    const authorization = c.req.header("Authorization");
    if (!authorization) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const spaceIdx = authorization.indexOf(" ");
    if (spaceIdx === -1) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    const scheme = authorization.slice(0, spaceIdx);
    const token = authorization.slice(spaceIdx + 1).trim();
    if (
      scheme.toLowerCase() !== "bearer" ||
      !token ||
      !safeCompare(token, authToken)
    ) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    await next();
  };
}

// =========================================================================
// Global Error Boundary (Hono onError handler)
// =========================================================================

/**
 * 全局异常处理器 — 用于 app.onError()，捕获核心层所有异常。
 * 严禁暴露 Error Stack [shell-interfaces-constraints.md §3.3]。
 */
export const globalErrorHandler: ErrorHandler = (err, c) => {
  const error = err instanceof Error ? err : new Error(String(err));
  log.error("Unhandled error in HTTP handler", {
    method: c.req.method,
    path: c.req.path,
    error: error.message,
  });

  // 区分常见错误类型
  if (error.message.includes("Rate limit exceeded")) {
    return c.json({ error: "Too many requests" }, 429);
  }

  // JSON 解析错误 → 400 Bad Request (而非 500)
  if (error instanceof SyntaxError || error.name === "SyntaxError") {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  return c.json({ error: "Internal server error" }, 500);
};

// =========================================================================
// Request Logger
// =========================================================================

/**
 * 请求日志中间件 — 记录每个 HTTP 请求的方法、路径、耗时。
 */
export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  await next();
  const elapsed = Date.now() - start;
  log.info("HTTP request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    elapsed_ms: elapsed,
  });
}

// =========================================================================
// Content-Type Validation
// =========================================================================

/**
 * POST/PUT/PATCH 请求必须携带 Content-Type: application/json。
 * 拒绝非 JSON 请求以防止解析异常。
 */
export async function validateJsonContentType(c: Context, next: Next) {
  const method = c.req.method;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const contentType = c.req.header("Content-Type");
    if (!contentType || !contentType.includes("application/json")) {
      return c.json({ error: "Content-Type must be application/json" }, 415);
    }
  }
  await next();
}

// =========================================================================
// TLS Enforcement (defense-in-depth) [ADR-SHELL-09]
// =========================================================================

/**
 * TLS 强制中间件工厂 — 当 REQUIRE_TLS + TRUST_PROXY 均启用时，
 * 验证反向代理已终结 TLS（通过 X-Forwarded-Proto: https）。
 *
 * 纵深防御第二道防线:
 * - 第一道：httpHost=127.0.0.1 物理隔绝公网直连
 * - 第二道：本中间件验证代理层确实使用了 HTTPS
 * - 第三道：HSTS 响应头防止浏览器协议降级
 *
 * 如果 trustProxy 或 requireTls 为 false，返回 no-op 中间件（零开销）。
 *
 * @returns Hono 中间件
 */
export function tlsEnforcement(trustProxy: boolean, requireTls: boolean) {
  // 未启用 → no-op (零开销)
  if (!trustProxy || !requireTls) {
    return async (_c: Context, next: Next) => {
      await next();
    };
  }

  return async (c: Context, next: Next) => {
    const forwardedProto = c.req.header("X-Forwarded-Proto");

    if (forwardedProto !== "https") {
      log.warn("TLS enforcement rejected non-HTTPS request", {
        path: c.req.path,
        forwardedProto: forwardedProto ?? "(missing)",
        remoteIp: c.req.header("X-Forwarded-For") ?? "unknown",
      });
      // RFC 7540 §9.1.1: 421 Misdirected Request — 语义最准确
      return c.json(
        { error: "HTTPS required. Plaintext HTTP is not allowed." },
        421,
      );
    }

    // HSTS: 告诉浏览器在 1 年内仅使用 HTTPS（包含子域名）
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );

    await next();
  };
}

// =========================================================================
// User Scope Middleware — 数据隔离 (Web UI)
// =========================================================================

/**
 * 用户数据作用域中间件工厂。
 *
 * 从 adminOrUserAuth 注入的 authUserId / authUserRole 读取用户身份，
 * 查询该用户关联的 API Key 前缀列表，
 * 将 `userKeyPrefixes` 注入 Hono Context 供下游路由做数据隔离过滤。
 *
 * admin 角色不受限制（不注入前缀 = 可见全部数据）。
 */
export function createUserScopeMiddleware(apiKeyManager: ApiKeyManager) {
  return async (c: Context, next: Next) => {
    const role = c.get("authUserRole" as never) as string | undefined;

    // admin 角色或 master token（无 userId）→ 全部可见
    if (role === "admin") {
      await next();
      return;
    }

    const userId = c.get("authUserId" as never) as number | undefined;
    if (userId != null) {
      // 查询该用户拥有的 API Key 前缀
      const keys = apiKeyManager.listKeysByUser(userId);
      const prefixes = keys.filter((k) => !k.revoked_at).map((k) => k.prefix);

      // 注入前缀列表供下游路由过滤
      c.set("userKeyPrefixes" as never, prefixes as never);
    }

    await next();
  };
}
