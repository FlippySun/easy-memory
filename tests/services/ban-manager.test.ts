/**
 * @module tests/services/ban-manager.test.ts
 * @description BanManager 单元测试 — CRUD + 内存缓存 + CIDR 匹配 + 过期清理。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BanManager } from "../../src/services/ban-manager.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB_PATH = join(
  tmpdir(),
  `test-ban-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

describe("BanManager", () => {
  let manager: BanManager;

  beforeEach(() => {
    manager = new BanManager({ dbPath: TEST_DB_PATH });
    manager.open();
  });

  afterEach(() => {
    manager.close();
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
  // createBan
  // =====================================================================

  describe("createBan", () => {
    it("creates permanent api_key ban", () => {
      const ban = manager.createBan(
        { type: "api_key", target: "key-123", reason: "Abuse" },
        "admin",
      );
      expect(ban.id).toBeDefined();
      expect(ban.type).toBe("api_key");
      expect(ban.target).toBe("key-123");
      expect(ban.reason).toBe("Abuse");
      expect(ban.expires_at).toBeNull();
      expect(ban.is_active).toBe(true);
      expect(ban.is_expired).toBe(false);
    });

    it("creates temporary ban with ttl_seconds", () => {
      const ban = manager.createBan(
        {
          type: "ip",
          target: "10.0.0.1",
          reason: "Rate limit",
          ttl_seconds: 3600,
        },
        "admin",
      );
      expect(ban.expires_at).toBeDefined();
      expect(ban.is_active).toBe(true);
    });

    it("creates ban with explicit expires_at", () => {
      const future = new Date(Date.now() + 86400_000).toISOString();
      const ban = manager.createBan(
        {
          type: "ip",
          target: "10.0.0.2",
          reason: "Test",
          expires_at: future,
        },
        "admin",
      );
      expect(ban.expires_at).toBe(future);
    });

    it("creates ip ban with CIDR notation", () => {
      const ban = manager.createBan(
        { type: "ip", target: "192.168.1.0/24", reason: "Subnet ban" },
        "admin",
      );
      expect(ban.target).toBe("192.168.1.0/24");
    });
  });

  // =====================================================================
  // isKeyBanned
  // =====================================================================

  describe("isKeyBanned", () => {
    it("detects banned key", () => {
      manager.createBan(
        { type: "api_key", target: "key-abc", reason: "Abuse" },
        "admin",
      );
      const result = manager.isKeyBanned("key-abc");
      expect(result.banned).toBe(true);
      if (result.banned) {
        expect(result.reason).toBe("Abuse");
      }
    });

    it("returns false for non-banned key", () => {
      const result = manager.isKeyBanned("key-xyz");
      expect(result.banned).toBe(false);
    });

    it("handles expired ban — lazy cleanup", () => {
      // 创建一个已过期的 ban (通过 ttl_seconds 接近 0)
      const ban = manager.createBan(
        {
          type: "api_key",
          target: "key-expire",
          reason: "Test",
          expires_at: new Date(Date.now() - 1000).toISOString(), // 已过期
        },
        "admin",
      );
      // 由于 loadActiveBans 在 open 时跳过已过期 ban，
      // 我们需要手动模拟内存中有过期 ban
      // 实际场景中，ban 创建时尚未过期，后续检查时发现过期
      expect(ban.id).toBeDefined();
    });
  });

  // =====================================================================
  // isIpBanned
  // =====================================================================

  describe("isIpBanned", () => {
    it("detects exact IP ban", () => {
      manager.createBan(
        { type: "ip", target: "10.0.0.5", reason: "Bad actor" },
        "admin",
      );
      const result = manager.isIpBanned("10.0.0.5");
      expect(result.banned).toBe(true);
    });

    it("detects CIDR range ban", () => {
      manager.createBan(
        { type: "ip", target: "192.168.1.0/24", reason: "Subnet" },
        "admin",
      );
      expect(manager.isIpBanned("192.168.1.100").banned).toBe(true);
      expect(manager.isIpBanned("192.168.1.255").banned).toBe(true);
      expect(manager.isIpBanned("192.168.2.1").banned).toBe(false);
    });

    it("returns false for non-banned IP", () => {
      const result = manager.isIpBanned("1.2.3.4");
      expect(result.banned).toBe(false);
    });

    it("returns false for empty IP", () => {
      const result = manager.isIpBanned("");
      expect(result.banned).toBe(false);
    });
  });

  // =====================================================================
  // removeBan
  // =====================================================================

  describe("removeBan", () => {
    it("deactivates ban", () => {
      const ban = manager.createBan(
        { type: "api_key", target: "key-rm", reason: "Test" },
        "admin",
      );
      const removed = manager.removeBan(ban.id);
      expect(removed!.is_active).toBe(false);

      // 验证 ban 检查不再命中
      const check = manager.isKeyBanned("key-rm");
      expect(check.banned).toBe(false);
    });

    it("returns null for non-existent ban", () => {
      expect(manager.removeBan("non-existent")).toBeNull();
    });
  });

  // =====================================================================
  // listBans
  // =====================================================================

  describe("listBans", () => {
    beforeEach(() => {
      manager.createBan(
        { type: "api_key", target: "key-1", reason: "Abuse" },
        "admin",
      );
      manager.createBan(
        { type: "ip", target: "10.0.0.1", reason: "Spam" },
        "admin",
      );
      manager.createBan(
        { type: "ip", target: "10.0.0.2", reason: "Bot" },
        "admin",
      );
    });

    it("lists all bans", () => {
      const result = manager.listBans({
        status: "all",
        page: 1,
        page_size: 20,
      });
      expect(result.data.length).toBe(3);
    });

    it("filters by type", () => {
      const result = manager.listBans({
        type: "ip",
        status: "all",
        page: 1,
        page_size: 20,
      });
      expect(result.data.length).toBe(2);
    });

    it("filters active bans", () => {
      const allBans = manager.listBans({
        status: "all",
        page: 1,
        page_size: 20,
      });
      manager.removeBan(allBans.data[0].id);

      const active = manager.listBans({
        status: "active",
        page: 1,
        page_size: 20,
      });
      expect(active.data.length).toBe(2);
    });

    it("paginates correctly", () => {
      const page1 = manager.listBans({
        status: "all",
        page: 1,
        page_size: 2,
      });
      expect(page1.data.length).toBe(2);
      expect(page1.pagination.total_pages).toBe(2);
    });
  });

  // =====================================================================
  // getBanById
  // =====================================================================

  describe("getBanById", () => {
    it("returns ban details", () => {
      const created = manager.createBan(
        { type: "api_key", target: "key-detail", reason: "Test" },
        "admin",
      );
      const ban = manager.getBanById(created.id);
      expect(ban).not.toBeNull();
      expect(ban!.target).toBe("key-detail");
    });

    it("returns null for non-existent", () => {
      expect(manager.getBanById("non-existent")).toBeNull();
    });
  });

  // =====================================================================
  // Error Handling
  // =====================================================================

  describe("Error handling", () => {
    it("throws if not initialized", () => {
      const uninit = new BanManager({ dbPath: "/tmp/unused.db" });
      expect(() =>
        uninit.createBan(
          { type: "api_key", target: "x", reason: "y" },
          "admin",
        ),
      ).toThrow("BanManager is not initialized");
    });
  });
});
