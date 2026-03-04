/**
 * @module mcp/remote-server
 * @description 远程代理模式 MCP Server (v0.6.0)。
 *
 * 当环境变量 EASY_MEMORY_TOKEN 被设置时，npm 包 (`easy-memory`) 运行为本地 stdio MCP Server，
 * 将所有工具调用通过 HTTP 转发到远程 easy-memory 服务器。
 *
 * 用户配置示例:
 * ```json
 * {
 *   "easy-memory": {
 *     "type": "stdio",
 *     "command": "npx",
 *     "args": ["-y", "easy-memory@latest"],
 *     "env": {
 *       "EASY_MEMORY_TOKEN": "em_xxx...",
 *       "EASY_MEMORY_URL": "https://memory.zhiz.chat"
 *     }
 *   }
 * }
 * ```
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SafeStdioTransport } from "../transport/SafeStdioTransport.js";
import { log } from "../utils/logger.js";
import { setupGracefulShutdown } from "../utils/shutdown.js";
import { z } from "zod/v4";

/**
 * 向远程 easy-memory API 发起 HTTP 请求。
 */
async function remoteCall(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // 30s 超时

  try {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(
        `Remote API error (${res.status}): ${errText.slice(0, 500)}`,
      );
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 创建远程代理模式的 MCP Server。
 *
 * 在本地运行 stdio MCP Server，将工具调用转发到远端 HTTP API。
 */
export async function createRemoteMcpServer(
  token: string,
  baseUrl: string,
): Promise<void> {
  const server = new McpServer({
    name: "easy-memory-remote",
    version: "0.6.0",
  });

  // ===== memory_save — 保存记忆 =====
  server.tool(
    "memory_save",
    "Save a piece of information to your long-term memory. Use this to remember facts, decisions, code patterns, user preferences, or any knowledge worth preserving across conversations.",
    {
      content: z
        .string()
        .describe(
          "The content to save. Be specific and include full context.",
        ),
      project: z
        .string()
        .optional()
        .describe(
          "Project or namespace to organize memories under.",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization and retrieval."),
      category: z
        .string()
        .optional()
        .describe("Category: decision, preference, fact, pattern, etc."),
      source: z
        .string()
        .optional()
        .describe("Where this information came from."),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe("Additional structured metadata."),
    },
    async (args) => {
      try {
        const result = await remoteCall(baseUrl, token, "POST", "/api/save", args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error saving memory: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ===== memory_search — 搜索记忆 =====
  server.tool(
    "memory_search",
    "Search your long-term memory for relevant information. Returns semantically similar memories ranked by relevance.",
    {
      query: z.string().describe("Natural language search query."),
      project: z.string().optional().describe("Filter by project."),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of results (default: 5)."),
      score_threshold: z
        .number()
        .optional()
        .describe("Minimum relevance score (0-1, default: 0.3)."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter by tags."),
      category: z
        .string()
        .optional()
        .describe("Filter by category."),
    },
    async (args) => {
      try {
        const result = await remoteCall(baseUrl, token, "POST", "/api/search", args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching memories: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ===== memory_forget — 遗忘/归档记忆 =====
  server.tool(
    "memory_forget",
    "Archive (soft-delete) a specific memory by its ID.",
    {
      memory_id: z.string().describe("The ID of the memory to forget."),
      project: z.string().optional().describe("Project the memory belongs to."),
    },
    async (args) => {
      try {
        const result = await remoteCall(baseUrl, token, "POST", "/api/forget", args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error forgetting memory: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ===== memory_status — 健康检查 =====
  server.tool(
    "memory_status",
    "Check the health and status of the memory service.",
    {},
    async () => {
      try {
        const result = await remoteCall(baseUrl, token, "GET", "/api/status");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 启动 stdio transport
  const transport = new SafeStdioTransport();
  setupGracefulShutdown(async () => {
    await server.close();
  });

  await server.connect(transport);
  log.info("Remote MCP server started (proxy mode)", {
    baseUrl: baseUrl.replace(/\/+$/, ""),
  });
}
