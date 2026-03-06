/**
 * Memory Browser API Routes — v0.7.0
 *
 * 提供记忆浏览、统计与更新的 HTTP 端点，
 * 支持 admin 和拥有 memories:browse 权限的 user 角色。
 *
 * @module api/memory-routes
 */
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import type { QdrantService } from "../services/qdrant.js";
import type { ApiKeyManager } from "../services/api-key-manager.js";
import type { AuthService } from "../services/auth.js";
import { adminOrUserAuth } from "./admin-auth.js";
import { createUserScopeMiddleware } from "./middlewares.js";
import { MEMORY_SCOPE_ENUM, MEMORY_TYPE_ENUM } from "../types/schema.js";
import { log } from "../utils/logger.js";

// =========================================================================
// Schemas — 请求参数校验
// =========================================================================

const BrowseQuerySchema = z.object({
  project: z.string().min(1).optional(),
  memory_scope: z.enum(MEMORY_SCOPE_ENUM).optional(),
  memory_type: z.enum(MEMORY_TYPE_ENUM).optional(),
  device_id: z.string().optional(),
  git_branch: z.string().optional(),
  lifecycle: z.enum(["active", "archived", "deprecated"]).optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.string().optional(),
});

const PatchMemorySchema = z.object({
  lifecycle: z.enum(["active", "archived", "deprecated"]).optional(),
  weight: z.number().min(0).max(10).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  memory_scope: z.enum(MEMORY_SCOPE_ENUM).optional(),
  memory_type: z.enum(MEMORY_TYPE_ENUM).optional(),
});

// =========================================================================
// Types
// =========================================================================

export interface MemoryRouteDeps {
  qdrant: QdrantService;
  apiKeyManager: ApiKeyManager;
  authService: AuthService;
  adminToken: string;
}

// =========================================================================
// Factory
// =========================================================================

/**
 * 创建 Memory Browser API 路由。
 *
 * 路由挂载在 `/api/memories` 前缀下。
 * 所有路由需要 adminOrUserAuth (memories:browse) 认证。
 */
export function createMemoryRoutes(deps: MemoryRouteDeps): Hono {
  const app = new Hono();
  const { qdrant, apiKeyManager, adminToken, authService } = deps;

  // 所有路由均需 memories:browse 权限
  app.use("/*", adminOrUserAuth(adminToken, authService, "memories:browse"));
  // 注入 userKeyPrefixes — admin 不受限制，普通用户只能看到自己 key 创建的记忆
  app.use("/*", createUserScopeMiddleware(apiKeyManager));

  // ----- GET / — 浏览记忆列表 -----
  app.get("/", async (c: Context) => {
    const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const parsed = BrowseQuerySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.issues },
        400,
      );
    }

    const query = parsed.data;
    const project = query.project ?? "default";

    // 构建 Qdrant filter
    const mustConditions: Array<Record<string, unknown>> = [];

    // 用户数据隔离: 非 admin 用户只能看到自己 key 创建的记忆
    const userKeyPrefixes = c.get("userKeyPrefixes" as never) as
      | string[]
      | undefined;
    if (userKeyPrefixes && userKeyPrefixes.length > 0) {
      mustConditions.push({
        key: "owner_key_prefix",
        match: { any: userKeyPrefixes },
      });
    }

    // lifecycle 默认只看 active
    mustConditions.push({
      key: "lifecycle",
      match: { value: query.lifecycle ?? "active" },
    });

    if (query.memory_scope) {
      mustConditions.push({
        key: "memory_scope",
        match: { value: query.memory_scope },
      });
    }
    if (query.memory_type) {
      mustConditions.push({
        key: "memory_type",
        match: { value: query.memory_type },
      });
    }
    if (query.device_id) {
      mustConditions.push({
        key: "device_id",
        match: { value: query.device_id },
      });
    }
    if (query.git_branch) {
      mustConditions.push({
        key: "git_branch",
        match: { value: query.git_branch },
      });
    }
    if (query.tag) {
      mustConditions.push({
        key: "tags",
        match: { value: query.tag },
      });
    }

    const filter =
      mustConditions.length > 0 ? { must: mustConditions } : undefined;

    try {
      const scrollOptions: {
        limit: number;
        offset: string | null;
        filter?: Record<string, unknown>;
      } = {
        limit: query.limit ?? 20,
        offset: query.offset ?? null,
      };
      if (filter) {
        scrollOptions.filter = filter;
      }

      const result = await qdrant.scrollPoints(project, scrollOptions);

      return c.json({
        ok: true,
        project,
        memories: result.points.map((p) => ({
          id: p.id,
          content: String(p.payload.content ?? ""),
          project: String(p.payload.project ?? project),
          fact_type: String(p.payload.fact_type ?? "observation"),
          tags: (p.payload.tags as string[]) ?? [],
          source: String(p.payload.source ?? "conversation"),
          confidence: Number(p.payload.confidence ?? 0.7),
          lifecycle: String(p.payload.lifecycle ?? "active"),
          created_at: String(p.payload.created_at ?? ""),
          updated_at: String(p.payload.updated_at ?? ""),
          memory_scope: String(p.payload.memory_scope ?? "project"),
          memory_type: String(p.payload.memory_type ?? "long_term"),
          weight: Number(p.payload.weight ?? 1.0),
          ...(p.payload.device_id
            ? { device_id: String(p.payload.device_id) }
            : {}),
          ...(p.payload.git_branch
            ? { git_branch: String(p.payload.git_branch) }
            : {}),
          ...(p.payload.owner_key_prefix
            ? { owner_key_prefix: String(p.payload.owner_key_prefix) }
            : {}),
          ...(p.payload.source_file
            ? { source_file: String(p.payload.source_file) }
            : {}),
        })),
        next_offset: result.next_offset,
      });
    } catch (err) {
      // Collection 不存在时优雅降级
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Not found") || msg.includes("doesn't exist")) {
        return c.json({ ok: true, project, memories: [], next_offset: null });
      }
      log.error("Memory browse failed", { project, error: msg });
      return c.json({ error: "Failed to browse memories" }, 500);
    }
  });

  // ----- GET /stats — 所有 collection 统计 -----
  app.get("/stats", async (c: Context) => {
    try {
      const collections = await qdrant.listAllCollections();
      const totalMemories = collections.reduce(
        (sum, col) => sum + col.points_count,
        0,
      );
      return c.json({
        ok: true,
        total_memories: totalMemories,
        total_projects: collections.length,
        collections,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Memory stats failed", { error: msg });
      return c.json({ error: "Failed to get memory stats" }, 500);
    }
  });

  // ----- PATCH /:project/:id — 更新记忆属性 -----
  app.patch("/:project/:id", async (c: Context) => {
    const project = c.req.param("project");
    const pointId = c.req.param("id");

    if (!project || !pointId) {
      return c.json({ error: "Missing project or id parameter" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = PatchMemorySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid patch payload", details: parsed.error.issues },
        400,
      );
    }

    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    // 构建要更新的 payload 字段
    const updates: Record<string, unknown> = {
      ...patch,
      updated_at: new Date().toISOString(),
    };

    try {
      // 用户数据隔离: 非 admin 用户只能修改自己 key 创建的记忆
      const userKeyPrefixes = c.get("userKeyPrefixes" as never) as
        | string[]
        | undefined;
      if (userKeyPrefixes) {
        // 读取目标点的 payload 做所有权验证
        const payload = await qdrant.getPointPayload(project, pointId);
        if (!payload) {
          return c.json({ error: "Memory not found" }, 404);
        }
        const ownerPrefix = String(payload.owner_key_prefix ?? "");
        if (!userKeyPrefixes.includes(ownerPrefix)) {
          return c.json({ error: "Insufficient permissions" }, 403);
        }
      }

      await qdrant.setPayload(project, pointId, updates);
      return c.json({ ok: true, updated: Object.keys(patch) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Memory patch failed", { project, pointId, error: msg });
      return c.json({ error: "Failed to update memory" }, 500);
    }
  });

  return app;
}
