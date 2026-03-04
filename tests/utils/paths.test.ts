/**
 * @module paths.test
 * @description 数据目录路径解析工具的单元测试。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDataDir, DATA_PATHS } from "../../src/utils/paths.js";

describe("paths — getDataDir & DATA_PATHS", () => {
  let originalDataDir: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    // 恢复环境变量
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("DATA_DIR 优先于 HOME", () => {
    process.env.DATA_DIR = "/custom/data";
    process.env.HOME = "/home/user";
    expect(getDataDir()).toBe("/custom/data");
  });

  it("缺少 DATA_DIR 时使用 HOME", () => {
    delete process.env.DATA_DIR;
    process.env.HOME = "/home/testuser";
    expect(getDataDir()).toBe("/home/testuser");
  });

  it("DATA_DIR 和 HOME 都缺失时回退到 /tmp", () => {
    delete process.env.DATA_DIR;
    delete process.env.HOME;
    expect(getDataDir()).toBe("/tmp");
  });

  it("DATA_PATHS 所有路径应包含在 getDataDir() 目录下", () => {
    process.env.DATA_DIR = "/data";
    const dir = getDataDir();

    expect(DATA_PATHS.adminDb).toContain(dir);
    expect(DATA_PATHS.analyticsDb).toContain(dir);
    expect(DATA_PATHS.auditLog).toContain(dir);
    expect(DATA_PATHS.runtimeConfig).toContain(dir);
    expect(DATA_PATHS.fallbackLog).toContain(dir);
  });

  it("DATA_PATHS 包含正确的文件名", () => {
    expect(DATA_PATHS.adminDb).toMatch(/\.easy-memory-admin\.db$/);
    expect(DATA_PATHS.analyticsDb).toMatch(/\.easy-memory-analytics\.db$/);
    expect(DATA_PATHS.auditLog).toMatch(/\.easy-memory-audit\.jsonl$/);
    expect(DATA_PATHS.runtimeConfig).toMatch(
      /\.easy-memory-runtime-config\.json$/,
    );
    expect(DATA_PATHS.fallbackLog).toMatch(/\.easy-memory-fallback\.log$/);
  });

  it("DATA_PATHS 是 getter — 动态响应环境变量变更", () => {
    process.env.DATA_DIR = "/mnt/a";
    expect(DATA_PATHS.adminDb).toContain("/mnt/a");

    process.env.DATA_DIR = "/mnt/b";
    expect(DATA_PATHS.adminDb).toContain("/mnt/b");
  });
});
