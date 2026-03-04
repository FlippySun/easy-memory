/**
 * @module tests/api/middlewares.test
 * @description HTTP 中间件单元测试。
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  bearerAuth,
  bearerAuthSimple,
  globalErrorHandler,
  requestLogger,
  tlsEnforcement,
  validateJsonContentType,
} from "../../src/api/middlewares.js";

// =========================================================================
// Mock factories for bearerAuth dual-auth tests
// =========================================================================

function createMockApiKeyManager(
  overrides: Partial<{
    validateKey: ReturnType<typeof vi.fn>;
    recordUsage: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    validateKey: overrides.validateKey ?? vi.fn().mockReturnValue(null),
    recordUsage: overrides.recordUsage ?? vi.fn(),
    // stubs for unused methods
    open: vi.fn(),
    close: vi.fn(),
    getDatabase: vi.fn().mockReturnValue(null),
    createKey: vi.fn(),
    listKeys: vi.fn(),
    getKey: vi.fn(),
    revokeKey: vi.fn(),
    rotateKey: vi.fn(),
    updateKey: vi.fn(),
    recordAdminAction: vi.fn(),
    getAdminActions: vi.fn(),
  } as any;
}

function createMockBanManager(
  overrides: Partial<{
    isKeyBanned: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    isKeyBanned:
      overrides.isKeyBanned ?? vi.fn().mockReturnValue({ banned: false }),
    isIpBanned: vi.fn().mockReturnValue({ banned: false }),
    open: vi.fn(),
    close: vi.fn(),
  } as any;
}

function createMockRateLimiter(
  overrides: Partial<{
    checkPerKeyRate: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    checkPerKeyRate: overrides.checkPerKeyRate ?? vi.fn(),
    checkRate: vi.fn(),
    getStats: vi.fn(),
  } as any;
}

// =========================================================================
// bearerAuth (dual-auth)
// =========================================================================

describe("bearerAuth", () => {
  it("should pass when masterToken is empty (dev mode)", async () => {
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "",
        apiKeyManager: createMockApiKeyManager(),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter(),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("should reject missing Authorization header", async () => {
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "secret",
        apiKeyManager: createMockApiKeyManager(),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter(),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Missing Authorization");
  });

  it("should reject invalid token (neither master nor managed key)", async () => {
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "secret",
        apiKeyManager: createMockApiKeyManager(),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter(),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("should accept valid master Bearer token", async () => {
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "my-secret",
        apiKeyManager: createMockApiKeyManager(),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter(),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer my-secret" },
    });
    expect(res.status).toBe(200);
  });

  it("should reject Basic auth scheme", async () => {
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "secret",
        apiKeyManager: createMockApiKeyManager(),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter(),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("should accept valid managed API key", async () => {
    const mockRecord = {
      id: "key-123",
      key_hash: "abcdef1234567890",
      rate_limit_per_minute: null,
    };
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "master-secret",
        apiKeyManager: createMockApiKeyManager({
          validateKey: vi.fn().mockReturnValue(mockRecord),
        }),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter(),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer em_managed-key-value" },
    });
    expect(res.status).toBe(200);
  });

  it("should reject banned API key", async () => {
    const mockRecord = {
      id: "key-123",
      key_hash: "abcdef1234567890",
      rate_limit_per_minute: null,
    };
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "master-secret",
        apiKeyManager: createMockApiKeyManager({
          validateKey: vi.fn().mockReturnValue(mockRecord),
        }),
        banManager: createMockBanManager({
          isKeyBanned: vi
            .fn()
            .mockReturnValue({ banned: true, reason: "abuse" }),
        }),
        rateLimiter: createMockRateLimiter(),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer em_managed-key-value" },
    });
    expect(res.status).toBe(403);
  });

  it("should reject per-key rate-limited API key", async () => {
    const mockRecord = {
      id: "key-123",
      key_hash: "abcdef1234567890",
      rate_limit_per_minute: 10,
    };
    const app = new Hono();
    app.use(
      "*",
      bearerAuth({
        masterToken: "master-secret",
        apiKeyManager: createMockApiKeyManager({
          validateKey: vi.fn().mockReturnValue(mockRecord),
        }),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter({
          checkPerKeyRate: vi.fn().mockImplementation(() => {
            throw new Error("Rate limit exceeded");
          }),
        }),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer em_managed-key-value" },
    });
    expect(res.status).toBe(429);
  });

  it("should re-throw non-rate-limit errors from checkPerKeyRate (P7-FIX)", async () => {
    const mockRecord = {
      id: "key-123",
      key_hash: "abcdef1234567890",
      rate_limit_per_minute: 10,
    };
    const app = new Hono();
    // globalErrorHandler 将未知异常转为 500
    app.onError(globalErrorHandler);
    app.use(
      "*",
      bearerAuth({
        masterToken: "master-secret",
        apiKeyManager: createMockApiKeyManager({
          validateKey: vi.fn().mockReturnValue(mockRecord),
        }),
        banManager: createMockBanManager(),
        rateLimiter: createMockRateLimiter({
          checkPerKeyRate: vi.fn().mockImplementation(() => {
            throw new TypeError("Cannot read properties of undefined");
          }),
        }),
        trustProxy: false,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer em_managed-key-value" },
    });
    // 内部 bug 应得到 500 而非 429
    expect(res.status).toBe(500);
  });
});

// =========================================================================
// globalErrorHandler (app.onError)
// =========================================================================

describe("globalErrorHandler", () => {
  it("should catch thrown errors and return 500 JSON", async () => {
    const app = new Hono();
    app.onError(globalErrorHandler);
    app.get("/test", () => {
      throw new Error("something broke");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("should return 429 for rate limit errors", async () => {
    const app = new Hono();
    app.onError(globalErrorHandler);
    app.get("/test", () => {
      throw new Error("Rate limit exceeded: max 60 calls/minute");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too many requests");
  });

  it("should pass through successful responses", async () => {
    const app = new Hono();
    app.onError(globalErrorHandler);
    app.get("/test", (c) => c.json({ result: "ok" }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// requestLogger
// =========================================================================

describe("requestLogger", () => {
  it("should not interfere with request processing", async () => {
    const app = new Hono();
    app.use("*", requestLogger);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});

// =========================================================================
// tlsEnforcement
// =========================================================================

describe("tlsEnforcement", () => {
  it("should be no-op when both flags are false", async () => {
    const app = new Hono();
    app.use("*", tlsEnforcement(false, false));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("should be no-op when trustProxy=true but requireTls=false", async () => {
    const app = new Hono();
    app.use("*", tlsEnforcement(true, false));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("should be no-op when trustProxy=false but requireTls=true", async () => {
    // Edge case: both must be true for enforcement
    const app = new Hono();
    app.use("*", tlsEnforcement(false, true));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("should reject request without X-Forwarded-Proto when enforced", async () => {
    const app = new Hono();
    app.use("*", tlsEnforcement(true, true));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(421);
    const body = await res.json();
    expect(body.error).toContain("HTTPS required");
  });

  it("should reject X-Forwarded-Proto: http", async () => {
    const app = new Hono();
    app.use("*", tlsEnforcement(true, true));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { "X-Forwarded-Proto": "http" },
    });
    expect(res.status).toBe(421);
  });

  it("should allow X-Forwarded-Proto: https and add HSTS header", async () => {
    const app = new Hono();
    app.use("*", tlsEnforcement(true, true));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

// =========================================================================
// validateJsonContentType
// =========================================================================

describe("validateJsonContentType", () => {
  it("should allow GET requests without Content-Type", async () => {
    const app = new Hono();
    app.use("*", validateJsonContentType);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("should reject POST without Content-Type: application/json", async () => {
    const app = new Hono();
    app.use("*", validateJsonContentType);
    app.post("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      method: "POST",
      body: "hello",
    });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toContain("Content-Type must be application/json");
  });

  it("should allow POST with Content-Type: application/json", async () => {
    const app = new Hono();
    app.use("*", validateJsonContentType);
    app.post("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: 1 }),
    });
    expect(res.status).toBe(200);
  });

  it("should reject PUT without proper Content-Type", async () => {
    const app = new Hono();
    app.use("*", validateJsonContentType);
    app.put("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
  });
});
