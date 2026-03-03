/**
 * @module mcp/server
 * @description MCP 外壳适配器 — 实例化 McpServer、注册 Tools、绑定 Transport。
 *
 * 职责边界 [shell-interfaces-constraints.md §4]:
 * - 解析 MCP 协议消息
 * - 在 Tool 调用层执行 shell 级限流（checkRate）
 * - 调用核心层 handler
 * - 将结果格式化为 MCP 响应
 *
 * 铁律: 本模块不包含任何业务逻辑，仅做协议适配。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SafeStdioTransport } from "../transport/SafeStdioTransport.js";
import { setupGracefulShutdown } from "../utils/shutdown.js";
import { log } from "../utils/logger.js";
import { handleSave } from "../tools/save.js";
import { handleSearch } from "../tools/search.js";
import { handleForget } from "../tools/forget.js";
import { handleStatus } from "../tools/status.js";
import type { AppContainer } from "../container.js";
import { z } from "zod/v4";

// =========================================================================
// Rate Limit Helper
// =========================================================================

/**
 * MCP shell 级限流 — 返回 rate_limited 响应而非抛异常。
 */
function rateLimitedResponse(action: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "rate_limited",
            message: `Too many requests. Please wait a moment before ${action}.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// =========================================================================
// Console Hijacking — 防止第三方库污染 stdout (§4.1)
// =========================================================================

/**
 * 劫持 console.log/info/debug/warn/error，全部重定向到 stderr。
 * MCP 协议依赖纯净的 stdout 作为 JSON-RPC 通道。
 * 任何向 stdout 的非协议输出都会导致客户端解析失败。
 */
function hijackConsole(): void {
  const redirect = (...args: unknown[]) => {
    try {
      const msg = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      process.stderr.write(`[console] ${msg}\n`);
    } catch {
      // 静默 — 绝不能因为日志输出而影响 stdout 纯净性
    }
  };
  const noop = () => {};

  console.log = redirect;
  console.info = redirect;
  console.warn = redirect;
  console.error = redirect;
  // debug 通常过于冗余，静默丢弃
  console.debug = noop;
}

// =========================================================================
// MCP Server Setup
// =========================================================================

/**
 * 注册所有 MCP Tools 到 McpServer 实例。
 */
function registerTools(server: McpServer, container: AppContainer): void {
  const { qdrant, embedding, rateLimiter } = container;
  const defaultProject = container.config.defaultProject;

  const deps = {
    qdrant,
    embedding,
    bm25: container.bm25,
    defaultProject,
    rateLimiter,
  };

  // ===== memory_save =====
  server.tool(
    "memory_save",
    "Save a memory to the vector store. Use this to persist important facts, decisions, code patterns, or any information worth remembering across sessions.",
    {
      content: z.string().min(1).describe("The content to save as a memory"),
      project: z
        .string()
        .optional()
        .describe("Project identifier (defaults to configured project)"),
      source: z
        .enum(["conversation", "file_watch", "manual"])
        .optional()
        .describe("How this memory was captured"),
      fact_type: z
        .enum([
          "verified_fact",
          "decision",
          "hypothesis",
          "discussion",
          "observation",
        ])
        .optional()
        .describe("Classification of the memory"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Confidence level (0-1)"),
      source_file: z
        .string()
        .optional()
        .describe("Source file path (POSIX format)"),
      source_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Line number in source file"),
      related_ids: z
        .array(z.string())
        .optional()
        .describe("Related memory IDs"),
    },
    async (args) => {
      try {
        rateLimiter.checkRate();
      } catch {
        return rateLimitedResponse("saving");
      }
      try {
        const result = await handleSave(args, deps);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_save handler error", { error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ===== memory_search =====
  server.tool(
    "memory_search",
    "Search for relevant memories using semantic similarity. Returns memories wrapped in boundary markers for prompt injection safety.",
    {
      query: z.string().min(1).describe("Search query text"),
      project: z.string().optional().describe("Project identifier"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum results (default: 5)"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum similarity score (default: 0.55)"),
      include_outdated: z
        .boolean()
        .optional()
        .describe("Include outdated memories"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
    },
    async (args) => {
      try {
        rateLimiter.checkRate();
      } catch {
        return rateLimitedResponse("searching");
      }
      try {
        const result = await handleSearch(args, deps);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_search handler error", { error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ===== memory_forget =====
  server.tool(
    "memory_forget",
    "Archive or mark a memory as outdated (soft delete). In Phase 1, 'delete' is downgraded to 'archive' for safety.",
    {
      id: z.string().uuid().describe("Memory UUID to forget"),
      action: z
        .enum(["archive", "outdated", "delete"])
        .describe("Forget action type"),
      reason: z.string().min(1).describe("Reason for forgetting"),
      project: z
        .string()
        .optional()
        .describe("Project identifier (defaults to configured project)"),
    },
    async (args) => {
      try {
        rateLimiter.checkRate();
      } catch {
        return rateLimitedResponse("forgetting");
      }
      try {
        const result = await handleForget(args, deps);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_forget handler error", { error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ===== memory_status =====
  server.tool(
    "memory_status",
    "Check the health status of the memory system (Qdrant, Embedding service, collection info).",
    {
      project: z.string().optional().describe("Project identifier"),
    },
    async (args) => {
      try {
        const result = await handleStatus(args, deps);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_status handler error", { error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * 启动 MCP 外壳 — 创建 Server、注册 Tools、绑定 Transport、设置优雅关闭。
 */
export async function startMcpShell(container: AppContainer): Promise<void> {
  // 🔒 §4.1: 在创建任何 MCP 组件前劫持 console，确保 stdout 纯净
  hijackConsole();

  const server = new McpServer({
    name: "easy-memory",
    version: "0.1.0",
  });

  registerTools(server, container);

  const transport = new SafeStdioTransport();

  // 启动前验证 Qdrant 连接
  await container.qdrant.ensureConnected();

  // 🔑 关键顺序: 必须先 connect(transport)，让 SDK 在 stdin 上注册 data 监听器，
  // 然后再调用 setupGracefulShutdown（它会 process.stdin.resume()）。
  // 如果顺序反过来，resume() 会让 stdin 提前进入 flowing 模式，
  // 导致 VS Code 发来的 initialize 消息在 data 监听器注册前被丢弃。
  await server.connect(transport);

  // 优雅关闭 — MCP 模式: 监听 stdin close/end 事件
  setupGracefulShutdown(
    async () => {
      log.info("Shutting down MCP server");
      await server.close();
    },
    {
      mode: "mcp",
      closeables: [container.qdrant, container.embedding],
    },
  );

  log.info("Easy Memory MCP Server is running (MCP mode)");
}
