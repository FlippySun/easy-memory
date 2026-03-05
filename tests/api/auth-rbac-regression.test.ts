/**
 * @module tests/api/auth-rbac-regression
 * @description RBAC 回归测试 — 角色降级后旧 JWT 不得继续访问 admin 端点。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { AuthService } from "../../src/services/auth.js";
import { createAuthRoutes } from "../../src/api/auth-routes.js";

describe("RBAC regression: role downgrade visibility", () => {
  let db: Database.Database;
  let authService: AuthService;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    authService = new AuthService({
      adminToken: "test-admin-token-for-rbac-regression",
      adminUsername: "seed_admin",
      adminPassword: "SeedAdminPass123",
    });
    authService.open(db);

    app = new Hono();
    app.route(
      "/api/auth",
      createAuthRoutes({
        authService,
        adminToken: "test-admin-token-for-rbac-regression",
        trustProxy: false,
        secureCookies: false,
      }),
    );
  });

  afterEach(() => {
    authService.close();
    db.close();
  });

  it("rejects /api/auth/users when token claim is admin but DB role is downgraded to user", async () => {
    const testAdmin = authService.register(
      "downgrade_target",
      "PasswordA1b",
      "admin",
    );
    expect(testAdmin).not.toBeNull();

    const loginResult = authService.login("downgrade_target", "PasswordA1b");
    expect(loginResult).not.toBeNull();

    const downgradeResult = authService.updateUser(testAdmin!.id, {
      role: "user",
    });

    expect(downgradeResult).not.toBeNull();
    expect(downgradeResult).not.toBe("last_admin");

    const res = await app.request("/api/auth/users", {
      headers: {
        Authorization: `Bearer ${loginResult!.accessToken}`,
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("admin role required");
  });
});
