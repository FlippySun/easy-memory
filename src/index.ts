/**
 * @module index
 * @description Easy Memory 入口 — 双壳架构路由。
 *
 * 根据 EASY_MEMORY_MODE 环境变量选择外壳：
 * - "mcp" (默认): MCP stdio 协议，供 AI Agent (Claude/Cursor) 直接调用
 * - "http": HTTP REST API，供 VPS 部署或远程客户端调用
 *
 * 职责:
 * 1. 解析环境变量为 AppConfig
 * 2. 创建 AppContainer (核心层单例)
 * 3. 按 mode 启动对应外壳
 *
 * 铁律 [ADR: 补充十七]: 绝对禁止 console.log
 */

import { parseAppConfig, createContainer } from "./container.js";
import { startMcpShell } from "./mcp/server.js";
import { startHttpShell } from "./api/server.js";
import { log } from "./utils/logger.js";

async function main(): Promise<void> {
  // ① 解析配置
  const config = parseAppConfig();

  log.info("Easy Memory starting", {
    mode: config.mode,
    qdrantUrl: config.qdrantUrl,
    ollamaBaseUrl: config.ollamaBaseUrl,
    embeddingProvider: config.embeddingProvider,
    ollamaModel: config.ollamaModel,
    geminiModel: config.geminiModel,
    defaultProject: config.defaultProject,
  });

  // ② 创建依赖容器 (核心层单例)
  const container = createContainer(config);

  // ③ 按模式启动外壳
  if (config.mode === "http") {
    await startHttpShell(container);
  } else {
    // stdio 是进程级 IPC，物理上不可能跨网络连接 [ADR-SHELL-10]
    log.info(
      "MCP mode: stdio is a LOCAL-ONLY transport (stdin/stdout IPC). " +
        "It CANNOT be accessed remotely. Use MODE=http for VPS deployment.",
    );
    await startMcpShell(container);
  }
}

// ===== 全局异常兜底 =====
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Node 20+ 默认行为是退出进程，这里确保有上下文日志
});

// ===== 启动 =====
main().catch((err) => {
  log.error("Fatal error during startup", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
