/**
 * @module tests/api/memory-routes
 * @description Memory Browser 用户作用域回归测试。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryRoutes } from "../../src/api/memory-routes.js";
import { ApiKeyManager } from "../../src/services/api-key-manager.js";
import { AuthService } from "../../src/services/auth.js";

const ADMIN_TOKEN = "memory-routes-test-admin-token-32chars";
const PASSWORD = "PasswordA1b";

interface TestContext {
  tmpDir: string;
  apiKeyManager: ApiKeyManager;
  authService: AuthService;
  qdrant: {
    scrollPoints: ReturnType<typeof vi.fn>;
    listAllCollections: ReturnType<typeof vi.fn>;
    countPoints: ReturnType<typeof vi.fn>;
    getPointPayload: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
  };
}

let ctx: TestContext;

function createApp() {
  const app = new Hono();
  app.route(
    "/memories",
    createMemoryRoutes({
      qdrant: ctx.qdrant as never,
      apiKeyManager: ctx.apiKeyManager,
      authService: ctx.authService,
      adminToken: ADMIN_TOKEN,
    }),
  );
  return app;
}

function createUser(username: string) {
  const user = ctx.authService.register(username, PASSWORD, "user");
  expect(user).not.toBeNull();

  const login = ctx.authService.login(username, PASSWORD);
  expect(login).not.toBeNull();

  return {
    user: user!,
    token: login!.accessToken,
  };
}

beforeEach(() => {
  const tmpDir = mkdtempSync(join(tmpdir(), "em-memory-routes-test-"));
  const apiKeyManager = new ApiKeyManager({
    dbPath: join(tmpDir, "admin.db"),
    keyPrefix: "em_",
  });
  apiKeyManager.open();

  const authService = new AuthService({
    adminToken: ADMIN_TOKEN,
    adminUsername: "",
    adminPassword: "",
  });
  authService.open(apiKeyManager.getDatabase() ?? undefined);

  ctx = {
    tmpDir,
    apiKeyManager,
    authService,
    qdrant: {
      scrollPoints: vi.fn(),
      listAllCollections: vi.fn(),
      countPoints: vi.fn(),
      getPointPayload: vi.fn(),
      setPayload: vi.fn(),
    },
  };
});

afterEach(() => {
  ctx.authService.close();
  ctx.apiKeyManager.close();
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

describe("Memory Browser user scoping", () => {
  it("scopes zero-key users by owner_user_id instead of leaking global state", async () => {
    const { user, token } = createUser("zero_key_user");
    const app = createApp();

    ctx.qdrant.scrollPoints.mockImplementation(async (_project, options) => {
      expect(options.filter).toEqual(
        expect.objectContaining({
          must: expect.arrayContaining([
            {
              key: "owner_user_id",
              match: { value: user.id },
            },
            {
              key: "lifecycle",
              match: { value: "active" },
            },
          ]),
        }),
      );

      return {
        points: [],
        next_offset: null,
      };
    });

    const res = await app.request("/memories", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.memories).toEqual([]);
    expect(body.next_offset).toBeNull();
    expect(ctx.qdrant.scrollPoints).toHaveBeenCalledTimes(1);
  });

  it("filters browse results by owner_user_id or the caller's historical key prefixes", async () => {
    const { user, token } = createUser("browse_scope_user");
    const key = ctx.apiKeyManager.createKey(
      { name: "browse-key" },
      "system",
      user.id,
    );
    const app = createApp();

    ctx.qdrant.scrollPoints.mockImplementation(async (_project, options) => {
      expect(options.filter).toEqual(
        expect.objectContaining({
          must: expect.arrayContaining([
            {
              should: [
                {
                  key: "owner_user_id",
                  match: { value: user.id },
                },
                {
                  key: "owner_key_prefix",
                  match: { any: [key.prefix] },
                },
              ],
            },
            {
              key: "lifecycle",
              match: { value: "active" },
            },
          ]),
        }),
      );

      return {
        points: [
          {
            id: "mem-1",
            payload: {
              content: "only mine",
              project: "default",
              fact_type: "observation",
              tags: ["mine"],
              source: "conversation",
              confidence: 0.9,
              lifecycle: "active",
              created_at: "2024-01-01T00:00:00.000Z",
              updated_at: "2024-01-01T00:00:00.000Z",
              memory_scope: "project",
              memory_type: "long_term",
              weight: 1,
              owner_user_id: user.id,
              owner_key_prefix: key.prefix,
            },
          },
        ],
        next_offset: null,
      };
    });

    const res = await app.request("/memories", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0].owner_key_prefix).toBe(key.prefix);
    expect(body.memories[0].owner_user_id).toBe(user.id);
  });

  it("keeps revoked historical prefixes in scope for browse and stats", async () => {
    const { user, token } = createUser("revoked_scope_user");
    const key = ctx.apiKeyManager.createKey(
      { name: "revoked-browse-key" },
      "system",
      user.id,
    );
    ctx.apiKeyManager.updateKey(key.id, { is_active: false });
    const app = createApp();

    ctx.qdrant.scrollPoints.mockImplementation(async (_project, options) => {
      expect(options.filter).toEqual(
        expect.objectContaining({
          must: expect.arrayContaining([
            {
              should: [
                {
                  key: "owner_user_id",
                  match: { value: user.id },
                },
                {
                  key: "owner_key_prefix",
                  match: { any: [key.prefix] },
                },
              ],
            },
            {
              key: "lifecycle",
              match: { value: "active" },
            },
          ]),
        }),
      );

      return {
        points: [],
        next_offset: null,
      };
    });

    const res = await app.request("/memories", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(ctx.qdrant.scrollPoints).toHaveBeenCalledTimes(1);
  });

  it("returns scoped per-project stats for non-admin users", async () => {
    const { user, token } = createUser("stats_scope_user");
    const key = ctx.apiKeyManager.createKey(
      { name: "stats-key" },
      "system",
      user.id,
    );
    const app = createApp();

    ctx.qdrant.listAllCollections.mockResolvedValue([
      { name: "em_proj-a", project: "proj-a", points_count: 50 },
      { name: "em_proj-b", project: "proj-b", points_count: 20 },
      { name: "em_proj-c", project: "proj-c", points_count: 10 },
    ]);
    ctx.qdrant.countPoints.mockImplementation(async (project, options) => {
      expect(options.filter).toEqual({
        must: [
          {
            should: [
              {
                key: "owner_user_id",
                match: { value: user.id },
              },
              {
                key: "owner_key_prefix",
                match: { any: [key.prefix] },
              },
            ],
          },
        ],
      });

      if (project === "proj-a") return 3;
      if (project === "proj-c") return 2;
      return 0;
    });

    const res = await app.request("/memories/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      total_memories: 5,
      total_projects: 2,
    });
    expect(body.collections).toEqual([
      { name: "em_proj-a", project: "proj-a", points_count: 3 },
      { name: "em_proj-c", project: "proj-c", points_count: 2 },
    ]);
  });

  it("applies explicit browse filters when computing stats", async () => {
    const { user, token } = createUser("filtered_stats_user");
    const key = ctx.apiKeyManager.createKey(
      { name: "filtered-stats-key" },
      "system",
      user.id,
    );
    const app = createApp();

    ctx.qdrant.countPoints.mockResolvedValue(4);

    const res = await app.request(
      "/memories/stats?project=proj-a&lifecycle=active&memory_scope=branch&memory_type=long_term&device_id=device-1&git_branch=main&tag=alpha",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ctx.qdrant.listAllCollections).not.toHaveBeenCalled();
    expect(ctx.qdrant.countPoints).toHaveBeenCalledWith("proj-a", {
      filter: {
        must: [
          {
            should: [
              {
                key: "owner_user_id",
                match: { value: user.id },
              },
              {
                key: "owner_key_prefix",
                match: { any: [key.prefix] },
              },
            ],
          },
          {
            key: "lifecycle",
            match: { value: "active" },
          },
          {
            key: "memory_scope",
            match: { value: "branch" },
          },
          {
            key: "memory_type",
            match: { value: "long_term" },
          },
          {
            key: "device_id",
            match: { value: "device-1" },
          },
          {
            key: "git_branch",
            match: { value: "main" },
          },
          {
            key: "tags",
            match: { value: "alpha" },
          },
        ],
      },
    });
    expect(body.collections).toEqual([
      { name: "em_proj-a", project: "proj-a", points_count: 4 },
    ]);
  });

  it("rejects patch requests for memories owned by another key prefix", async () => {
    const { user, token } = createUser("patch_scope_user");
    ctx.apiKeyManager.createKey({ name: "patch-key" }, "system", user.id);
    const app = createApp();

    ctx.qdrant.getPointPayload.mockResolvedValue({
      owner_key_prefix: "other123",
    });

    const res = await app.request("/memories/default/mem-2", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ weight: 2 }),
    });

    expect(res.status).toBe(403);
    expect(ctx.qdrant.setPayload).not.toHaveBeenCalled();
  });

  it("rejects patch requests for similar-but-not-equal legacy prefixes", async () => {
    const { user, token } = createUser("patch_similar_prefix_user");
    const key = ctx.apiKeyManager.createKey(
      { name: "patch-similar-prefix-key" },
      "system",
      user.id,
    );
    const app = createApp();

    ctx.qdrant.getPointPayload.mockResolvedValue({
      owner_key_prefix: key.prefix.slice(0, 8),
    });

    const res = await app.request("/memories/default/mem-similar-prefix", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ weight: 3 }),
    });

    expect(res.status).toBe(403);
    expect(ctx.qdrant.setPayload).not.toHaveBeenCalled();
  });

  it("allows patch requests when owner_user_id matches the caller", async () => {
    const { user, token } = createUser("patch_owner_user_scope_user");
    ctx.apiKeyManager.createKey(
      { name: "patch-owner-user-key" },
      "system",
      user.id,
    );
    const app = createApp();

    ctx.qdrant.getPointPayload.mockResolvedValue({
      owner_user_id: user.id,
      owner_key_prefix: "legacy-other-prefix",
    });

    const res = await app.request("/memories/default/mem-2", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ weight: 2 }),
    });

    expect(res.status).toBe(200);
    expect(ctx.qdrant.setPayload).toHaveBeenCalledWith(
      "default",
      "mem-2",
      expect.objectContaining({ weight: 2 }),
    );
  });
});
