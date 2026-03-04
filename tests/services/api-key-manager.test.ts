/**
 * @module tests/services/api-key-manager.test.ts
 * @description ApiKeyManager 单元测试 — CRUD + 缓存 + 审计。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ApiKeyManager } from "../../src/services/api-key-manager.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB_PATH = join(
  tmpdir(),
  `test-admin-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

describe("ApiKeyManager", () => {
  let manager: ApiKeyManager;

  beforeEach(() => {
    manager = new ApiKeyManager({ dbPath: TEST_DB_PATH });
    manager.open();
  });

  afterEach(() => {
    manager.close();
    // 清理测试数据库
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = TEST_DB_PATH + suffix;
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          /* ignore */
        }
      }
    }
  });

  // =====================================================================
  // createKey
  // =====================================================================

  describe("createKey", () => {
    it("creates a key and returns plaintext key", () => {
      const result = manager.createKey({ name: "test-key" }, "admin");
      expect(result.id).toBeDefined();
      expect(result.key).toBeDefined();
      expect(result.key.startsWith("em_")).toBe(true);
      expect(result.name).toBe("test-key");
      expect(result.prefix).toBe(result.key.slice(0, 8));
      expect(result.is_active).toBe(true);
      expect(result.created_by).toBe("admin");
    });

    it("stores key hash, not plaintext", () => {
      const result = manager.createKey({ name: "test-key" }, "admin");
      const keyById = manager.getKeyById(result.id);
      expect(keyById).toBeDefined();
      // key 字段不应出现在 getKeyById 响应中
      expect(
        (keyById as unknown as Record<string, unknown>).key,
      ).toBeUndefined();
    });

    it("applies default scopes when none specified", () => {
      const result = manager.createKey({ name: "test" }, "admin");
      expect(result.scopes).toContain("memory:read");
      expect(result.scopes).toContain("memory:write");
    });

    it("applies custom scopes", () => {
      const result = manager.createKey(
        { name: "readonly", scopes: ["memory:read"] },
        "admin",
      );
      expect(result.scopes).toEqual(["memory:read"]);
    });

    it("applies custom rate limit", () => {
      const result = manager.createKey(
        { name: "limited", rate_limit_per_minute: 30 },
        "admin",
      );
      expect(result.rate_limit_per_minute).toBe(30);
    });

    it("stores metadata", () => {
      const result = manager.createKey(
        { name: "meta", metadata: { team: "backend", env: "staging" } },
        "admin",
      );
      expect(result.metadata).toEqual({ team: "backend", env: "staging" });
    });
  });

  // =====================================================================
  // validateKey
  // =====================================================================

  describe("validateKey", () => {
    it("validates correct key", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      const record = manager.validateKey(created.key);
      expect(record).not.toBeNull();
      expect(record!.id).toBe(created.id);
    });

    it("returns null for invalid key", () => {
      const record = manager.validateKey("em_invalid_key_12345");
      expect(record).toBeNull();
    });

    it("returns null for revoked key", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      manager.revokeKey(created.id);
      const record = manager.validateKey(created.key);
      expect(record).toBeNull();
    });

    it("returns null for expired key", () => {
      const created = manager.createKey(
        { name: "expiring", expires_at: "2020-01-01T00:00:00Z" },
        "admin",
      );
      const record = manager.validateKey(created.key);
      expect(record).toBeNull();
    });
  });

  // =====================================================================
  // listKeys
  // =====================================================================

  describe("listKeys", () => {
    beforeEach(() => {
      manager.createKey({ name: "alpha" }, "admin");
      manager.createKey({ name: "beta" }, "admin");
      manager.createKey({ name: "gamma" }, "admin");
    });

    it("lists all keys with pagination", () => {
      const result = manager.listKeys({
        status: "all",
        sort_by: "created_at",
        sort_order: "desc",
        page: 1,
        page_size: 20,
      });
      expect(result.data.length).toBe(3);
      expect(result.pagination.total_count).toBe(3);
    });

    it("filters active keys only", () => {
      const keys = manager.listKeys({
        status: "all",
        sort_by: "created_at",
        sort_order: "desc",
        page: 1,
        page_size: 20,
      });
      manager.revokeKey(keys.data[0].id);

      const active = manager.listKeys({
        status: "active",
        sort_by: "created_at",
        sort_order: "desc",
        page: 1,
        page_size: 20,
      });
      expect(active.data.length).toBe(2);
    });

    it("filters revoked keys only", () => {
      const keys = manager.listKeys({
        status: "all",
        sort_by: "created_at",
        sort_order: "desc",
        page: 1,
        page_size: 20,
      });
      manager.revokeKey(keys.data[0].id);

      const revoked = manager.listKeys({
        status: "revoked",
        sort_by: "created_at",
        sort_order: "desc",
        page: 1,
        page_size: 20,
      });
      expect(revoked.data.length).toBe(1);
    });

    it("searches by name", () => {
      const result = manager.listKeys({
        name: "alp",
        status: "all",
        sort_by: "created_at",
        sort_order: "desc",
        page: 1,
        page_size: 20,
      });
      expect(result.data.length).toBe(1);
      expect(result.data[0].name).toBe("alpha");
    });

    it("paginates correctly", () => {
      const page1 = manager.listKeys({
        status: "all",
        sort_by: "created_at",
        sort_order: "desc",
        page: 1,
        page_size: 2,
      });
      expect(page1.data.length).toBe(2);
      expect(page1.pagination.total_pages).toBe(2);

      const page2 = manager.listKeys({
        status: "all",
        sort_by: "created_at",
        sort_order: "desc",
        page: 2,
        page_size: 2,
      });
      expect(page2.data.length).toBe(1);
    });
  });

  // =====================================================================
  // updateKey
  // =====================================================================

  describe("updateKey", () => {
    it("updates name", () => {
      const created = manager.createKey({ name: "old-name" }, "admin");
      const updated = manager.updateKey(created.id, { name: "new-name" });
      expect(updated!.name).toBe("new-name");
    });

    it("updates rate limit", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      const updated = manager.updateKey(created.id, {
        rate_limit_per_minute: 200,
      });
      expect(updated!.rate_limit_per_minute).toBe(200);
    });

    it("merges metadata (not replaces)", () => {
      const created = manager.createKey(
        { name: "test", metadata: { a: 1, b: 2 } },
        "admin",
      );
      const updated = manager.updateKey(created.id, {
        metadata: { b: 3, c: 4 },
      });
      expect(updated!.metadata).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("returns null for non-existent key", () => {
      const result = manager.updateKey("non-existent", { name: "test" });
      expect(result).toBeNull();
    });
  });

  // =====================================================================
  // revokeKey
  // =====================================================================

  describe("revokeKey", () => {
    it("soft-deletes key", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      const revoked = manager.revokeKey(created.id);
      expect(revoked!.is_active).toBe(false);
      expect(revoked!.revoked_at).toBeDefined();
    });

    it("is idempotent", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      manager.revokeKey(created.id);
      const revoked2 = manager.revokeKey(created.id);
      expect(revoked2).not.toBeNull();
    });

    it("returns null for non-existent key", () => {
      expect(manager.revokeKey("non-existent")).toBeNull();
    });
  });

  // =====================================================================
  // rotateKey
  // =====================================================================

  describe("rotateKey", () => {
    it("creates new key and revokes old", () => {
      const original = manager.createKey({ name: "rotate-me" }, "admin");
      const rotated = manager.rotateKey(original.id, "admin");

      expect(rotated).not.toBeNull();
      expect(rotated!.id).not.toBe(original.id);
      expect(rotated!.key).toBeDefined();
      expect(rotated!.key).not.toBe(original.key);
      expect(rotated!.name).toBe("rotate-me");
      expect(rotated!.is_active).toBe(true);

      // 旧 key 应该被吊销
      const oldKey = manager.getKeyById(original.id);
      expect(oldKey!.is_active).toBe(false);
    });

    it("inherits properties from old key", () => {
      const original = manager.createKey(
        {
          name: "rotate-me",
          rate_limit_per_minute: 42,
          scopes: ["memory:read"],
          metadata: { env: "prod" },
        },
        "admin",
      );
      const rotated = manager.rotateKey(original.id, "admin");

      expect(rotated!.rate_limit_per_minute).toBe(42);
      expect(rotated!.scopes).toEqual(["memory:read"]);
      expect(rotated!.metadata).toEqual({ env: "prod" });
    });

    it("returns null for non-existent key", () => {
      expect(manager.rotateKey("non-existent", "admin")).toBeNull();
    });

    it("returns null for already revoked key", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      manager.revokeKey(created.id);
      expect(manager.rotateKey(created.id, "admin")).toBeNull();
    });
  });

  // =====================================================================
  // recordUsage
  // =====================================================================

  describe("recordUsage", () => {
    it("updates last_used_at and total_requests", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      const hash = manager.hashKey(created.key);

      manager.recordUsage(hash);
      manager.recordUsage(hash);

      const updated = manager.getKeyById(created.id);
      expect(updated!.last_used_at).toBeDefined();
      expect(updated!.total_requests).toBe(2);
    });
  });

  // =====================================================================
  // Admin Action Audit
  // =====================================================================

  describe("Admin Action Audit", () => {
    it("records and retrieves admin actions", () => {
      manager.recordAdminAction(
        "key_create",
        "api_key",
        "target-123",
        "admin",
        "127.0.0.1",
        { test: true },
      );

      const actions = manager.listAdminActions(1, 50);
      expect(actions.data.length).toBe(1);
      expect(actions.data[0].action).toBe("key_create");
      expect(actions.data[0].target_id).toBe("target-123");
    });

    it("filters by action type", () => {
      manager.recordAdminAction(
        "key_create",
        "api_key",
        "1",
        "admin",
        "127.0.0.1",
      );
      manager.recordAdminAction(
        "key_revoke",
        "api_key",
        "2",
        "admin",
        "127.0.0.1",
      );

      const createOnly = manager.listAdminActions(1, 50, "key_create");
      expect(createOnly.data.length).toBe(1);
    });
  });

  // =====================================================================
  // Cache Consistency
  // =====================================================================

  describe("Cache consistency", () => {
    it("cache is populated after createKey", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      // 验证 validateKey (使用 hash 查缓存) 可以找到
      const record = manager.validateKey(created.key);
      expect(record).not.toBeNull();
    });

    it("cache is updated after updateKey", () => {
      const created = manager.createKey({ name: "old" }, "admin");
      manager.updateKey(created.id, { name: "new" });
      // getKeyById 应该返回更新后的值
      const key = manager.getKeyById(created.id);
      expect(key!.name).toBe("new");
    });

    it("cache reflects revocation", () => {
      const created = manager.createKey({ name: "test" }, "admin");
      manager.revokeKey(created.id);
      const record = manager.validateKey(created.key);
      expect(record).toBeNull();
    });
  });

  // =====================================================================
  // Error Handling
  // =====================================================================

  describe("Error handling", () => {
    it("throws if not initialized", () => {
      const uninit = new ApiKeyManager({ dbPath: "/tmp/unused.db" });
      expect(() => uninit.createKey({ name: "test" }, "admin")).toThrow(
        "ApiKeyManager is not initialized",
      );
    });
  });
});
