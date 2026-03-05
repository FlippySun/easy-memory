/**
 * @module tests/types/admin-schema.test.ts
 * @description Admin Schema 类型 + 工具函数的单元测试。
 */

import { describe, it, expect } from "vitest";
import {
  CreateApiKeySchema,
  UpdateApiKeySchema,
  ListApiKeysQuerySchema,
  CreateBanSchema,
  ListBansQuerySchema,
  UpdateRuntimeConfigSchema,
  toApiKeyResponse,
  toBanResponse,
  ipMatchesCidr,
  buildPaginatedResponse,
} from "../../src/types/admin-schema.js";
import type { ApiKeyRecord, BanRecord } from "../../src/types/admin-schema.js";

// =========================================================================
// Zod Schema Tests
// =========================================================================

describe("CreateApiKeySchema", () => {
  it("accepts valid minimal input", () => {
    const result = CreateApiKeySchema.safeParse({ name: "test-key" });
    expect(result.success).toBe(true);
  });

  it("accepts full input", () => {
    const result = CreateApiKeySchema.safeParse({
      name: "production-key",
      expires_at: "2025-12-31T23:59:59Z",
      rate_limit_per_minute: 100,
      scopes: ["memory:read", "memory:write"],
      metadata: { team: "backend" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = CreateApiKeySchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name exceeding 128 chars", () => {
    const result = CreateApiKeySchema.safeParse({ name: "x".repeat(129) });
    expect(result.success).toBe(false);
  });

  it("rejects invalid scope", () => {
    const result = CreateApiKeySchema.safeParse({
      name: "test",
      scopes: ["invalid:scope"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects rate_limit_per_minute > 10000", () => {
    const result = CreateApiKeySchema.safeParse({
      name: "test",
      rate_limit_per_minute: 10001,
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields", () => {
    const result = CreateApiKeySchema.safeParse({
      name: "test",
      unknown_field: "value",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data as Record<string, unknown>).unknown_field,
      ).toBeUndefined();
    }
  });
});

describe("UpdateApiKeySchema", () => {
  it("accepts partial update", () => {
    const result = UpdateApiKeySchema.safeParse({ name: "new-name" });
    expect(result.success).toBe(true);
  });

  it("accepts nullable rate_limit_per_minute", () => {
    const result = UpdateApiKeySchema.safeParse({
      rate_limit_per_minute: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts nullable expires_at", () => {
    const result = UpdateApiKeySchema.safeParse({ expires_at: null });
    expect(result.success).toBe(true);
  });

  it("accepts is_active boolean toggle", () => {
    const disable = UpdateApiKeySchema.safeParse({ is_active: false });
    const enable = UpdateApiKeySchema.safeParse({ is_active: true });
    expect(disable.success).toBe(true);
    expect(enable.success).toBe(true);
  });

  it("rejects empty object (prevents silent no-op)", () => {
    const result = UpdateApiKeySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ListApiKeysQuerySchema", () => {
  it("applies defaults for empty input", () => {
    const result = ListApiKeysQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("all");
      expect(result.data.sort_by).toBe("created_at");
      expect(result.data.sort_order).toBe("desc");
      expect(result.data.page).toBe(1);
      expect(result.data.page_size).toBe(20);
    }
  });

  it("coerces string page to number", () => {
    const result = ListApiKeysQuerySchema.safeParse({ page: "3" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
    }
  });

  it("rejects page_size > 100", () => {
    const result = ListApiKeysQuerySchema.safeParse({ page_size: "101" });
    expect(result.success).toBe(false);
  });

  it("accepts soft_deleted status", () => {
    const result = ListApiKeysQuerySchema.safeParse({ status: "soft_deleted" });
    expect(result.success).toBe(true);
  });
});

describe("CreateBanSchema", () => {
  it("accepts api_key ban", () => {
    const result = CreateBanSchema.safeParse({
      type: "api_key",
      target: "some-uuid",
      reason: "Abuse",
    });
    expect(result.success).toBe(true);
  });

  it("accepts ip ban with CIDR", () => {
    const result = CreateBanSchema.safeParse({
      type: "ip",
      target: "192.168.1.0/24",
      reason: "Suspicious activity",
    });
    expect(result.success).toBe(true);
  });

  it("accepts temporary ban with ttl_seconds", () => {
    const result = CreateBanSchema.safeParse({
      type: "ip",
      target: "10.0.0.1",
      reason: "Rate limit exceeded",
      ttl_seconds: 3600,
    });
    expect(result.success).toBe(true);
  });

  it("rejects both expires_at and ttl_seconds", () => {
    const result = CreateBanSchema.safeParse({
      type: "ip",
      target: "10.0.0.1",
      reason: "Test",
      expires_at: "2025-12-31T23:59:59Z",
      ttl_seconds: 3600,
    });
    expect(result.success).toBe(false);
  });

  it("rejects ttl_seconds < 60", () => {
    const result = CreateBanSchema.safeParse({
      type: "ip",
      target: "10.0.0.1",
      reason: "Test",
      ttl_seconds: 30,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty reason", () => {
    const result = CreateBanSchema.safeParse({
      type: "ip",
      target: "10.0.0.1",
      reason: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("ListBansQuerySchema", () => {
  it("applies default status = active", () => {
    const result = ListBansQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });
});

describe("UpdateRuntimeConfigSchema", () => {
  it("accepts valid partial update", () => {
    const result = UpdateRuntimeConfigSchema.safeParse({
      rate_limit_per_minute: 120,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty object (no changes)", () => {
    const result = UpdateRuntimeConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects rate_limit > 10000", () => {
    const result = UpdateRuntimeConfigSchema.safeParse({
      rate_limit_per_minute: 10001,
    });
    expect(result.success).toBe(false);
  });
});

// =========================================================================
// Converter Function Tests
// =========================================================================

describe("toApiKeyResponse", () => {
  const baseRecord: ApiKeyRecord = {
    id: "test-id",
    name: "Test Key",
    prefix: "em_12345",
    key_hash: "hash123",
    created_at: "2025-01-01T00:00:00Z",
    expires_at: null,
    revoked_at: null,
    soft_deleted_at: null,
    semi_deleted_at: null,
    last_used_at: null,
    rate_limit_per_minute: null,
    scopes: '["memory:read","memory:write"]',
    metadata: '{"team":"test"}',
    total_requests: 42,
    created_by: "system",
    user_id: null,
  };

  it("converts record to response with parsed JSON fields", () => {
    const response = toApiKeyResponse(baseRecord);
    expect(response.scopes).toEqual(["memory:read", "memory:write"]);
    expect(response.metadata).toEqual({ team: "test" });
    expect(response.is_active).toBe(true);
    expect(response.lifecycle_status).toBe("active");
  });

  it("marks expired key as inactive", () => {
    const expired = {
      ...baseRecord,
      expires_at: "2020-01-01T00:00:00Z",
    };
    const response = toApiKeyResponse(expired);
    expect(response.is_active).toBe(false);
    expect(response.lifecycle_status).toBe("expired");
  });

  it("marks revoked key as disabled", () => {
    const revoked = {
      ...baseRecord,
      revoked_at: "2025-06-01T00:00:00Z",
    };
    const response = toApiKeyResponse(revoked);
    expect(response.is_active).toBe(false);
    expect(response.lifecycle_status).toBe("disabled");
  });

  it("marks soft deleted key with dedicated lifecycle status", () => {
    const softDeleted = {
      ...baseRecord,
      soft_deleted_at: "2025-06-02T00:00:00Z",
    };
    const response = toApiKeyResponse(softDeleted);
    expect(response.is_active).toBe(false);
    expect(response.lifecycle_status).toBe("soft_deleted");
  });

  it("handles malformed JSON gracefully", () => {
    const malformed = { ...baseRecord, scopes: "not-json", metadata: "{bad" };
    const response = toApiKeyResponse(malformed);
    expect(response.scopes).toEqual([]);
    expect(response.metadata).toEqual({});
  });
});

describe("toBanResponse", () => {
  const baseRecord: BanRecord = {
    id: "ban-id",
    type: "api_key",
    target: "target-key-id",
    reason: "Abuse",
    created_at: "2025-01-01T00:00:00Z",
    expires_at: null,
    created_by: "admin",
    is_active: 1,
  };

  it("converts active permanent ban", () => {
    const response = toBanResponse(baseRecord);
    expect(response.is_active).toBe(true);
    expect(response.is_expired).toBe(false);
  });

  it("marks expired ban correctly", () => {
    const expired = {
      ...baseRecord,
      expires_at: "2020-01-01T00:00:00Z",
    };
    const response = toBanResponse(expired);
    expect(response.is_active).toBe(false);
    expect(response.is_expired).toBe(true);
  });

  it("marks deactivated ban", () => {
    const deactivated = { ...baseRecord, is_active: 0 as const };
    const response = toBanResponse(deactivated);
    expect(response.is_active).toBe(false);
  });
});

// =========================================================================
// CIDR Matching Tests
// =========================================================================

describe("ipMatchesCidr", () => {
  it("matches exact IP", () => {
    expect(ipMatchesCidr("192.168.1.1", "192.168.1.1")).toBe(true);
  });

  it("does not match different IP", () => {
    expect(ipMatchesCidr("192.168.1.2", "192.168.1.1")).toBe(false);
  });

  it("matches IP in /24 CIDR range", () => {
    expect(ipMatchesCidr("192.168.1.100", "192.168.1.0/24")).toBe(true);
    expect(ipMatchesCidr("192.168.1.255", "192.168.1.0/24")).toBe(true);
    expect(ipMatchesCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
  });

  it("matches IP in /16 CIDR range", () => {
    expect(ipMatchesCidr("10.0.50.123", "10.0.0.0/16")).toBe(true);
    expect(ipMatchesCidr("10.1.0.1", "10.0.0.0/16")).toBe(false);
  });

  it("matches IP in /8 CIDR range", () => {
    expect(ipMatchesCidr("10.200.100.50", "10.0.0.0/8")).toBe(true);
    expect(ipMatchesCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
  });

  it("matches all IPs with /0", () => {
    expect(ipMatchesCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipMatchesCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
  });

  it("matches single IP with /32", () => {
    expect(ipMatchesCidr("192.168.1.1", "192.168.1.1/32")).toBe(true);
    expect(ipMatchesCidr("192.168.1.2", "192.168.1.1/32")).toBe(false);
  });

  it("handles IPv6 as exact match only", () => {
    expect(ipMatchesCidr("::1", "::1")).toBe(true);
    expect(ipMatchesCidr("::1", "::2")).toBe(false);
  });

  it("handles invalid CIDR prefix gracefully", () => {
    expect(ipMatchesCidr("1.2.3.4", "1.2.3.4/abc")).toBe(false);
  });

  it("handles invalid IP gracefully", () => {
    expect(ipMatchesCidr("999.999.999.999", "10.0.0.0/8")).toBe(false);
  });
});

// =========================================================================
// Pagination Tests
// =========================================================================

describe("buildPaginatedResponse", () => {
  it("calculates pagination correctly", () => {
    const result = buildPaginatedResponse(["a", "b", "c"], 25, 2, 10);
    expect(result.pagination).toEqual({
      page: 2,
      page_size: 10,
      total_count: 25,
      total_pages: 3,
    });
    expect(result.data).toEqual(["a", "b", "c"]);
  });

  it("handles empty data", () => {
    const result = buildPaginatedResponse([], 0, 1, 10);
    expect(result.pagination.total_pages).toBe(0);
  });
});
