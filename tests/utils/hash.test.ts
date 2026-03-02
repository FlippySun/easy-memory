/**
 * @module hash.test
 * @description hash 模块单元测试 — 覆盖 normalizeForHash + computeHash
 */

import { describe, it, expect } from "vitest";
import { normalizeForHash, computeHash } from "../../src/utils/hash.js";

describe("normalizeForHash", () => {
  it("should trim leading/trailing whitespace", () => {
    expect(normalizeForHash("  hello  ")).toBe("hello");
  });

  it("should replace \\r\\n with \\n", () => {
    expect(normalizeForHash("line1\r\nline2")).toBe("line1\nline2");
  });

  it("should replace standalone \\r with \\n", () => {
    expect(normalizeForHash("line1\rline2")).toBe("line1\nline2");
  });

  it("should compress consecutive inline whitespace to single space", () => {
    expect(normalizeForHash("hello    world")).toBe("hello world");
  });

  it("should preserve newlines while compressing spaces", () => {
    expect(normalizeForHash("line1   \n   line2")).toBe("line1\n line2");
  });

  it("should handle mixed line endings", () => {
    const input = "a\r\nb\rc\nd";
    expect(normalizeForHash(input)).toBe("a\nb\nc\nd");
  });

  it("should handle tabs and spaces mix", () => {
    expect(normalizeForHash("hello\t\t  world")).toBe("hello world");
  });

  it("should handle empty string", () => {
    expect(normalizeForHash("")).toBe("");
  });

  it("should handle only whitespace", () => {
    expect(normalizeForHash("   \t  ")).toBe("");
  });
});

describe("computeHash", () => {
  it("should return a 64-char hex string (SHA-256)", () => {
    const hash = computeHash("test content");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should be deterministic — same input → same hash", () => {
    const hash1 = computeHash("hello world");
    const hash2 = computeHash("hello world");
    expect(hash1).toBe(hash2);
  });

  it("should produce different hashes for different input", () => {
    const hash1 = computeHash("hello");
    const hash2 = computeHash("world");
    expect(hash1).not.toBe(hash2);
  });

  it("should normalize before hashing — trim", () => {
    const hash1 = computeHash("  hello  ");
    const hash2 = computeHash("hello");
    expect(hash1).toBe(hash2);
  });

  it("should normalize before hashing — line endings", () => {
    const hash1 = computeHash("line1\r\nline2");
    const hash2 = computeHash("line1\nline2");
    expect(hash1).toBe(hash2);
  });

  it("should normalize before hashing — inline whitespace", () => {
    const hash1 = computeHash("hello    world");
    const hash2 = computeHash("hello world");
    expect(hash1).toBe(hash2);
  });

  it("should handle empty string", () => {
    const hash = computeHash("");
    expect(hash).toHaveLength(64);
  });

  it("should handle Unicode (CJK)", () => {
    const hash = computeHash("这是一段中文文本");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
