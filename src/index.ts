/**
 * @module index
 * @description Easy Memory MCP Server 入口 — 装配所有组件。
 *
 * 组件:
 * - McpServer (MCP SDK)
 * - SafeStdioTransport (Stage 1)
 * - GracefulShutdown (Stage 1)
 * - QdrantService (Stage 3)
 * - EmbeddingService (Stage 3)
 * - 4 个 MCP Tools (Stage 4)
 *
 * 铁律 [ADR: 补充十七]: 绝对禁止 console.log
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SafeStdioTransport } from "./transport/SafeStdioTransport.js";
import { setupGracefulShutdown } from "./utils/shutdown.js";
import { log } from "./utils/logger.js";
import { QdrantService } from "./services/qdrant.js";
import {
  EmbeddingService,
  OllamaEmbeddingProvider,
  GeminiEmbeddingProvider,
} from "./services/embedding.js";
import type { EmbeddingProvider } from "./services/embedding.js";
import { handleSave } from "./tools/save.js";
import { handleSearch } from "./tools/search.js";
import { handleForget } from "./tools/forget.js";
import { handleStatus } from "./tools/status.js";
import { RateLimiter } from "./utils/rate-limiter.js";
import { z } from "zod/v4";

// ===== 环境配置 =====
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "easy-memory-dev";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
/**
 * Embedding 引擎选择:
 * - "ollama": 仅使用本地 Ollama (默认)
 * - "gemini": 仅使用远端 Gemini
 * - "auto":   Gemini 优先，Ollama 自动降级
 */
const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? "ollama";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "nomic-embed-text";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-embedding-001";
const DEFAULT_PROJECT = process.env.DEFAULT_PROJECT ?? "default";

// ===== API 预算护城河配置 =====
// 防御 NaN: 非法环境变量(如 "abc")导致 parseInt 返回 NaN，
// 使 callTimestamps.length >= NaN 恒为 false → 限流静默失效。
function safeParseInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? String(fallback), 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

const RATE_LIMIT_PER_MINUTE = safeParseInt(
  process.env.RATE_LIMIT_PER_MINUTE,
  60,
);
const GEMINI_MAX_PER_HOUR = safeParseInt(
  process.env.GEMINI_MAX_PER_HOUR,
  200,
);
const GEMINI_MAX_PER_DAY = safeParseInt(
  process.env.GEMINI_MAX_PER_DAY,
  2000,
);

async function main(): Promise<void> {
  log.info("Easy Memory MCP Server starting", {
    qdrantUrl: QDRANT_URL,
    ollamaBaseUrl: OLLAMA_BASE_URL,
    embeddingProvider: EMBEDDING_PROVIDER,
    ollamaModel: OLLAMA_MODEL,
    geminiModel: GEMINI_MODEL,
    defaultProject: DEFAULT_PROJECT,
  });

  // ===== 构建 Embedding Provider 列表 =====
  const providers: EmbeddingProvider[] = [];

  const ollamaProvider = new OllamaEmbeddingProvider({
    baseUrl: OLLAMA_BASE_URL,
    model: OLLAMA_MODEL,
  });

  if (EMBEDDING_PROVIDER === "gemini" || EMBEDDING_PROVIDER === "auto") {
    if (!GEMINI_API_KEY) {
      log.error(
        `EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER}" requires GEMINI_API_KEY env var`,
      );
      process.exit(1);
    }
    const geminiProvider = new GeminiEmbeddingProvider({
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
    });

    if (EMBEDDING_PROVIDER === "auto") {
      // Auto: Gemini 优先，Ollama 自动降级
      providers.push(geminiProvider, ollamaProvider);
      log.info("Dual-engine mode: Gemini primary, Ollama fallback");
    } else {
      // Gemini-only
      providers.push(geminiProvider);
      log.info("Single-engine mode: Gemini only");
    }
  } else {
    // Ollama-only (default)
    providers.push(ollamaProvider);
    log.info("Single-engine mode: Ollama only");
  }

  // ===== 初始化外部服务 =====
  const qdrant = new QdrantService({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
  });

  // ===== API 预算护城河 =====
  const rateLimiter = new RateLimiter({
    maxCallsPerMinute: RATE_LIMIT_PER_MINUTE,
    geminiMaxCallsPerHour: GEMINI_MAX_PER_HOUR,
    geminiMaxCallsPerDay: GEMINI_MAX_PER_DAY,
  });

  const embedding = new EmbeddingService({
    providers,
    shouldUseProvider: (p) => {
      // Gemini 预算耗尽时自动降级到 Ollama
      if (p.name === "gemini" && rateLimiter.isGeminiCircuitOpen) {
        log.warn(
          "Gemini circuit breaker open — skipping, will fallback to local",
        );
        return false;
      }
      return true;
    },
    onSuccess: (result) => {
      // 记录 Gemini 调用以更新预算计数器
      if (result.provider === "gemini") {
        rateLimiter.recordGeminiCall();
      }
    },
  });

  const deps = {
    qdrant,
    embedding,
    defaultProject: DEFAULT_PROJECT,
    rateLimiter,
  };

  // ===== 初始化 MCP Server =====
  const server = new McpServer({
    name: "easy-memory",
    version: "0.1.0",
  });

  // ===== 注册 Tools =====

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
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "rate_limited",
                  message:
                    "Too many requests. Please wait a moment before saving.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const result = await handleSave(args, deps);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

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
        .describe("Minimum similarity score (default: 0.65)"),
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
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "rate_limited",
                  message:
                    "Too many requests. Please wait a moment before searching.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const result = await handleSearch(args, deps);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

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
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "rate_limited",
                  message:
                    "Too many requests. Please wait a moment before forgetting.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const result = await handleForget(args, deps);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    "memory_status",
    "Check the health status of the memory system (Qdrant, Embedding service, collection info).",
    {
      project: z.string().optional().describe("Project identifier"),
    },
    async (args) => {
      const result = await handleStatus(args, deps);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ===== 启动 Transport =====
  const transport = new SafeStdioTransport();

  // ===== 优雅关闭 (D2-6: 传入 closeables) =====
  setupGracefulShutdown(
    async () => {
      log.info("Shutting down MCP server");
      await server.close();
    },
    {
      closeables: [qdrant, embedding],
    },
  );

  // M1: 启动前验证 Qdrant 连接，快速暴露配置/连接故障
  await qdrant.ensureConnected();

  // ===== 连接并运行 =====
  await server.connect(transport);
  log.info("Easy Memory MCP Server is running");
}

// ===== 启动 =====
main().catch((err) => {
  log.error("Fatal error during startup", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
