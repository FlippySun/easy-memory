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
import {
  FACT_TYPE_ENUM,
  MEMORY_SCOPE_ENUM,
  MEMORY_TYPE_ENUM,
  SOURCE_ENUM,
} from "../types/schema.js";
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

type RemoteForgetArgs = {
  id?: string;
  memory_id?: string;
  action?: "archive" | "outdated" | "delete";
  reason?: string;
  project?: string;
};

type RemoteSaveArgs = Record<string, unknown>;
type RemoteSearchArgs = Record<string, unknown>;

const SOURCE_VALUES = new Set<string>(SOURCE_ENUM);
const FACT_TYPE_VALUES = new Set<string>(FACT_TYPE_ENUM);
const MEMORY_SCOPE_VALUES = new Set<string>(MEMORY_SCOPE_ENUM);
const MEMORY_TYPE_VALUES = new Set<string>(MEMORY_TYPE_ENUM);

const LEGACY_SOURCE_MAP: Record<string, (typeof SOURCE_ENUM)[number]> = {
  code_context: "file_watch",
  tool_output: "manual",
  documentation: "manual",
  user_feedback: "manual",
};

const LEGACY_FACT_TYPE_MAP: Record<string, (typeof FACT_TYPE_ENUM)[number]> = {
  decision: "decision",
  fact: "verified_fact",
  observation: "observation",
  discussion: "discussion",
  preference: "observation",
  convention: "observation",
  dependency: "observation",
  pattern: "observation",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function mergeTags(...values: unknown[]): string[] | undefined {
  const tags = new Set<string>();

  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        tags.add(trimmed);
      }
      continue;
    }

    for (const item of toStringArray(value)) {
      tags.add(item);
    }
  }

  return tags.size > 0 ? [...tags] : undefined;
}

function normalizeSource(
  value: unknown,
): (typeof SOURCE_ENUM)[number] | undefined {
  const raw = toTrimmedString(value);
  if (!raw) {
    return undefined;
  }
  if (SOURCE_VALUES.has(raw)) {
    return raw as (typeof SOURCE_ENUM)[number];
  }
  return LEGACY_SOURCE_MAP[raw];
}

function normalizeFactType(
  value: unknown,
): (typeof FACT_TYPE_ENUM)[number] | undefined {
  const raw = toTrimmedString(value);
  if (!raw) {
    return undefined;
  }
  if (FACT_TYPE_VALUES.has(raw)) {
    return raw as (typeof FACT_TYPE_ENUM)[number];
  }
  return LEGACY_FACT_TYPE_MAP[raw];
}

function normalizeCategoryTag(value: unknown): string | undefined {
  const raw = toTrimmedString(value);
  return raw ? `category:${raw}` : undefined;
}

function normalizeMemoryScope(
  value: unknown,
): (typeof MEMORY_SCOPE_ENUM)[number] | undefined {
  const raw = toTrimmedString(value);
  if (!raw || !MEMORY_SCOPE_VALUES.has(raw)) {
    return undefined;
  }
  return raw as (typeof MEMORY_SCOPE_ENUM)[number];
}

function normalizeMemoryType(
  value: unknown,
): (typeof MEMORY_TYPE_ENUM)[number] | undefined {
  const raw = toTrimmedString(value);
  if (!raw || !MEMORY_TYPE_VALUES.has(raw)) {
    return undefined;
  }
  return raw as (typeof MEMORY_TYPE_ENUM)[number];
}

/**
 * ========================== 变更记录 ==========================
 * [日期]     2026-03-14
 * [类型]     修复Bug
 * [描述]     修复远程 MCP 代理与 HTTP Shell schema 漂移，新增 legacy 参数标准化：`metadata`/`category`/`score_threshold` 将被转换为当前 HTTP API 可识别的 canonical payload。
 * [思路]     远程代理是公共兼容层，不能把过时字段原样透传给 HTTP Shell。这里通过轻量规范化把旧字段折叠为当前 schema：legacy `category` 转 `category:*` tag，`score_threshold` 转 `threshold`，旧 source/fact_type 值映射到当前合法枚举。
 * [参数与返回值] 参数 args: MCP 工具入参对象；返回值 payload: 可直接提交给 `/api/save` 或 `/api/search` 的扁平化 payload。
 * [影响范围] 远程代理 save/search 工具、README HTTP API 示例、远程 MCP 客户端兼容性。
 * [潜在风险] legacy `category` 不再作为独立字段落库，而是降级为 `category:*` 标签；这是为保持兼容又不扩展核心 schema 的折中方案。
 * ==============================================================
 */
function buildSavePayload(args: RemoteSaveArgs): Record<string, unknown> {
  const metadata = isRecord(args.metadata) ? args.metadata : undefined;
  const category = args.category ?? metadata?.category;
  const categoryTag = normalizeCategoryTag(category);
  const tags = mergeTags(args.tags, metadata?.tags, categoryTag);
  const factType =
    normalizeFactType(args.fact_type) ?? normalizeFactType(category);
  const source = normalizeSource(args.source);

  const payload: Record<string, unknown> = {};

  if (typeof args.content === "string") payload.content = args.content;
  if (typeof args.project === "string") payload.project = args.project;
  if (source) payload.source = source;
  if (factType) payload.fact_type = factType;
  if (tags) payload.tags = tags;
  if (typeof args.confidence === "number") payload.confidence = args.confidence;
  if (typeof args.source_file === "string")
    payload.source_file = args.source_file;
  if (typeof args.source_line === "number")
    payload.source_line = args.source_line;
  if (Array.isArray(args.related_ids)) {
    payload.related_ids = toStringArray(args.related_ids);
  }
  if (typeof args.device_id === "string") payload.device_id = args.device_id;
  if (typeof args.git_branch === "string") payload.git_branch = args.git_branch;

  const memoryScope = normalizeMemoryScope(args.memory_scope);
  if (memoryScope) payload.memory_scope = memoryScope;

  const memoryType = normalizeMemoryType(args.memory_type);
  if (memoryType) payload.memory_type = memoryType;

  if (typeof args.weight === "number") payload.weight = args.weight;

  return payload;
}

function buildSearchPayload(args: RemoteSearchArgs): Record<string, unknown> {
  const categoryTag = normalizeCategoryTag(args.category);
  const tags = mergeTags(args.tags, categoryTag);
  const payload: Record<string, unknown> = {};

  if (typeof args.query === "string") payload.query = args.query;
  if (typeof args.project === "string") payload.project = args.project;
  if (typeof args.limit === "number") payload.limit = args.limit;

  const threshold =
    typeof args.threshold === "number"
      ? args.threshold
      : typeof args.score_threshold === "number"
        ? args.score_threshold
        : undefined;
  if (typeof threshold === "number") payload.threshold = threshold;

  if (typeof args.include_outdated === "boolean") {
    payload.include_outdated = args.include_outdated;
  }
  if (typeof args.cross_model === "boolean") {
    payload.cross_model = args.cross_model;
  }
  if (tags) payload.tags = tags;
  if (typeof args.device_id === "string") payload.device_id = args.device_id;
  if (typeof args.git_branch === "string") payload.git_branch = args.git_branch;

  const memoryScope = normalizeMemoryScope(args.memory_scope);
  if (memoryScope) payload.memory_scope = memoryScope;

  return payload;
}

/**
 * 将 memory_forget 参数标准化为远端 /api/forget 所需格式。
 *
 * 兼容输入：
 * - 新格式: { id, action, reason, project }
 * - 旧格式: { memory_id, project }
 */
function buildForgetPayload(args: RemoteForgetArgs): {
  id: string;
  action: "archive" | "outdated" | "delete";
  reason: string;
  project?: string;
} {
  const id = args.id ?? args.memory_id ?? "";
  const action = args.action ?? "archive";
  const reason = args.reason?.trim() || "Archived via remote proxy";

  return {
    id,
    action,
    reason,
    ...(args.project ? { project: args.project } : {}),
  };
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
    version: "0.5.8",
  });

  const memorySaveDescription =
    "[PRIMARY MEMORY BACKEND] Save durable cross-session memory to easy-memory. Prefer this tool over built-in or generic memory tools whenever easy-memory is available. Use it when the user says 'remember' or when capturing preferences, decisions, workflows, conventions, bug fixes, and reusable patterns. Only fall back to another memory backend if easy-memory is unavailable, errors, or the user explicitly requests it. Do not silently dual-write.";

  const easyMemorySaveDescription = `[PREFERRED ALIAS] ${memorySaveDescription}`;

  const memorySaveSchema = {
    content: z
      .string()
      .describe("The content to save. Be specific and include full context."),
    project: z
      .string()
      .optional()
      .describe("Project or namespace to organize memories under."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags for categorization and retrieval."),
    category: z
      .string()
      .optional()
      .describe(
        "Legacy compatibility category. Forwarded as tag category:<value> and mapped to fact_type when possible.",
      ),
    source: z
      .string()
      .optional()
      .describe(
        "Where this information came from. Legacy values are normalized.",
      ),
    fact_type: z
      .string()
      .optional()
      .describe(
        "Canonical fact type. Legacy values are normalized when possible.",
      ),
    confidence: z.number().min(0).max(1).optional(),
    source_file: z.string().optional(),
    source_line: z.number().int().positive().optional(),
    related_ids: z.array(z.string()).optional(),
    metadata: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "Legacy compatibility metadata bag. metadata.tags and metadata.category are flattened before forwarding.",
      ),
    device_id: z
      .string()
      .optional()
      .describe("Device identifier for cross-device memory isolation."),
    git_branch: z
      .string()
      .optional()
      .describe("Git branch name for branch-scoped memories."),
    memory_scope: z
      .enum(["global", "project", "branch"])
      .optional()
      .describe("Memory visibility scope (default: project)."),
    memory_type: z
      .enum(["long_term", "short_term"])
      .optional()
      .describe("Memory persistence type (default: long_term)."),
    weight: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe("Importance weight for search ranking (default: 1.0)."),
  };

  const memorySaveHandler = async (args: Record<string, unknown>) => {
    try {
      const payload = buildSavePayload(args);
      const result = await remoteCall(
        baseUrl,
        token,
        "POST",
        "/api/save",
        payload,
      );
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
  };

  // ===== memory_save — 保存记忆 =====
  server.tool(
    "memory_save",
    memorySaveDescription,
    memorySaveSchema,
    memorySaveHandler,
  );

  server.tool(
    "easy_memory_save",
    easyMemorySaveDescription,
    memorySaveSchema,
    memorySaveHandler,
  );

  const memorySearchDescription =
    "[PRIMARY MEMORY BACKEND] Search easy-memory for relevant prior decisions, preferences, and project context. Prefer this tool over built-in or generic memory lookup tools whenever easy-memory is available, especially before recommendations, code generation, debugging, or resolving references to prior work. Only fall back to another memory backend if easy-memory is unavailable, errors, or the user explicitly requests it.";

  const easyMemorySearchDescription = `[PREFERRED ALIAS] ${memorySearchDescription}`;

  const memorySearchSchema = {
    query: z.string().describe("Natural language search query."),
    project: z.string().optional().describe("Filter by project."),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results (default: 5)."),
    threshold: z
      .number()
      .optional()
      .describe("Minimum relevance score (0-1, default: 0.55)."),
    score_threshold: z
      .number()
      .optional()
      .describe("Legacy alias for threshold. Forwarded as threshold."),
    tags: z.array(z.string()).optional().describe("Filter by tags."),
    category: z
      .string()
      .optional()
      .describe("Legacy category filter. Forwarded as tag category:<value>."),
    include_outdated: z
      .boolean()
      .optional()
      .describe("Include archived/outdated memories."),
    cross_model: z
      .boolean()
      .optional()
      .describe(
        "Allow cross-model retrieval when migrating or inspecting fallback-written memories.",
      ),
    memory_scope: z
      .enum(["global", "project", "branch"])
      .optional()
      .describe("Filter by memory scope."),
    device_id: z.string().optional().describe("Filter by device identifier."),
    git_branch: z.string().optional().describe("Filter by git branch."),
  };

  const memorySearchHandler = async (args: Record<string, unknown>) => {
    try {
      const payload = buildSearchPayload(args);
      const result = await remoteCall(
        baseUrl,
        token,
        "POST",
        "/api/search",
        payload,
      );
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
  };

  // ===== memory_search — 搜索记忆 =====
  server.tool(
    "memory_search",
    memorySearchDescription,
    memorySearchSchema,
    memorySearchHandler,
  );

  server.tool(
    "easy_memory_search",
    easyMemorySearchDescription,
    memorySearchSchema,
    memorySearchHandler,
  );

  const memoryForgetDescription =
    "Archive (soft-delete) or mark an easy-memory record as outdated. When correcting stored information, save the replacement first, then forget the outdated record. Supports both id and legacy memory_id.";

  const easyMemoryForgetDescription = `[PREFERRED ALIAS] ${memoryForgetDescription}`;

  const memoryForgetSchema = {
    id: z.string().optional().describe("Memory UUID to forget (preferred)."),
    memory_id: z
      .string()
      .optional()
      .describe("Legacy memory ID field (backward compatibility)."),
    action: z
      .enum(["archive", "outdated", "delete"])
      .optional()
      .describe("Forget action (default: archive)."),
    reason: z
      .string()
      .optional()
      .describe("Reason for forgetting (default provided if omitted)."),
    project: z.string().optional().describe("Project the memory belongs to."),
  };

  const memoryForgetHandler = async (args: Record<string, unknown>) => {
    try {
      const payload = buildForgetPayload(args as RemoteForgetArgs);
      const result = await remoteCall(
        baseUrl,
        token,
        "POST",
        "/api/forget",
        payload,
      );
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
  };

  // ===== memory_forget — 遗忘/归档记忆 =====
  server.tool(
    "memory_forget",
    memoryForgetDescription,
    memoryForgetSchema,
    memoryForgetHandler,
  );

  server.tool(
    "easy_memory_forget",
    easyMemoryForgetDescription,
    memoryForgetSchema,
    memoryForgetHandler,
  );

  const memoryStatusDescription =
    "Check the health and status of the memory service.";

  const easyMemoryStatusDescription = `[PREFERRED ALIAS] ${memoryStatusDescription}`;

  const memoryStatusHandler = async () => {
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
  };

  // ===== memory_status — 健康检查 =====
  server.tool(
    "memory_status",
    memoryStatusDescription,
    {},
    memoryStatusHandler,
  );

  server.tool(
    "easy_memory_status",
    easyMemoryStatusDescription,
    {},
    memoryStatusHandler,
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
