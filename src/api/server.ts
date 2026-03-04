/**
 * @module api/server
 * @description HTTP 外壳适配器 — Hono 路由、中间件、生命周期管理。
 *
 * 职责边界 [shell-interfaces-constraints.md §3]:
 * - 解析 HTTP 请求
 * - Token 鉴权
 * - Zod schema 校验（复用 types/schema.ts 中的 schema）
 * - 调用核心层 handler
 * - 格式化 HTTP 响应
 *
 * 铁律:
 * - 本模块不包含任何业务逻辑
 * - 所有多余字段被 Zod passthrough 静默保留（与 MCP 行为一致）
 * - 核心层异常在 errorBoundary 中被捕获，不暴露 stack
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { handleSave } from "../tools/save.js";
import { handleSearch } from "../tools/search.js";
import { handleForget } from "../tools/forget.js";
import { handleStatus } from "../tools/status.js";
import { setupGracefulShutdown } from "../utils/shutdown.js";
import { log } from "../utils/logger.js";
import { getClientIp } from "../utils/ip.js";
import type { AppContainer } from "../container.js";
import {
  bearerAuth,
  globalErrorHandler,
  requestLogger,
  validateJsonContentType,
  tlsEnforcement,
} from "./middlewares.js";
import {
  HttpSaveInputSchema,
  HttpSearchInputSchema,
  HttpForgetInputSchema,
} from "./schemas.js";
import { createAdminRoutes } from "./admin-routes.js";
import { createAuthRoutes } from "./auth-routes.js";
import { adminAuth } from "./admin-auth.js";
import type { AuditOperation, AuditOutcome } from "../types/audit-schema.js";

// =========================================================================
// Types
// =========================================================================

/** Hono 应用的环境变量绑定 — 包含鉴权注入的上下文变量 */
type Env = {
  Variables: {
    /** 鉴权模式: "master" | "api_key" */
    authMode?: string;
    /** Managed API Key 记录 (仅 authMode="api_key" 时存在) */
    apiKeyRecord?: import("../types/admin-schema.js").ApiKeyRecord;
  };
};

// =========================================================================
// Helpers — Path-to-Operation Mapping
// =========================================================================

/** HTTP 路径映射到审计操作名称 */
function mapPathToOperation(
  path: string,
  method: string,
): AuditOperation | string {
  if (path === "/api/save" && method === "POST") return "memory_save";
  if (path === "/api/search" && method === "POST") return "memory_search";
  if (path === "/api/forget" && method === "POST") return "memory_forget";
  if (path === "/api/status") return "memory_status";
  return `${method.toLowerCase()}:${path}`;
}

/** HTTP 状态码映射到审计结果 */
function mapStatusToOutcome(status: number): AuditOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "rejected";
  return "error";
}

// =========================================================================
// Route Registration
// =========================================================================

/**
 * 创建 Hono 应用并注册所有路由。
 */
function createApp(container: AppContainer): Hono<Env> {
  const app = new Hono<Env>();
  const { qdrant, embedding, rateLimiter, config } = container;

  const deps = {
    qdrant,
    embedding,
    bm25: container.bm25,
    defaultProject: config.defaultProject,
    rateLimiter,
  };

  // ===== 全局中间件 =====
  app.onError(globalErrorHandler);
  app.use("*", requestLogger);

  // TLS 强制: 纵深防御第二道防线 [ADR-SHELL-09]
  // /health 天然豁免（反向代理健康探针走内网 HTTP）
  app.use("/api/*", tlsEnforcement(config.trustProxy, config.requireTls));

  // Ban 检查: 所有 API 请求先检查 IP ban 状态 (fail-fast)
  app.use("/api/*", async (c, next) => {
    // Admin 路由跳过 ban 检查 (admin 不能 ban 自己)
    if (c.req.path.startsWith("/api/admin")) {
      await next();
      return;
    }
    // Auth 路由也受 ban 检查 — 被 ban 的 IP 完全禁止登录/刷新/注册
    // 登录接口另有独立限流 (10次/分钟/IP) 防滥用

    const clientIp = getClientIp(c, config.trustProxy);
    const ipCheck = container.banManager.isIpBanned(clientIp);
    if (ipCheck.banned) {
      return c.json(
        {
          error: "Forbidden",
          reason: "IP address is banned",
          ban_reason: ipCheck.reason,
          expires_at: ipCheck.expires_at,
        },
        403,
      );
    }

    await next();
  });

  // ===== Auth Routes — 登录公开，其他需 JWT =====
  const authRoutes = createAuthRoutes({
    authService: container.auth,
    adminToken: config.adminToken,
    audit: container.audit,
    analytics: container.analytics,
    trustProxy: config.trustProxy,
    secureCookies: config.requireTls,
  });
  app.route("/api/auth", authRoutes);

  // ===== Admin Routes — ADMIN_TOKEN + JWT admin 双路径认证 (C2 FIX) =====
  const adminRoutes = createAdminRoutes({
    analytics: container.analytics,
    audit: container.audit,
    apiKeyManager: container.apiKeyManager,
    banManager: container.banManager,
    runtimeConfig: container.runtimeConfig,
  });
  app.use("/api/admin/*", adminAuth(config.adminToken, container.auth));
  app.route("/api/admin", adminRoutes);

  // 鉴权: 除 /health 和 /api/admin/* 外所有路由需要 Bearer Token
  // 采用双层鉴权: Master Token (直通) 或 Managed API Key (含 per-key ban + rate limit)
  const authMiddleware = bearerAuth({
    masterToken: config.httpAuthToken,
    apiKeyManager: container.apiKeyManager,
    banManager: container.banManager,
    rateLimiter: rateLimiter,
    trustProxy: config.trustProxy,
  });

  app.use("/api/*", async (c, next) => {
    // Admin 路由已由 adminAuth 处理
    if (c.req.path.startsWith("/api/admin")) {
      await next();
      return;
    }
    // C5 FIX: Auth 路由有自己的 jwtAuth 中间件，跳过全局 bearerAuth
    if (c.req.path.startsWith("/api/auth")) {
      await next();
      return;
    }
    return authMiddleware(c, next);
  });

  // Content-Type 校验: POST 请求必须携带 application/json
  // B1 FIX: Auth 路由的 logout/refresh 是无 body 的 POST — 跳过 Content-Type 检查
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth")) {
      await next();
      return;
    }
    return validateJsonContentType(c, next);
  });

  // 限流: 全局限流仅对 Master Token 生效 (Managed Key 在 bearerAuth 内已做 per-key 限流)
  app.use("/api/*", async (c, next) => {
    // GET /api/status 为只读健康检查，跳过限流
    if (c.req.path === "/api/status" && c.req.method === "GET") {
      await next();
      return;
    }
    // Admin 路由跳过全局限流 (admin 有权不受限)
    if (c.req.path.startsWith("/api/admin")) {
      await next();
      return;
    }
    // Auth 路由有独立的登录限流 (auth-routes.ts)，跳过全局限流
    // 防止攻击者通过 flood /api/auth/login 耗尽全局配额阻塞其他用户的记忆操作
    if (c.req.path.startsWith("/api/auth")) {
      await next();
      return;
    }
    // Managed key 已在 bearerAuth 内完成 per-key 限流，此处仅对 master token 做全局兜底
    const authMode = c.get("authMode");
    if (authMode === "api_key") {
      // per-key 限流已在 bearerAuth 内执行
      await next();
      return;
    }
    try {
      rateLimiter.checkRate();
    } catch {
      return c.json({ error: "Too many requests" }, 429);
    }
    await next();
  });

  // ===== 审计中间件 — 记录所有 /api/* 请求到 AuditService + AnalyticsService =====
  app.use("/api/*", async (c, next) => {
    // Admin 路由有自己的审计机制 (admin-routes.ts 中的 recordAdminAction)
    if (c.req.path.startsWith("/api/admin")) {
      await next();
      return;
    }
    // Auth 路由有自己的审计机制 (auth-routes.ts 中的 recordAuthAudit)
    // 跳过全局审计防止双重记录
    if (c.req.path.startsWith("/api/auth")) {
      await next();
      return;
    }

    // ⚠️ 必须在 await next() 之前克隆请求体 — 路由 handler 消费后 body stream 不可重读
    let project = config.defaultProject;
    try {
      if (c.req.method === "POST") {
        const body = (await c.req.raw.clone().json()) as Record<
          string,
          unknown
        >;
        if (body?.project && typeof body.project === "string") {
          project = body.project;
        }
      } else if (c.req.method === "GET") {
        const qp = c.req.query("project");
        if (qp) project = qp;
      }
    } catch {
      // 解析失败时使用默认值
    }

    const start = Date.now();

    // P0-FIX: try/finally 确保异常路径也被审计 — 消除 500 错误审计盲区
    try {
      await next();
    } finally {
      const elapsed = Date.now() - start;

      // 采集鉴权信息
      const keyRecord = c.get("apiKeyRecord") as
        | import("../types/admin-schema.js").ApiKeyRecord
        | undefined;
      const keyPrefix = keyRecord
        ? keyRecord.key_hash.slice(0, 8)
        : c.get("authMode") === "master"
          ? "master"
          : "";

      try {
        const entry = container.audit.buildEntry({
          operation: mapPathToOperation(
            c.req.path,
            c.req.method,
          ) as AuditOperation,
          project,
          outcome: mapStatusToOutcome(c.res.status) as AuditOutcome,
          outcomeDetail: c.res.status >= 400 ? `HTTP ${c.res.status}` : "",
          elapsedMs: elapsed,
          httpMethod: c.req.method,
          httpPath: c.req.path,
          httpStatus: c.res.status,
          clientIp: getClientIp(c, config.trustProxy),
          keyPrefix,
          userAgent: c.req.header("User-Agent") ?? "",
        });

        // 双写: JSONL (热写入) + SQLite (冷分析)
        container.audit.record(entry);
        container.analytics.ingestEvent(entry);
      } catch (err) {
        // 审计记录失败不应影响请求响应（防御性）
        log.error("Audit recording failed", {
          error: err instanceof Error ? err.message : String(err),
          path: c.req.path,
        });
      }
    }
  });

  // ===== Health Check (无需鉴权) =====
  app.get("/health", (c) => {
    return c.json({ status: "ok", mode: "http" });
  });

  // ===== POST /api/save =====
  app.post("/api/save", async (c) => {
    const body = await c.req.json();
    const parsed = HttpSaveInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }
    const result = await handleSave(parsed.data, deps);
    return c.json(result);
  });

  // ===== POST /api/search =====
  app.post("/api/search", async (c) => {
    const body = await c.req.json();
    const parsed = HttpSearchInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }
    const result = await handleSearch(parsed.data, deps);
    return c.json(result);
  });

  // ===== POST /api/forget =====
  app.post("/api/forget", async (c) => {
    const body = await c.req.json();
    const parsed = HttpForgetInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }
    const result = await handleForget(parsed.data, deps);
    return c.json(result);
  });

  // ===== GET /api/status =====
  app.get("/api/status", async (c) => {
    const project = c.req.query("project");
    const result = await handleStatus(project ? { project } : {}, deps);
    return c.json(result);
  });

  // ===== Static File Serving — SPA (Web UI) =====
  // 尝试从 dist/web 目录提供静态文件，回退到 index.html (SPA 路由)
  app.get("*", async (c) => {
    const path = c.req.path;

    // API 路由不应到达这里
    if (path.startsWith("/api/")) {
      return c.json({ error: "Not found" }, 404);
    }

    try {
      const { readFile } = await import("node:fs/promises");
      const { join, extname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      // 计算 web 静态文件目录
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = join(__filename, "..");
      const webRoot = join(__dirname, "..", "web");

      // MIME 类型映射
      const mimeTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
      };

      // 安全: 防止目录穿越 (path 不能包含 ..)
      const safePath = path.replace(/\.\./g, "").replace(/\/+/g, "/");
      const filePath = safePath === "/" ? "/index.html" : safePath;
      const fullPath = join(webRoot, filePath);

      // 确保文件路径在 webRoot 内
      if (!fullPath.startsWith(webRoot)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      try {
        const content = await readFile(fullPath);
        const ext = extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || "application/octet-stream";

        // 静态资源缓存策略
        let cacheControl = "no-cache";
        if (ext === ".js" || ext === ".css" || ext === ".woff2") {
          // 带 hash 的资源可以长缓存
          if (filePath.includes(".") && /\.[a-f0-9]{8,}\./.test(filePath)) {
            cacheControl = "public, max-age=31536000, immutable";
          }
        }

        return new Response(content, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": cacheControl,
          },
        });
      } catch {
        // 文件不存在 → SPA 回退: 返回 index.html
        const indexPath = join(webRoot, "index.html");
        try {
          const indexContent = await readFile(indexPath);
          return new Response(indexContent, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        } catch {
          // index.html 也不存在 → Web UI 未构建
          return c.json(
            {
              error: "Web UI not available",
              detail: "Run 'pnpm build:web' to build the admin panel",
            },
            404,
          );
        }
      }
    } catch (err) {
      log.error("Static file serving error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
}

// =========================================================================
// HTTP Server Startup
// =========================================================================

/**
 * 启动 HTTP 外壳 — 创建 Hono App、绑定端口、设置优雅关闭。
 */
export async function startHttpShell(container: AppContainer): Promise<void> {
  const { config } = container;
  const app = createApp(container);

  // 启动前验证 Qdrant 连接
  await container.qdrant.ensureConnected();

  // ⏰ 安全警告: 无鉴权模式在 VPS 部署时极其危险
  if (!config.httpAuthToken) {
    log.warn(
      "\u26a0\ufe0f HTTP server started WITHOUT authentication! Set HTTP_AUTH_TOKEN for production.",
    );
  }

  // 🛡️ 拓扑安全校验 [ADR-SHELL-09]
  if (config.httpHost === "0.0.0.0" || config.httpHost === "::") {
    if (!config.requireTls) {
      log.warn(
        `\u26a0\ufe0f HTTP_HOST=${config.httpHost} binds to ALL interfaces (public network reachable). ` +
          "Consider setting REQUIRE_TLS=true + TRUST_PROXY=true with a reverse proxy (Caddy/Nginx) " +
          "to enforce TLS. See deploy/ for example configs.",
      );
    }
    if (!config.httpAuthToken) {
      log.warn(
        "\u26a0\ufe0f CRITICAL: HTTP_HOST binds to all interfaces AND no auth token set! " +
          "This exposes your API to the public internet without any protection.",
      );
    }
  }

  // 启动 HTTP 服务 — hostname 默认 127.0.0.1 (物理隔绝公网直连)
  const server = serve(
    {
      fetch: app.fetch,
      port: config.httpPort,
      hostname: config.httpHost,
    },
    (info: { port: number }) => {
      log.info("Easy Memory HTTP Server is running", {
        host: config.httpHost,
        port: info.port,
        mode: "http",
        authEnabled: !!config.httpAuthToken,
        trustProxy: config.trustProxy,
        requireTls: config.requireTls,
      });
    },
  );

  // P3-FIX: 缩短 keep-alive 超时，减少 shutdown 时的 drain 竞态窗口
  // 默认 Node.js keepAliveTimeout=5000, headersTimeout=60000
  // 将 keepAliveTimeout 设为 2s，headersTimeout 必须 > keepAliveTimeout
  if ("keepAliveTimeout" in server) {
    (server as { keepAliveTimeout: number }).keepAliveTimeout = 2000;
  }
  if ("headersTimeout" in server) {
    (server as { headersTimeout: number }).headersTimeout = 3000;
  }

  // 定期清理过期 refresh tokens — 每 6 小时执行 (防止表无限膨胀)
  const CLEANUP_INTERVAL_MS = 6 * 3600 * 1000; // 6 hours
  const cleanupTimer = setInterval(() => {
    try {
      const deleted = container.auth.cleanupExpiredRefreshTokens();
      if (deleted > 0) {
        log.info("Cleaned up expired refresh tokens", { deleted });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to cleanup expired refresh tokens", {
        error: error.message,
      });
    }
  }, CLEANUP_INTERVAL_MS);
  // 防止 timer 阻止进程退出
  cleanupTimer.unref();

  // 优雅关闭 — HTTP 模式: 不监听 stdin，先关 HTTP 再关服务
  setupGracefulShutdown(
    async () => {
      log.info("Shutting down HTTP server");
      clearInterval(cleanupTimer);
      // P8-FIX: 每个 close() 独立 try-catch，确保单个失败不阻塞后续服务关闭
      const shutdownErrors: Array<{ service: string; error: Error }> = [];

      try {
        await container.audit.close();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Failed to close audit service", { error: error.message });
        shutdownErrors.push({ service: "audit", error });
      }

      try {
        container.analytics.close();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Failed to close analytics service", {
          error: error.message,
        });
        shutdownErrors.push({ service: "analytics", error });
      }

      try {
        container.apiKeyManager.close();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Failed to close apiKeyManager", { error: error.message });
        shutdownErrors.push({ service: "apiKeyManager", error });
      }

      try {
        container.banManager.close();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Failed to close banManager", { error: error.message });
        shutdownErrors.push({ service: "banManager", error });
      }

      try {
        container.auth.close();
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Failed to close auth service", { error: error.message });
        shutdownErrors.push({ service: "auth", error });
      }

      if (shutdownErrors.length > 0) {
        log.warn("Shutdown completed with errors", {
          failedServices: shutdownErrors.map((e) => e.service),
        });
      }
    },
    {
      mode: "http",
      httpServer: server,
      closeables: [container.qdrant, container.embedding],
    },
  );
}

/**
 * 导出 createApp 用于测试。
 */
export { createApp };
