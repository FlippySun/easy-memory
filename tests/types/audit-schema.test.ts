/**
 * @module tests/types/audit-schema.test
 * @description audit-schema.ts 的单元测试
 */

import { describe, it, expect } from "vitest";
import {
  extractKeyPrefix,
  truncatePreview,
  resolveTimeRange,
  AuditQuerySchema,
  AnalyticsQuerySchema,
  TimeRangeQuerySchema,
  AUDIT_OPERATION,
  AUDIT_OUTCOME,
} from "../../src/types/audit-schema.js";

// =========================================================================
// extractKeyPrefix
// =========================================================================

describe("extractKeyPrefix", () => {
  it("should extract first 8 chars from Bearer token", () => {
    expect(extractKeyPrefix("Bearer abcdefghijklmnop")).toBe("abcdefgh");
  });

  it("should return empty string for undefined header", () => {
    expect(extractKeyPrefix(undefined)).toBe("");
  });

  it("should return empty string for empty header", () => {
    expect(extractKeyPrefix("")).toBe("");
  });

  it("should return empty string for header without space", () => {
    expect(extractKeyPrefix("NoSpaceHere")).toBe("");
  });

  it("should return empty string for 'Bearer ' with no token", () => {
    expect(extractKeyPrefix("Bearer ")).toBe("");
  });

  it("should handle short tokens (< 8 chars)", () => {
    expect(extractKeyPrefix("Bearer abc")).toBe("abc");
  });

  it("should handle exactly 8 char tokens", () => {
    expect(extractKeyPrefix("Bearer 12345678")).toBe("12345678");
  });

  it("should trim whitespace from token", () => {
    expect(extractKeyPrefix("Bearer   abcdefghij  ")).toBe("abcdefgh");
  });
});

// =========================================================================
// truncatePreview
// =========================================================================

describe("truncatePreview", () => {
  it("should return short content as-is", () => {
    expect(truncatePreview("hello world")).toBe("hello world");
  });

  it("should truncate content over 80 chars", () => {
    const long = "a".repeat(100);
    const result = truncatePreview(long);
    expect(result).toHaveLength(83); // 80 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("should replace newlines with spaces", () => {
    expect(truncatePreview("line1\nline2\r\nline3")).toBe("line1 line2 line3");
  });

  it("should handle empty string", () => {
    expect(truncatePreview("")).toBe("");
  });

  it("should respect custom maxLen", () => {
    const result = truncatePreview("hello world this is a test", 10);
    expect(result).toBe("hello worl...");
  });

  it("should not truncate at exact maxLen", () => {
    const exact = "a".repeat(80);
    expect(truncatePreview(exact)).toBe(exact);
    expect(truncatePreview(exact)).toHaveLength(80);
  });

  it("should trim whitespace", () => {
    expect(truncatePreview("  hello  ")).toBe("hello");
  });
});

// =========================================================================
// resolveTimeRange
// =========================================================================

describe("resolveTimeRange", () => {
  it("should use explicit from/to when provided", () => {
    const from = "2024-01-01T00:00:00.000Z";
    const to = "2024-01-02T00:00:00.000Z";
    const result = resolveTimeRange({ from, to });
    expect(result.from).toBe(from);
    expect(result.to).toBe(to);
  });

  it("should generate from based on range when from is not provided", () => {
    const before = Date.now();
    const result = resolveTimeRange({ range: "1h" });
    const after = Date.now();

    const fromTs = new Date(result.from).getTime();
    const toTs = new Date(result.to).getTime();

    // to should be approximately now
    expect(toTs).toBeGreaterThanOrEqual(before);
    expect(toTs).toBeLessThanOrEqual(after);

    // from should be approximately 1 hour before now
    const diff = toTs - fromTs;
    expect(diff).toBeGreaterThanOrEqual(3_600_000 - 100);
    expect(diff).toBeLessThanOrEqual(3_600_000 + 100);
  });

  it("should default to 24h when no range specified", () => {
    const result = resolveTimeRange({});
    const fromTs = new Date(result.from).getTime();
    const toTs = new Date(result.to).getTime();
    const diff = toTs - fromTs;
    // Should be approximately 24 hours
    expect(diff).toBeGreaterThanOrEqual(86_400_000 - 100);
    expect(diff).toBeLessThanOrEqual(86_400_000 + 100);
  });

  it("should handle undefined params", () => {
    const result = resolveTimeRange({
      from: undefined,
      to: undefined,
      range: undefined,
    });
    expect(result.from).toBeTruthy();
    expect(result.to).toBeTruthy();
  });

  it("should produce ISO 8601 strings", () => {
    const result = resolveTimeRange({ range: "7d" });
    expect(() => new Date(result.from)).not.toThrow();
    expect(() => new Date(result.to)).not.toThrow();
    // ISO 8601 format check
    expect(result.from).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("should handle all range options", () => {
    for (const range of ["1h", "6h", "24h", "7d", "30d", "90d"]) {
      const result = resolveTimeRange({ range });
      expect(result.from).toBeTruthy();
      expect(result.to).toBeTruthy();
      expect(new Date(result.from).getTime()).toBeLessThan(
        new Date(result.to).getTime(),
      );
    }
  });
});

// =========================================================================
// Zod Schemas
// =========================================================================

describe("AuditQuerySchema", () => {
  it("should parse valid query with defaults", () => {
    const result = AuditQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.range).toBe("24h");
      expect(result.data.page).toBe(1);
      expect(result.data.page_size).toBe(50);
    }
  });

  it("should parse full query", () => {
    const result = AuditQuerySchema.safeParse({
      key_prefix: "abc12345",
      project: "my-project",
      operation: "memory_save",
      outcome: "success",
      range: "7d",
      page: "2",
      page_size: "100",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key_prefix).toBe("abc12345");
      expect(result.data.operation).toBe("memory_save");
      expect(result.data.page).toBe(2);
    }
  });

  it("should reject invalid operation", () => {
    const result = AuditQuerySchema.safeParse({ operation: "invalid_op" });
    expect(result.success).toBe(false);
  });

  it("should reject page_size > 1000", () => {
    const result = AuditQuerySchema.safeParse({ page_size: "1001" });
    expect(result.success).toBe(false);
  });

  it("should strip unknown fields", () => {
    const result = AuditQuerySchema.safeParse({ unknown_field: "value" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data as Record<string, unknown>)["unknown_field"],
      ).toBeUndefined();
    }
  });
});

describe("AnalyticsQuerySchema", () => {
  it("should parse with defaults", () => {
    const result = AnalyticsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.granularity).toBe("hourly");
      expect(result.data.range).toBe("24h");
    }
  });

  it("should accept daily granularity", () => {
    const result = AnalyticsQuerySchema.safeParse({ granularity: "daily" });
    expect(result.success).toBe(true);
  });

  it("should reject invalid granularity", () => {
    const result = AnalyticsQuerySchema.safeParse({ granularity: "weekly" });
    expect(result.success).toBe(false);
  });
});

describe("TimeRangeQuerySchema", () => {
  it("should parse with defaults", () => {
    const result = TimeRangeQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.range).toBe("24h");
    }
  });

  it("should accept datetime strings", () => {
    const result = TimeRangeQuerySchema.safeParse({
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

// =========================================================================
// Constants
// =========================================================================

describe("Constants", () => {
  it("should have all operation types", () => {
    expect(AUDIT_OPERATION).toContain("memory_save");
    expect(AUDIT_OPERATION).toContain("memory_search");
    expect(AUDIT_OPERATION).toContain("memory_forget");
    expect(AUDIT_OPERATION).toContain("memory_status");
    expect(AUDIT_OPERATION).toContain("auth_login");
    expect(AUDIT_OPERATION).toContain("auth_login_failed");
    expect(AUDIT_OPERATION).toContain("auth_logout");
    expect(AUDIT_OPERATION).toContain("auth_refresh");
    expect(AUDIT_OPERATION).toContain("auth_refresh_failed");
    expect(AUDIT_OPERATION).toContain("auth_register");
    expect(AUDIT_OPERATION).toContain("auth_user_update");
    expect(AUDIT_OPERATION).toContain("auth_user_delete");
  });

  it("should have all outcome types", () => {
    expect(AUDIT_OUTCOME).toContain("success");
    expect(AUDIT_OUTCOME).toContain("rejected");
    expect(AUDIT_OUTCOME).toContain("error");
    expect(AUDIT_OUTCOME).toContain("rate_limited");
    expect(AUDIT_OUTCOME).toContain("unauthorized");
  });
});
