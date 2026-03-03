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

// =========================================================================
// Types
// =========================================================================

/** Hono 应用的环境变量绑定 */
type Env = {
  Variables: Record<string, never>;
};

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

  // 鉴权: 除 /health 外所有路由需要 Bearer Token
  app.use("/api/*", bearerAuth(config.httpAuthToken));

  // Content-Type 校验: POST 请求必须携带 application/json
  app.use("/api/*", validateJsonContentType);

  // 限流: 除 GET /api/status 外的所有 API 路由
  app.use("/api/*", async (c, next) => {
    // GET /api/status 为只读健康检查，跳过限流
    if (c.req.path === "/api/status" && c.req.method === "GET") {
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

  // 优雅关闭 — HTTP 模式: 不监听 stdin，先关 HTTP 再关服务
  setupGracefulShutdown(
    async () => {
      log.info("Shutting down HTTP server");
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
