/**
 * @module tests/api/admin-auth.test.ts
 * @description Admin 认证中间件单元测试。
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  adminAuth,
  getAdminKeyPrefix,
  getClientIp,
} from "../../src/api/admin-auth.js";
import type { AuthService } from "../../src/services/auth.js";

function createTestApp(adminToken: string) {
  const app = new Hono();
  app.use("/admin/*", adminAuth(adminToken));
  app.get("/admin/test", (c) => {
    return c.json({
      prefix: getAdminKeyPrefix(c),
      ip: getClientIp(c),
    });
  });
  return app;
}

describe("adminAuth middleware", () => {
  it("allows valid admin token", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer secret-admin-token" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects invalid token with 401", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing Authorization header", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test");
    expect(res.status).toBe(401);
  });

  it("rejects malformed Authorization header", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test", {
      headers: { Authorization: "InvalidFormat" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when admin token is not configured", async () => {
    const app = createTestApp("");
    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer anything" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("is case-insensitive for Bearer scheme", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test", {
      headers: { Authorization: "bearer secret-admin-token" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects stale admin JWT when user has been downgraded", async () => {
    const mockAuthService = {
      verifyToken: vi.fn().mockReturnValue({
        sub: 42,
        role: "admin",
        username: "downgraded-user",
        iat: 1,
        exp: 9999999999,
      }),
      getUserById: vi.fn().mockReturnValue({
        id: 42,
        username: "downgraded-user",
        role: "user",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_login_at: null,
        is_active: true,
      }),
    } as unknown as AuthService;

    const app = new Hono();
    app.use("/admin/*", adminAuth("secret-admin-token", mockAuthService));
    app.get("/admin/test", (c) => c.json({ ok: true }));

    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer stale-jwt-token" },
    });

    expect(res.status).toBe(401);
  });
});

describe("getAdminKeyPrefix", () => {
  it("extracts first 8 chars of token", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer secret-admin-token" },
    });
    const body = await res.json();
    expect(body.prefix).toBe("secret-a");
  });
});

describe("getClientIp", () => {
  it("extracts IP from X-Forwarded-For", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test", {
      headers: {
        Authorization: "Bearer secret-admin-token",
        "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
      },
    });
    const body = await res.json();
    expect(body.ip).toBe("1.2.3.4");
  });

  it("returns 'unknown' when no forwarded header", async () => {
    const app = createTestApp("secret-admin-token");
    const res = await app.request("/admin/test", {
      headers: { Authorization: "Bearer secret-admin-token" },
    });
    const body = await res.json();
    expect(body.ip).toBe("unknown");
  });
});
