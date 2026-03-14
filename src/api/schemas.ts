/**
 * @module api/schemas
 * @description HTTP 外壳专用 Zod Schema — 纵深防御层。
 *
 * 核心层 Tool handler 内部已执行 safeParse。本模块在 Shell 边界
 * 提供额外的第一道验证，并使用 .strict() 剥离未知字段（防止
 * 攻击者注入服务端不可见的 payload 字段）。
 *
 * 来源: types/schema.ts 中的 Input Schema，重新导出为 .strict() 版本。
 * 铁律 [shell-interfaces-constraints.md §3.2]:
 * - HTTP Shell 必须在路由层执行 Schema 校验
 * - 多余字段必须被静默剥离（strip）或严格拒绝（strict）
 */

import { z } from "zod/v4";
import {
  SOURCE_ENUM,
  FACT_TYPE_ENUM,
  MEMORY_SCOPE_ENUM,
  MEMORY_TYPE_ENUM,
} from "../types/schema.js";

// =========================================================================
// HTTP Save Input — 剥离未知字段 (defense-in-depth)
// =========================================================================

export const HttpSaveInputSchema = z
  .object({
    // [2026-03-14][修复Bug] HTTP Shell 与核心 save schema 对齐：纯空白 content 在路由层直接 400，避免发现层/执行层语义漂移。
    content: z.string().trim().min(1),
    project: z.string().optional(),
    source: z.enum(SOURCE_ENUM).optional(),
    fact_type: z.enum(FACT_TYPE_ENUM).optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    source_file: z.string().optional(),
    source_line: z.number().int().positive().optional(),
    related_ids: z.array(z.string()).optional(),
    // v0.7.0: 记忆层级隔离 & 权重
    device_id: z.string().max(128).optional(),
    git_branch: z.string().max(256).optional(),
    memory_scope: z.enum(MEMORY_SCOPE_ENUM).optional(),
    memory_type: z.enum(MEMORY_TYPE_ENUM).optional(),
    weight: z.number().min(0).max(10).optional(),
  })
  .strip();

export type HttpSaveInput = z.infer<typeof HttpSaveInputSchema>;

// =========================================================================
// HTTP Search Input
// =========================================================================

export const HttpSearchInputSchema = z
  .object({
    query: z.string().min(1),
    project: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    threshold: z.number().min(0).max(1).optional(),
    include_outdated: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    // ========================== 变更记录 ==========================
    // [日期]     2026-03-14
    // [类型]     配置变更
    // [描述]     HTTP Shell 搜索 schema 暴露 cross_model，允许运维/客户端在迁移或 fallback 排查时显式放开同模型过滤。
    // [思路]     核心 `MemorySearchInputSchema` 已支持 cross_model，但 HTTP 壳层此前未透出该字段，导致真实 API 无法利用既有能力排查 mixed-model 可见性问题。
    // [影响范围] HTTP `/api/search` schema、README API 文档、远程 MCP 代理参数透传。
    // [潜在风险] 打开 cross_model 后相似度分数可能跨语义空间失真，因此保持可选且默认关闭。
    // ==============================================================
    cross_model: z.boolean().optional(),
    // v0.7.0: 层级过滤
    device_id: z.string().optional(),
    git_branch: z.string().optional(),
    memory_scope: z.enum(MEMORY_SCOPE_ENUM).optional(),
  })
  .strip();

export type HttpSearchInput = z.infer<typeof HttpSearchInputSchema>;

// =========================================================================
// HTTP Forget Input
// =========================================================================

export const HttpForgetInputSchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum(["archive", "outdated", "delete"]),
    reason: z.string().min(1),
    project: z.string().optional(),
  })
  .strip();

export type HttpForgetInput = z.infer<typeof HttpForgetInputSchema>;

// =========================================================================
// HTTP Status Input (query params)
// =========================================================================

export const HttpStatusInputSchema = z
  .object({
    project: z.string().optional(),
  })
  .strip();

export type HttpStatusInput = z.infer<typeof HttpStatusInputSchema>;
