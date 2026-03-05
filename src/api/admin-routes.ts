/**
 * @module api/admin-routes
 * @description 管理端 API 路由 — API Key 管理 + Ban 管理 + 审计日志 + 分析面板 + 运行时配置。
 *
 * 所有端点挂载在 /api/admin/* 下，使用独立的 ADMIN_TOKEN 认证。
 * 支持 JSON 和 CSV 导出。
 *
 * 路由结构:
 * - /api/admin/health              — 健康检查
 * - /api/admin/keys/*              — API Key CRUD
 * - /api/admin/bans/*              — Ban 管理
 * - /api/admin/analytics/*         — 使用分析
 * - /api/admin/audit/*             — 审计日志查询
 * - /api/admin/config              — 运行时配置
 * - /api/admin/actions             — Admin 操作审计追踪
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { Hono } from "hono";
import type { AnalyticsService } from "../services/analytics.js";
import type { AuditService } from "../services/audit.js";
import type { ApiKeyManager } from "../services/api-key-manager.js";
import type { BanManager } from "../services/ban-manager.js";
import type { RuntimeConfigManager } from "../services/runtime-config.js";
import {
  AuditQuerySchema,
  AnalyticsQuerySchema,
  TimeRangeQuerySchema,
} from "../types/audit-schema.js";
import {
  CreateApiKeySchema,
  UpdateApiKeySchema,
  ListApiKeysQuerySchema,
  CreateBanSchema,
  ListBansQuerySchema,
  UpdateRuntimeConfigSchema,
} from "../types/admin-schema.js";
import { getAdminKeyPrefix, getClientIp } from "./admin-auth.js";

// =========================================================================
// Types
// =========================================================================

type Env = {
  Variables: Record<string, never>;
};

/** Admin 路由依赖 */
export interface AdminRouteDeps {
  analytics: AnalyticsService;
  audit: AuditService;
  apiKeyManager: ApiKeyManager;
  banManager: BanManager;
  runtimeConfig: RuntimeConfigManager;
}

// =========================================================================
// Helper — 从 query string 提取参数
// =========================================================================

function extractQueryParams(
  c: { req: { query: (key: string) => string | undefined } },
  keys: string[],
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of keys) {
    const val = c.req.query(key);
    if (val !== undefined) raw[key] = val;
  }
  return raw;
}

// =========================================================================
// Admin Router Factory
// =========================================================================

/**
 * 创建管理端 API 路由。
 *
 * @param deps - Admin 路由所需的全部依赖
 */
export function createAdminRoutes(deps: AdminRouteDeps): Hono<Env> {
  const { analytics, audit, apiKeyManager, banManager, runtimeConfig } = deps;
  const admin = new Hono<Env>();

  // =====================================================================
  // Health Check
  // =====================================================================

  admin.get("/health", (c) => {
    return c.json({
      status: "ok",
      analytics_ready: analytics.isReady,
      audit_stats: audit.getStats(),
      uptime_ms: process.uptime() * 1000,
    });
  });

  // =====================================================================
  // API Key Management — /api/admin/keys/*
  // =====================================================================

  // POST /api/admin/keys — 创建新 API Key
  admin.post("/keys", async (c) => {
    const body = await c.req.json();
    const parsed = CreateApiKeySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const result = apiKeyManager.createKey(parsed.data, adminPrefix);

    // 审计 admin 操作
    apiKeyManager.recordAdminAction(
      "key_create",
      "api_key",
      result.id,
      adminPrefix,
      clientIp,
      { name: parsed.data.name },
    );

    return c.json(result, 201);
  });

  // GET /api/admin/keys — 列出所有 API Keys
  admin.get("/keys", (c) => {
    const rawQuery = extractQueryParams(c, [
      "name",
      "status",
      "sort_by",
      "sort_order",
      "page",
      "page_size",
    ]);

    const parsed = ListApiKeysQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.issues },
        400,
      );
    }

    const result = apiKeyManager.listKeys(parsed.data);
    return c.json(result);
  });

  // GET /api/admin/keys/:id — 获取特定 Key 详情
  admin.get("/keys/:id", (c) => {
    const id = c.req.param("id");
    const key = apiKeyManager.getKeyById(id);
    if (!key) {
      return c.json({ error: "API key not found" }, 404);
    }
    return c.json(key);
  });

  // PATCH /api/admin/keys/:id — 更新 Key
  admin.patch("/keys/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = UpdateApiKeySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const result = apiKeyManager.updateKey(id, parsed.data);
    if (!result) {
      return c.json({ error: "API key not found" }, 404);
    }

    apiKeyManager.recordAdminAction(
      "key_update",
      "api_key",
      id,
      adminPrefix,
      clientIp,
      { changes: Object.keys(parsed.data) },
    );

    return c.json(result);
  });

  // DELETE /api/admin/keys/:id — 两段式删除（假删 -> 半真删）
  admin.delete("/keys/:id", (c) => {
    const id = c.req.param("id");
    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const result = apiKeyManager.revokeKey(id);
    if (!result) {
      return c.json({ error: "API key not found" }, 404);
    }

    const deletionStage = result.semi_deleted_at
      ? "semi_deleted"
      : "soft_deleted";

    apiKeyManager.recordAdminAction(
      deletionStage === "semi_deleted" ? "key_semi_delete" : "key_soft_delete",
      "api_key",
      id,
      adminPrefix,
      clientIp,
      { deletion_stage: deletionStage },
    );

    return c.json({ key: result, deletion_stage: deletionStage });
  });

  // POST /api/admin/keys/:id/rotate — 轮转 Key
  admin.post("/keys/:id/rotate", (c) => {
    const id = c.req.param("id");
    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const result = apiKeyManager.rotateKey(id, adminPrefix);
    if (!result) {
      return c.json({ error: "API key not found or not rotatable" }, 404);
    }

    apiKeyManager.recordAdminAction(
      "key_rotate",
      "api_key",
      id,
      adminPrefix,
      clientIp,
      { new_key_id: result.id },
    );

    return c.json(result);
  });

  // =====================================================================
  // Ban Management — /api/admin/bans/*
  // =====================================================================

  // POST /api/admin/bans — 创建 Ban
  admin.post("/bans", async (c) => {
    const body = await c.req.json();
    const parsed = CreateBanSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const result = banManager.createBan(parsed.data, adminPrefix);

    apiKeyManager.recordAdminAction(
      "ban_create",
      "ban",
      result.id,
      adminPrefix,
      clientIp,
      {
        type: parsed.data.type,
        target: parsed.data.target,
        reason: parsed.data.reason,
      },
    );

    return c.json(result, 201);
  });

  // GET /api/admin/bans — 列出 Bans
  admin.get("/bans", (c) => {
    const rawQuery = extractQueryParams(c, [
      "type",
      "status",
      "page",
      "page_size",
    ]);

    const parsed = ListBansQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.issues },
        400,
      );
    }

    const result = banManager.listBans(parsed.data);
    return c.json(result);
  });

  // GET /api/admin/bans/:id — 获取 Ban 详情
  admin.get("/bans/:id", (c) => {
    const id = c.req.param("id");
    const ban = banManager.getBanById(id);
    if (!ban) {
      return c.json({ error: "Ban not found" }, 404);
    }
    return c.json(ban);
  });

  // DELETE /api/admin/bans/:id — 移除 Ban
  admin.delete("/bans/:id", (c) => {
    const id = c.req.param("id");
    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const result = banManager.removeBan(id);
    if (!result) {
      return c.json({ error: "Ban not found" }, 404);
    }

    apiKeyManager.recordAdminAction(
      "ban_remove",
      "ban",
      id,
      adminPrefix,
      clientIp,
    );

    return c.json(result);
  });

  // =====================================================================
  // Analytics — /api/admin/analytics/*
  // =====================================================================

  // GET /api/admin/analytics/overview — 系统总览
  admin.get("/analytics/overview", (c) => {
    const timeRange = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(timeRange);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const errorRate = analytics.getErrorRate({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });

    return c.json({
      requests_total: errorRate.total_requests,
      errors_total: errorRate.error_count,
      error_rate: errorRate.error_rate,
      rate_limited_total: errorRate.rate_limited_count,
      rejected_total: errorRate.rejected_count,
      uptime_ms: process.uptime() * 1000,
      analytics_ready: analytics.isReady,
      audit_stats: audit.getStats(),
    });
  });

  // GET /api/admin/analytics/users — 按用户汇总
  admin.get("/analytics/users", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const result = analytics.getUserUsage({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });
    return c.json({ data: result, total: result.length });
  });

  // GET /api/admin/analytics/projects — 按项目汇总
  admin.get("/analytics/projects", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const result = analytics.getProjectUsage({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });
    return c.json({ data: result, total: result.length });
  });

  // GET /api/admin/analytics/operations — 操作类型分布
  admin.get("/analytics/operations", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    // 使用 rollup 数据计算操作分布
    const rollups = analytics.queryRollups({
      granularity: "daily",
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });

    // 按 operation 聚合
    const opMap = new Map<
      string,
      {
        count: number;
        elapsed_sum: number;
        error_count: number;
      }
    >();

    for (const r of rollups) {
      const existing = opMap.get(r.operation) ?? {
        count: 0,
        elapsed_sum: 0,
        error_count: 0,
      };
      existing.count += r.total_count;
      existing.elapsed_sum += r.avg_elapsed_ms * r.total_count;
      existing.error_count += r.error_count;
      opMap.set(r.operation, existing);
    }

    const totalCount = Array.from(opMap.values()).reduce(
      (s, v) => s + v.count,
      0,
    );
    const operations = Array.from(opMap.entries()).map(([op, stats]) => ({
      operation: op,
      count: stats.count,
      percentage: totalCount > 0 ? stats.count / totalCount : 0,
      avg_elapsed_ms: stats.count > 0 ? stats.elapsed_sum / stats.count : 0,
      error_rate: stats.count > 0 ? stats.error_count / stats.count : 0,
    }));

    return c.json({ data: operations, total: operations.length });
  });

  // GET /api/admin/analytics/errors — 错误率分析
  admin.get("/analytics/errors", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const result = analytics.getErrorRate({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });
    return c.json(result);
  });

  // GET /api/admin/analytics/timeline — 时间序列数据
  admin.get("/analytics/timeline", (c) => {
    const rawQuery = extractQueryParams(c, [
      "key_prefix",
      "project",
      "operation",
      "granularity",
      "from",
      "to",
      "range",
    ]);

    const parsed = AnalyticsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const rollups = analytics.queryRollups(parsed.data);
    return c.json({ data: rollups, total: rollups.length });
  });

  // GET /api/admin/analytics/hit-rate — 搜索 Hit Rate 指标
  admin.get("/analytics/hit-rate", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range", "project"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const result = analytics.getHitRate({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
      project: c.req.query("project"),
    });
    return c.json(result);
  });

  // =====================================================================
  // Audit Log Queries — /api/admin/audit/*
  // =====================================================================

  // GET /api/admin/audit/logs — 查询审计日志 (分页 + 过滤)
  admin.get("/audit/logs", (c) => {
    const rawQuery = extractQueryParams(c, [
      "key_prefix",
      "project",
      "operation",
      "outcome",
      "from",
      "to",
      "range",
      "page",
      "page_size",
    ]);

    const parsed = AuditQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.issues },
        400,
      );
    }

    const result = analytics.queryEvents(parsed.data);
    return c.json(result);
  });

  // GET /api/admin/audit/export — 导出审计日志 (CSV/JSONL)
  admin.get("/audit/export", (c) => {
    const rawQuery = extractQueryParams(c, [
      "key_prefix",
      "project",
      "operation",
      "outcome",
      "from",
      "to",
      "range",
      "page",
      "page_size",
    ]);

    const parsed = AuditQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }

    const format = c.req.query("format") ?? "json";
    const events = analytics.exportEvents(parsed.data);
    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === "csv") {
      const csvHeader = [
        "event_id",
        "timestamp",
        "key_prefix",
        "operation",
        "project",
        "outcome",
        "outcome_detail",
        "elapsed_ms",
        "http_status",
        "client_ip",
        "user_agent",
      ].join(",");

      const csvRows = events.map((e) =>
        [
          e.event_id,
          e.timestamp,
          e.key_prefix,
          e.operation,
          e.project,
          e.outcome,
          `"${(e.outcome_detail ?? "").replace(/"/g, '""')}"`,
          e.elapsed_ms,
          e.http_status,
          e.client_ip,
          `"${(e.user_agent ?? "").replace(/"/g, '""')}"`,
        ].join(","),
      );

      const csv = [csvHeader, ...csvRows].join("\n");
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header(
        "Content-Disposition",
        `attachment; filename="audit-events-${dateStr}.csv"`,
      );
      return c.body(csv);
    }

    if (format === "jsonl") {
      const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header(
        "Content-Disposition",
        `attachment; filename="audit-events-${dateStr}.jsonl"`,
      );
      return c.body(jsonl);
    }

    return c.json({ data: events, total: events.length });
  });

  // =====================================================================
  // Runtime Configuration — /api/admin/config
  // =====================================================================

  // GET /api/admin/config — 获取当前运行时配置
  admin.get("/config", (c) => {
    return c.json({
      effective: runtimeConfig.getConfig(),
      defaults: runtimeConfig.getDefaults(),
      overrides: runtimeConfig.getOverrides(),
    });
  });

  // PATCH /api/admin/config — 更新运行时配置
  admin.patch("/config", async (c) => {
    const body = await c.req.json();
    const parsed = UpdateRuntimeConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.issues },
        400,
      );
    }

    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const updated = runtimeConfig.updateConfig(parsed.data);

    apiKeyManager.recordAdminAction(
      "config_update",
      "config",
      "runtime",
      adminPrefix,
      clientIp,
      { changes: parsed.data },
    );

    return c.json({
      effective: updated,
      overrides: runtimeConfig.getOverrides(),
    });
  });

  // POST /api/admin/config/reset — 重置配置到默认值
  admin.post("/config/reset", (c) => {
    const adminPrefix = getAdminKeyPrefix(c);
    const clientIp = getClientIp(c);

    const reset = runtimeConfig.resetConfig();

    apiKeyManager.recordAdminAction(
      "config_reset",
      "config",
      "runtime",
      adminPrefix,
      clientIp,
    );

    return c.json({
      effective: reset,
      message: "Configuration reset to defaults",
    });
  });

  // =====================================================================
  // Admin Actions Audit Trail — /api/admin/actions
  // =====================================================================

  admin.get("/actions", (c) => {
    const page = parseInt(c.req.query("page") ?? "1", 10);
    const pageSize = parseInt(c.req.query("page_size") ?? "50", 10);
    const action = c.req.query("action");

    const result = apiKeyManager.listAdminActions(page, pageSize, action);
    return c.json(result);
  });

  // =====================================================================
  // Legacy Routes — backward compatibility
  // =====================================================================

  // GET /api/admin/events → redirect to /api/admin/audit/logs
  admin.get("/events", (c) => {
    const rawQuery = extractQueryParams(c, [
      "key_prefix",
      "project",
      "operation",
      "outcome",
      "from",
      "to",
      "range",
      "page",
      "page_size",
    ]);
    const parsed = AuditQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.issues },
        400,
      );
    }
    const result = analytics.queryEvents(parsed.data);
    return c.json(result);
  });

  // GET /api/admin/events/export — legacy
  admin.get("/events/export", (c) => {
    const rawQuery = extractQueryParams(c, [
      "key_prefix",
      "project",
      "operation",
      "outcome",
      "from",
      "to",
      "range",
      "page",
      "page_size",
    ]);
    const parsed = AuditQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }
    const format = c.req.query("format") ?? "json";
    const events = analytics.exportEvents(parsed.data);
    if (format === "csv") {
      const csvHeader = [
        "event_id",
        "timestamp",
        "key_prefix",
        "operation",
        "project",
        "outcome",
        "outcome_detail",
        "elapsed_ms",
        "http_status",
        "client_ip",
        "user_agent",
      ].join(",");
      const csvRows = events.map((e) =>
        [
          e.event_id,
          e.timestamp,
          e.key_prefix,
          e.operation,
          e.project,
          e.outcome,
          `"${(e.outcome_detail ?? "").replace(/"/g, '""')}"`,
          e.elapsed_ms,
          e.http_status,
          e.client_ip,
          `"${(e.user_agent ?? "").replace(/"/g, '""')}"`,
        ].join(","),
      );
      const csv = [csvHeader, ...csvRows].join("\n");
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header(
        "Content-Disposition",
        `attachment; filename="audit-events-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return c.body(csv);
    }
    return c.json({ data: events, total: events.length });
  });

  // Legacy analytics/users/projects/errors at root level
  admin.get("/analytics", (c) => {
    const rawQuery = extractQueryParams(c, [
      "key_prefix",
      "project",
      "operation",
      "granularity",
      "from",
      "to",
      "range",
    ]);
    const parsed = AnalyticsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }
    const rollups = analytics.queryRollups(parsed.data);
    return c.json({ data: rollups, total: rollups.length });
  });

  admin.get("/hit-rate", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range", "project"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }
    const result = analytics.getHitRate({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
      project: c.req.query("project"),
    });
    return c.json(result);
  });

  admin.get("/users", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }
    const result = analytics.getUserUsage({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });
    return c.json({ data: result, total: result.length });
  });

  admin.get("/projects", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }
    const result = analytics.getProjectUsage({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });
    return c.json({ data: result, total: result.length });
  });

  admin.get("/errors", (c) => {
    const rawQuery = extractQueryParams(c, ["from", "to", "range"]);
    const parsed = TimeRangeQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: "Invalid query parameters" }, 400);
    }
    const result = analytics.getErrorRate({
      from: parsed.data.from,
      to: parsed.data.to,
      range: parsed.data.range,
    });
    return c.json(result);
  });

  // POST /api/admin/aggregate — 手动触发聚合
  admin.post("/aggregate", async (c) => {
    await analytics.runAggregation();
    return c.json({ status: "ok", message: "Aggregation completed" });
  });

  return admin;
}
