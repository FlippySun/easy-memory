/**
 * @module tests/services/runtime-config.test.ts
 * @description RuntimeConfigManager 单元测试。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RuntimeConfigManager } from "../../src/services/runtime-config.js";
import type { RuntimeConfig } from "../../src/types/admin-schema.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_CONFIG_PATH = join(
  tmpdir(),
  `test-runtime-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
);

const DEFAULT_CONFIG: RuntimeConfig = {
  rate_limit_per_minute: 60,
  gemini_max_per_hour: 200,
  gemini_max_per_day: 2000,
  default_project: "default",
  require_tls: false,
  audit_enabled: true,
  raw_retention_days: 30,
  hourly_retention_days: 7,
  daily_retention_days: 90,
};

describe("RuntimeConfigManager", () => {
  let manager: RuntimeConfigManager;

  beforeEach(() => {
    // 清理旧文件
    if (existsSync(TEST_CONFIG_PATH)) {
      unlinkSync(TEST_CONFIG_PATH);
    }
    manager = new RuntimeConfigManager({
      configPath: TEST_CONFIG_PATH,
      defaults: { ...DEFAULT_CONFIG },
    });
  });

  afterEach(() => {
    if (existsSync(TEST_CONFIG_PATH)) {
      try {
        unlinkSync(TEST_CONFIG_PATH);
      } catch {
        /* ignore */
      }
    }
  });

  describe("getConfig", () => {
    it("returns defaults when no overrides exist", () => {
      const config = manager.getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it("returns a copy (not reference)", () => {
      const config1 = manager.getConfig();
      config1.rate_limit_per_minute = 9999;
      const config2 = manager.getConfig();
      expect(config2.rate_limit_per_minute).toBe(60);
    });
  });

  describe("updateConfig", () => {
    it("updates a single field", () => {
      const updated = manager.updateConfig({ rate_limit_per_minute: 120 });
      expect(updated.rate_limit_per_minute).toBe(120);
      // Other fields unchanged
      expect(updated.gemini_max_per_hour).toBe(200);
    });

    it("updates multiple fields", () => {
      const updated = manager.updateConfig({
        rate_limit_per_minute: 100,
        require_tls: true,
        audit_enabled: false,
      });
      expect(updated.rate_limit_per_minute).toBe(100);
      expect(updated.require_tls).toBe(true);
      expect(updated.audit_enabled).toBe(false);
    });

    it("persists to file", () => {
      manager.updateConfig({ rate_limit_per_minute: 200 });

      // Create new instance from same file
      const manager2 = new RuntimeConfigManager({
        configPath: TEST_CONFIG_PATH,
        defaults: { ...DEFAULT_CONFIG },
      });
      const config = manager2.getConfig();
      expect(config.rate_limit_per_minute).toBe(200);
    });
  });

  describe("resetConfig", () => {
    it("resets all overrides to defaults", () => {
      manager.updateConfig({ rate_limit_per_minute: 999, require_tls: true });
      const reset = manager.resetConfig();
      expect(reset).toEqual(DEFAULT_CONFIG);
    });

    it("persists reset to file", () => {
      manager.updateConfig({ rate_limit_per_minute: 999 });
      manager.resetConfig();

      const manager2 = new RuntimeConfigManager({
        configPath: TEST_CONFIG_PATH,
        defaults: { ...DEFAULT_CONFIG },
      });
      expect(manager2.getConfig()).toEqual(DEFAULT_CONFIG);
    });
  });

  describe("getOverrides", () => {
    it("returns empty when no overrides", () => {
      expect(manager.getOverrides()).toEqual({});
    });

    it("returns only overridden fields", () => {
      manager.updateConfig({ rate_limit_per_minute: 120 });
      const overrides = manager.getOverrides();
      expect(overrides).toEqual({ rate_limit_per_minute: 120 });
    });
  });

  describe("getDefaults", () => {
    it("returns the original defaults", () => {
      manager.updateConfig({ rate_limit_per_minute: 999 });
      const defaults = manager.getDefaults();
      expect(defaults.rate_limit_per_minute).toBe(60);
    });
  });

  describe("isOverridden", () => {
    it("returns false for non-overridden field", () => {
      expect(manager.isOverridden("rate_limit_per_minute")).toBe(false);
    });

    it("returns true for overridden field", () => {
      manager.updateConfig({ rate_limit_per_minute: 120 });
      expect(manager.isOverridden("rate_limit_per_minute")).toBe(true);
    });
  });

  describe("Corrupted config file", () => {
    it("handles invalid JSON gracefully", async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(TEST_CONFIG_PATH, "not-json!!", "utf-8");

      const mgr = new RuntimeConfigManager({
        configPath: TEST_CONFIG_PATH,
        defaults: { ...DEFAULT_CONFIG },
      });
      expect(mgr.getConfig()).toEqual(DEFAULT_CONFIG);
    });
  });

  // =========================================================================
  // onChange — 配置变更监听器
  // =========================================================================

  describe("onChange", () => {
    it("should call listener on updateConfig", () => {
      const listener = vi.fn();
      manager.onChange(listener);
      manager.updateConfig({ rate_limit_per_minute: 120 });

      expect(listener).toHaveBeenCalledTimes(1);
      const [newConfig, changedKeys] = listener.mock.calls[0];
      expect(newConfig.rate_limit_per_minute).toBe(120);
      expect(changedKeys).toEqual(["rate_limit_per_minute"]);
    });

    it("should call listener on resetConfig", () => {
      const listener = vi.fn();
      manager.updateConfig({ rate_limit_per_minute: 120 });
      manager.onChange(listener);
      manager.resetConfig();

      expect(listener).toHaveBeenCalledTimes(1);
      const [newConfig, changedKeys] = listener.mock.calls[0];
      expect(newConfig.rate_limit_per_minute).toBe(60); // 恢复默认值
      expect(changedKeys).toContain("rate_limit_per_minute");
    });

    it("should support unsubscribe", () => {
      const listener = vi.fn();
      const unsub = manager.onChange(listener);
      unsub();
      manager.updateConfig({ rate_limit_per_minute: 120 });
      expect(listener).not.toHaveBeenCalled();
    });

    it("should handle listener errors gracefully", () => {
      const badListener = vi.fn().mockImplementation(() => {
        throw new Error("listener crash");
      });
      const goodListener = vi.fn();
      manager.onChange(badListener);
      manager.onChange(goodListener);
      // Should not throw despite badListener error
      manager.updateConfig({ rate_limit_per_minute: 120 });
      expect(badListener).toHaveBeenCalledTimes(1);
      expect(goodListener).toHaveBeenCalledTimes(1);
    });

    it("should not call listener when no changes", () => {
      const listener = vi.fn();
      manager.onChange(listener);
      manager.updateConfig({});
      expect(listener).not.toHaveBeenCalled();
    });

    it("should call listener with multiple changed keys", () => {
      const listener = vi.fn();
      manager.onChange(listener);
      manager.updateConfig({
        rate_limit_per_minute: 120,
        audit_enabled: false,
      });
      const [, changedKeys] = listener.mock.calls[0];
      expect(changedKeys).toContain("rate_limit_per_minute");
      expect(changedKeys).toContain("audit_enabled");
    });
  });
});
