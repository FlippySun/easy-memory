/**
 * @module forget
 * @description memory_forget MCP Tool Handler — 软删除（archive）+ 审计日志。
 *
 * 铁律 [CORE_SCHEMA §7 #10]: Phase 1 中 "delete" 操作降级为 "archive"
 * 铁律: forget 操作必须写审计日志（D1-5: JSONL 文件 + stderr）
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { QdrantService } from "../services/qdrant.js";
import { log } from "../utils/logger.js";
import {
  MemoryForgetInputSchema,
  type MemoryForgetOutput,
} from "../types/schema.js";

import * as z from "zod/v4";

/**
 * D1-5: 审计日志持久化路径。
 * 优先使用环境变量 AUDIT_LOG_PATH，否则写入 HOME 目录。
 */
const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH ??
  join(process.env.HOME ?? "/tmp", ".easy-memory-audit.jsonl");

/**
 * D1-5: 将审计条目写入 JSONL 文件（append-only）。
 * D-AUDIT: 使用异步 appendFile 避免阻塞事件循环（fire-and-forget）。
 * 失败时静默处理（已有 stderr 日志作为兜底）。
 * 竞态安全：JSONL 每条记录 < PIPE_BUF (4096B)，OS 保证原子写入。
 */
function writeAuditLog(entry: Record<string, unknown>): void {
  appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n").catch(() => {
    // JSONL 写入失败时静默处理 — stderr 日志已作为兜底
  });
}

export interface ForgetHandlerDeps {
  qdrant: QdrantService;
  defaultProject: string;
}

/**
 * memory_forget handler — 通过 setPayload 将 lifecycle 变更为 archived（软删除）。
 * Phase 1 中 "delete" 操作降级为 "archive"。
 */
export async function handleForget(
  rawInput: unknown,
  deps: ForgetHandlerDeps,
): Promise<MemoryForgetOutput> {
  // M2: safeParse 统一错误格式
  const parsed = MemoryForgetInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = z.prettifyError(parsed.error);
    log.warn("Forget input validation failed", { issues });
    return {
      status: "error",
      message: `Invalid input: ${issues}`,
    };
  }
  const input = parsed.data;
  const project = input.project ?? deps.defaultProject;

  // Phase 1: delete 降级为 archive
  const effectiveAction = input.action === "delete" ? "archive" : input.action;
  const newLifecycle = effectiveAction === "archive" ? "archived" : "outdated";

  try {
    const now = new Date().toISOString();

    await deps.qdrant.setPayload(project, input.id, {
      lifecycle: newLifecycle,
      updated_at: now,
      forget_reason: input.reason,
      forget_action: effectiveAction,
      forgotten_at: now,
    });

    // D1-5: 审计日志 — 同时写入 stderr 和 JSONL 文件
    const auditEntry = {
      type: "AUDIT:memory_forget",
      id: input.id,
      action: effectiveAction,
      original_action: input.action,
      reason: input.reason,
      project,
      timestamp: now,
    };
    log.info("AUDIT:memory_forget", auditEntry);
    writeAuditLog(auditEntry);

    return {
      status: effectiveAction === "archive" ? "archived" : "forgotten",
      message: `Memory ${input.id} has been ${effectiveAction === "archive" ? "archived" : "marked as outdated"}. Reason: ${input.reason}`,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("memory_forget failed", {
      id: input.id,
      error: error.message,
    });

    // D1-8: 区分错误类型 — "not_found" 仅用于 404,"error" 用于其他错误
    const isNotFound =
      error.message.includes("Not found") ||
      error.message.includes("not found") ||
      error.message.includes("404");
    return {
      status: isNotFound ? "not_found" : "error",
      message: `Failed to forget memory ${input.id}: ${error.message}`,
    };
  }
}
