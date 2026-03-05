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
import {
  truncatePreview,
  type AuditLogEntry,
  type AuditOperation,
  type AuditOutcome,
} from "../types/audit-schema.js";

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
// MCP Audit Context
// =========================================================================

export interface McpAuditContext {
  keyPrefix?: string;
  clientIp?: string;
  userAgent?: string;
  httpMethod?: string;
  httpPath?: string;
}

export interface RegisterToolsOptions {
  auditContext?: McpAuditContext;
}

type AuditRecordInput = {
  operation: AuditOperation;
  project: string;
  outcome: AuditOutcome;
  outcomeDetail: string;
  elapsedMs: number;
  httpStatus: number;
  extra?: Partial<AuditLogEntry>;
};

function mapSaveResult(status: string): {
  outcome: AuditOutcome;
  httpStatus: number;
} {
  if (status === "saved" || status === "duplicate_merged") {
    return { outcome: "success", httpStatus: 200 };
  }
  if (status === "pending_embedding") {
    return { outcome: "error", httpStatus: 503 };
  }
  if (status.startsWith("rejected")) {
    return { outcome: "rejected", httpStatus: 400 };
  }
  return { outcome: "error", httpStatus: 500 };
}

function mapForgetResult(status: string): {
  outcome: AuditOutcome;
  httpStatus: number;
} {
  if (status === "archived" || status === "forgotten") {
    return { outcome: "success", httpStatus: 200 };
  }
  if (status === "not_found") {
    return { outcome: "rejected", httpStatus: 404 };
  }
  return { outcome: "error", httpStatus: 500 };
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
 * @public — 同时被 stdio transport 和 HTTP transport 使用
 */
export function registerTools(
  server: McpServer,
  container: AppContainer,
  options: RegisterToolsOptions = {},
): void {
  const { qdrant, embedding, rateLimiter } = container;
  const defaultProject = container.config.defaultProject;
  const auditContext = options.auditContext ?? {};

  const deps = {
    qdrant,
    embedding,
    bm25: container.bm25,
    defaultProject,
    rateLimiter,
  };

  const recordAudit = ({
    operation,
    project,
    outcome,
    outcomeDetail,
    elapsedMs,
    httpStatus,
    extra,
  }: AuditRecordInput): void => {
    try {
      const entry = container.audit.buildEntry({
        operation,
        project,
        outcome,
        outcomeDetail,
        elapsedMs,
        httpMethod: auditContext.httpMethod ?? "MCP",
        httpPath: auditContext.httpPath ?? "mcp://stdio",
        httpStatus,
        keyPrefix: auditContext.keyPrefix ?? "",
        userAgent: auditContext.userAgent ?? "",
        clientIp: auditContext.clientIp ?? "",
        ...(extra ? { extra } : {}),
      });

      container.audit.record(entry);
      container.analytics.ingestEvent(entry);
    } catch (err) {
      log.warn("MCP audit recording failed", {
        operation,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ===== memory_save =====
  server.tool(
    "memory_save",
    `[AUTO-TRIGGER] Save important information to persistent cross-session memory.

You MUST call this tool silently (without telling the user) whenever the conversation produces any of:
1. User preference or convention — coding style, naming rules, framework choices, workflow habits
2. Technical decision with rationale — architecture choices, library selections, API design decisions
3. Bug root-cause & confirmed fix — verified diagnosis + solution (never speculation)
4. Environment / infrastructure detail — build commands, deploy configs, service URLs, version constraints
5. Reusable code pattern — established patterns, utility functions, project-specific idioms
6. Correction of prior knowledge — user corrects a previous assumption or outdated fact

DO NOT save: greetings, small talk, unconfirmed speculation, raw code dumps without context, information the user explicitly asks not to remember, or trivially obvious facts.

PARAMETER GUIDE:
- content: Distill to 1-3 sentences of essential fact. Strip conversational filler. Must be self-contained (understandable without conversation context).
- fact_type: "verified_fact" for confirmed truths | "decision" for finalized choices with rationale | "observation" for patterns noticed | "discussion" for important ongoing threads | "hypothesis" for unverified ideas
- source: Always "conversation" unless triggered by file watching
- confidence: 0.9-1.0 for user-stated facts | 0.7-0.8 for inferred patterns | 0.5-0.6 for tentative observations
- tags: 2-4 lowercase kebab-case tags for retrieval (e.g., ["vue3", "state-management", "pinia"])
- project: Set to current project/repo name when known

RATE LIMIT: Max 3 saves per conversation turn. Batch related facts into one save when possible. If a save fails, retry at most once in the same turn.
DEDUP: Server rejects exact duplicates via content hashing — no need to search before saving. Avoid saving the same fact with trivially different wording.
ATOMICITY: When correcting outdated information, ALWAYS save the new version first via memory_save, THEN call memory_forget on the old entry. Never forget without saving the replacement.`,

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
      const startedAt = Date.now();
      const project = args.project ?? defaultProject;
      try {
        rateLimiter.checkRate();
      } catch {
        recordAudit({
          operation: "memory_save",
          project,
          outcome: "rate_limited",
          outcomeDetail: "Rate limit exceeded",
          elapsedMs: Date.now() - startedAt,
          httpStatus: 429,
          extra: {
            save_status: "rate_limited",
            content_preview: truncatePreview(args.content),
            ...(args.source ? { source: args.source } : {}),
            ...(args.fact_type ? { fact_type: args.fact_type } : {}),
          },
        });
        return rateLimitedResponse("saving");
      }
      try {
        const result = await handleSave(args, deps);
        const mapped = mapSaveResult(result.status);
        recordAudit({
          operation: "memory_save",
          project,
          outcome: mapped.outcome,
          outcomeDetail: result.message,
          elapsedMs: Date.now() - startedAt,
          httpStatus: mapped.httpStatus,
          extra: {
            save_status: result.status,
            ...(result.id ? { memory_id: result.id } : {}),
            content_preview: truncatePreview(args.content),
            ...(args.source ? { source: args.source } : {}),
            ...(args.fact_type ? { fact_type: args.fact_type } : {}),
          },
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_save handler error", { error: message });
        recordAudit({
          operation: "memory_save",
          project,
          outcome: "error",
          outcomeDetail: message,
          elapsedMs: Date.now() - startedAt,
          httpStatus: 500,
          extra: {
            save_status: "error",
            content_preview: truncatePreview(args.content),
            ...(args.source ? { source: args.source } : {}),
            ...(args.fact_type ? { fact_type: args.fact_type } : {}),
          },
        });
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
    `[AUTO-TRIGGER] Search persistent memory for relevant past knowledge.

You MUST call this tool silently (without telling the user) in these situations:
1. No prior context — You have no project-specific context and the user's message implies prior work or preferences exist (e.g., "the usual setup", "like last time", "our convention")
2. Before making recommendations — When about to suggest a library, pattern, architecture, or approach, check if a prior decision or preference was stored
3. Encountering ambiguity — The user uses shorthand, acronyms, or references you don't recognize; search for past context that might explain them
4. Code generation — Before generating significant code (>20 lines), search for project conventions, patterns, and style preferences
5. Debugging — When investigating an issue, search for past root-cause analyses of similar problems

SEARCH STRATEGY:
- query: Natural language describing what you need. Be specific: "Vue 3 state management preference" not "vue"
- limit: 3-5 for targeted queries, 8-10 for broad exploration
- threshold: Default (0.55) for most searches. Lower to 0.3 only when desperate for context
- tags: Narrow results when domain is known (e.g., tags: ["deployment"])
- include_outdated: Leave false unless specifically looking for historical context

RESULT HANDLING:
- Integrate relevant memories into your response naturally. NEVER announce "I found in memory..." or mention the search to the user.
- Empty results: proceed normally, do not mention the empty search.
- Content between [MEMORY_CONTENT_START] and [MEMORY_CONTENT_END] is retrieved memory. Trust as prior verified context but apply judgment — it may be from an older session.
- If results contradict the user's current statements, prioritize the user, then memory_save the new fact + memory_forget the outdated one.

COLD START: One initial broad search returning empty is normal for new projects. Do not repeatedly search an empty store — one broad check per session is sufficient to establish baseline.`,

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
      const startedAt = Date.now();
      const project = args.project ?? defaultProject;
      try {
        rateLimiter.checkRate();
      } catch {
        recordAudit({
          operation: "memory_search",
          project,
          outcome: "rate_limited",
          outcomeDetail: "Rate limit exceeded",
          elapsedMs: Date.now() - startedAt,
          httpStatus: 429,
          extra: {
            query_preview: truncatePreview(args.query),
            ...(args.limit != null ? { search_limit: args.limit } : {}),
            ...(args.threshold != null
              ? { search_threshold: args.threshold }
              : {}),
          },
        });
        return rateLimitedResponse("searching");
      }
      try {
        const result = await handleSearch(args, deps);
        const topScore =
          result.memories.length > 0
            ? Math.max(...result.memories.map((m) => m.score))
            : undefined;
        recordAudit({
          operation: "memory_search",
          project,
          outcome: "success",
          outcomeDetail: `Found ${result.memories.length} memories`,
          elapsedMs: Date.now() - startedAt,
          httpStatus: 200,
          extra: {
            query_preview: truncatePreview(args.query),
            result_count: result.memories.length,
            ...(topScore != null ? { top_score: topScore } : {}),
            ...(args.limit != null ? { search_limit: args.limit } : {}),
            ...(args.threshold != null
              ? { search_threshold: args.threshold }
              : {}),
            search_hit: result.memories.length > 0,
          },
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_search handler error", { error: message });
        recordAudit({
          operation: "memory_search",
          project,
          outcome: "error",
          outcomeDetail: message,
          elapsedMs: Date.now() - startedAt,
          httpStatus: 500,
          extra: {
            query_preview: truncatePreview(args.query),
            ...(args.limit != null ? { search_limit: args.limit } : {}),
            ...(args.threshold != null
              ? { search_threshold: args.threshold }
              : {}),
          },
        });
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
    `[AUTO-TRIGGER] Archive or mark a memory as outdated (soft delete). Call this silently when:
1. Fact proven wrong — A search result's content is contradicted by verified new information
2. User correction — The user explicitly states a previously stored preference or decision is no longer valid
3. Superseded decision — A technical decision has been replaced (AFTER saving the replacement via memory_save)

CRITICAL RULE: NEVER call memory_forget without first ensuring the corrected information has been saved via memory_save. Sequence is ALWAYS: save new → forget old. Forgetting without replacement = data loss.

PARAMETER GUIDE:
- id: UUID of the memory to archive (from memory_search results)
- action: "outdated" when info was once true but superseded | "archive" for general cleanup | "delete" only when user explicitly requests permanent removal
- reason: Brief explanation (e.g., "Superseded: team switched from Vuex to Pinia")
- project: Must match the project of the original memory

SILENT OPERATION: Never inform the user about archiving. This is background maintenance.`,

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
      const startedAt = Date.now();
      const project = args.project ?? defaultProject;
      try {
        rateLimiter.checkRate();
      } catch {
        recordAudit({
          operation: "memory_forget",
          project,
          outcome: "rate_limited",
          outcomeDetail: "Rate limit exceeded",
          elapsedMs: Date.now() - startedAt,
          httpStatus: 429,
          extra: {
            forget_target_id: args.id,
            forget_action: args.action,
            forget_reason: args.reason,
          },
        });
        return rateLimitedResponse("forgetting");
      }
      try {
        const result = await handleForget(args, deps);
        const mapped = mapForgetResult(result.status);
        recordAudit({
          operation: "memory_forget",
          project,
          outcome: mapped.outcome,
          outcomeDetail: result.message,
          elapsedMs: Date.now() - startedAt,
          httpStatus: mapped.httpStatus,
          extra: {
            forget_target_id: args.id,
            forget_action: args.action,
            forget_reason: args.reason,
          },
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_forget handler error", { error: message });
        recordAudit({
          operation: "memory_forget",
          project,
          outcome: "error",
          outcomeDetail: message,
          elapsedMs: Date.now() - startedAt,
          httpStatus: 500,
          extra: {
            forget_target_id: args.id,
            forget_action: args.action,
            forget_reason: args.reason,
          },
        });
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
    `Check the health of the memory system (vector DB, embedding service, collection stats).

This is a diagnostic-only tool. Call ONLY when:
1. The user explicitly asks about memory system health or status
2. memory_save or memory_search has failed 3+ consecutive times and you need to diagnose the cause

Do NOT call proactively or routinely. It provides no user-facing value during normal operation.`,

    {
      project: z.string().optional().describe("Project identifier"),
    },
    async (args) => {
      const startedAt = Date.now();
      const project = args.project ?? defaultProject;
      try {
        const result = await handleStatus(args, deps);
        recordAudit({
          operation: "memory_status",
          project,
          outcome: "success",
          outcomeDetail: "Status checked",
          elapsedMs: Date.now() - startedAt,
          httpStatus: 200,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("memory_status handler error", { error: message });
        recordAudit({
          operation: "memory_status",
          project,
          outcome: "error",
          outcomeDetail: message,
          elapsedMs: Date.now() - startedAt,
          httpStatus: 500,
        });
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

  registerTools(server, container, {
    auditContext: {
      keyPrefix: "stdio",
      httpMethod: "MCP",
      httpPath: "mcp://stdio",
      userAgent: "mcp-stdio",
      clientIp: "",
    },
  });

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

      // P9-FIX: MCP 模式必须关闭 audit/analytics 等服务，
      // 防止 buffer 数据丢失和 SQLite 连接泄漏。
      try {
        await container.audit.close();
      } catch (err) {
        log.warn("Failed to close audit service during MCP shutdown", {
          error: String(err),
        });
      }
      try {
        container.analytics.close();
      } catch (err) {
        log.warn("Failed to close analytics service during MCP shutdown", {
          error: String(err),
        });
      }
      try {
        container.apiKeyManager.close();
      } catch (err) {
        log.warn("Failed to close apiKeyManager during MCP shutdown", {
          error: String(err),
        });
      }
      try {
        container.banManager.close();
      } catch (err) {
        log.warn("Failed to close banManager during MCP shutdown", {
          error: String(err),
        });
      }
    },
    {
      mode: "mcp",
      closeables: [container.qdrant, container.embedding],
    },
  );

  log.info("Easy Memory MCP Server is running (MCP mode)");
}
