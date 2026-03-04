/**
 * @module tests/services/auth
 * @description AuthService 单元测试 — 密码、JWT、用户 CRUD、RBAC。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  AuthService,
  hashPassword,
  verifyPassword,
  deriveJwtSecret,
  signJwt,
  verifyJwt,
} from "../../src/services/auth.js";
import type { JwtPayload } from "../../src/types/auth-schema.js";
import { ROLE_PERMISSIONS } from "../../src/types/auth-schema.js";

// =========================================================================
// Password Hashing
// =========================================================================

describe("Password Hashing", () => {
  it("should hash and verify password correctly", () => {
    const password = "test-password-123!";
    const hashed = hashPassword(password);

    // 格式: salt:hash
    expect(hashed).toContain(":");
    const [salt, hash] = hashed.split(":");
    expect(salt.length).toBe(64); // 32 bytes = 64 hex chars
    expect(hash.length).toBe(128); // 64 bytes = 128 hex chars

    // 验证
    expect(verifyPassword(password, hashed)).toBe(true);
  });

  it("should reject wrong password", () => {
    const hashed = hashPassword("correct-password");
    expect(verifyPassword("wrong-password", hashed)).toBe(false);
  });

  it("should generate unique salts", () => {
    const hash1 = hashPassword("same-password");
    const hash2 = hashPassword("same-password");
    expect(hash1).not.toBe(hash2); // Different salts
  });

  it("should reject malformed hash strings", () => {
    expect(verifyPassword("test", "no-colon")).toBe(false);
    expect(verifyPassword("test", "")).toBe(false);
    expect(verifyPassword("test", ":")).toBe(false);
  });
});

// =========================================================================
// JWT
// =========================================================================

describe("JWT", () => {
  const adminToken = "test-admin-token-for-jwt-derivation";
  const secret = deriveJwtSecret(adminToken);

  it("should derive consistent secret from admin token", () => {
    const secret2 = deriveJwtSecret(adminToken);
    expect(secret.equals(secret2)).toBe(true);
  });

  it("should derive different secrets for different tokens", () => {
    const otherSecret = deriveJwtSecret("different-token");
    expect(secret.equals(otherSecret)).toBe(false);
  });

  it("should sign and verify JWT", () => {
    const payload = { sub: 1, role: "admin" as const, username: "test-user" };
    const token = signJwt(payload, secret);

    // JWT 格式: header.payload.signature
    const parts = token.split(".");
    expect(parts.length).toBe(3);

    // 验证
    const verified = verifyJwt(token, secret);
    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe(1);
    expect(verified!.role).toBe("admin");
    expect(verified!.username).toBe("test-user");
    expect(verified!.iat).toBeGreaterThan(0);
    expect(verified!.exp).toBeGreaterThan(verified!.iat);
  });

  it("should reject JWT with wrong secret", () => {
    const payload = { sub: 1, role: "user" as const, username: "test" };
    const token = signJwt(payload, secret);
    const wrongSecret = deriveJwtSecret("wrong-token");
    expect(verifyJwt(token, wrongSecret)).toBeNull();
  });

  it("should reject expired JWT", () => {
    // Manually create an expired token
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const expiredPayload: JwtPayload = {
      sub: 1,
      role: "admin",
      username: "test",
      iat: Math.floor(Date.now() / 1000) - 7300,
      exp: Math.floor(Date.now() / 1000) - 100, // expired 100 seconds ago
    };
    const body = Buffer.from(JSON.stringify(expiredPayload)).toString(
      "base64url",
    );
    const { createHmac } = require("node:crypto");
    const sig = createHmac("sha256", secret)
      .update(`${header}.${body}`)
      .digest();
    const token = `${header}.${body}.${sig.toString("base64url")}`;

    expect(verifyJwt(token, secret)).toBeNull();
  });

  it("should reject malformed JWT", () => {
    expect(verifyJwt("not-a-jwt", secret)).toBeNull();
    expect(verifyJwt("a.b", secret)).toBeNull();
    expect(verifyJwt("a.b.c.d", secret)).toBeNull();
    expect(verifyJwt("", secret)).toBeNull();
  });

  it("should reject tampered JWT payload", () => {
    const payload = { sub: 1, role: "user" as const, username: "test" };
    const token = signJwt(payload, secret);
    const parts = token.split(".");

    // Tamper with payload
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    decoded.role = "admin"; // escalate role
    parts[1] = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const tampered = parts.join(".");

    expect(verifyJwt(tampered, secret)).toBeNull();
  });
});

// =========================================================================
// AuthService
// =========================================================================

describe("AuthService", () => {
  let db: Database.Database;
  let service: AuthService;

  beforeEach(() => {
    db = new Database(":memory:");
    service = new AuthService({
      adminToken: "test-admin-token-12345",
      adminUsername: "admin",
      adminPassword: "admin-pass-123",
    });
    service.open(db);
  });

  afterEach(() => {
    service.close();
    db.close();
  });

  describe("Admin Seeding", () => {
    it("should seed admin user on first open", () => {
      const users = service.listUsers();
      expect(users.length).toBe(1);
      expect(users[0].username).toBe("admin");
      expect(users[0].role).toBe("admin");
      expect(users[0].is_active).toBe(true);
    });

    it("should not duplicate admin on reopening", () => {
      // Reopen service
      const service2 = new AuthService({
        adminToken: "test-admin-token-12345",
        adminUsername: "admin",
        adminPassword: "admin-pass-123",
      });
      service2.open(db);

      const users = service2.listUsers();
      expect(users.length).toBe(1);
      service2.close();
    });

    it("should skip seeding without admin credentials", () => {
      const db2 = new Database(":memory:");
      const service2 = new AuthService({
        adminToken: "test-token",
      });
      service2.open(db2);

      const users = service2.listUsers();
      expect(users.length).toBe(0);
      service2.close();
      db2.close();
    });
  });

  describe("Login", () => {
    it("should login with correct credentials", () => {
      const result = service.login("admin", "admin-pass-123");
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBeTruthy();
      expect(result!.refreshToken).toBeTruthy();
      expect(result!.user.username).toBe("admin");
      expect(result!.user.role).toBe("admin");
      expect(result!.accessExpiresIn).toBe(900);
    });

    it("should reject wrong password", () => {
      const result = service.login("admin", "wrong-password");
      expect(result).toBeNull();
    });

    it("should reject non-existent user", () => {
      const result = service.login("nonexistent", "password");
      expect(result).toBeNull();
    });

    it("should reject disabled user", () => {
      // Register a regular user (not last admin) to test deactivation
      const newUser = service.register("test-user", "test-pass-123");
      expect(newUser).not.toBeNull();
      service.updateUser(newUser!.id, { is_active: false });
      const result = service.login("test-user", "test-pass-123");
      expect(result).toBeNull();
    });

    it("should update last_login_at on successful login", () => {
      service.login("admin", "admin-pass-123");
      const user = service.listUsers()[0];
      expect(user.last_login_at).not.toBeNull();
    });

    it("should return valid JWT on login", () => {
      const result = service.login("admin", "admin-pass-123");
      expect(result).not.toBeNull();

      const payload = service.verifyToken(result!.accessToken);
      expect(payload).not.toBeNull();
      expect(payload!.username).toBe("admin");
      expect(payload!.role).toBe("admin");
    });
  });

  describe("Register", () => {
    it("should register a new user", () => {
      const user = service.register("new-user", "new-pass-123");
      expect(user).not.toBeNull();
      expect(user!.username).toBe("new-user");
      expect(user!.role).toBe("user");
      expect(user!.is_active).toBe(true);
    });

    it("should reject duplicate username", () => {
      const result = service.register("admin", "any-password");
      expect(result).toBeNull();
    });

    it("should allow registering admin role user", () => {
      const user = service.register("new-admin", "password-123", "admin");
      expect(user).not.toBeNull();
      expect(user!.role).toBe("admin");
    });
  });

  describe("User CRUD", () => {
    it("should get user by ID", () => {
      const users = service.listUsers();
      const user = service.getUserById(users[0].id);
      expect(user).not.toBeNull();
      expect(user!.username).toBe("admin");
    });

    it("should return null for non-existent ID", () => {
      const user = service.getUserById(99999);
      expect(user).toBeNull();
    });

    it("should list all users", () => {
      service.register("user1", "pass-123456");
      service.register("user2", "pass-123456");
      const users = service.listUsers();
      expect(users.length).toBe(3); // admin + 2 new
    });

    it("should update user role", () => {
      const newUser = service.register("new-user", "pass-123456");
      const updated = service.updateUser(newUser!.id, { role: "admin" });
      expect(updated).not.toBeNull();
      expect(updated).not.toBe("last_admin");
      expect(
        (updated as Exclude<typeof updated, null | "last_admin">).role,
      ).toBe("admin");
    });

    it("should update user password", () => {
      const user = service.listUsers()[0];
      service.updateUser(user.id, { password: "new-password-123" });

      // Old password should fail
      expect(service.login("admin", "admin-pass-123")).toBeNull();
      // New password should work
      expect(service.login("admin", "new-password-123")).not.toBeNull();
    });

    it("should deactivate user", () => {
      // Use a regular user (not last admin) for deactivation test
      const newUser = service.register("deactivate-me", "pass-123456");
      const updated = service.updateUser(newUser!.id, { is_active: false });
      expect(updated).not.toBe("last_admin");
      expect(updated).not.toBeNull();
      expect((updated as any).is_active).toBe(false);
    });

    it("should not demote last admin (C4 FIX)", () => {
      const admin = service.listUsers().find((u) => u.role === "admin");
      const result = service.updateUser(admin!.id, { role: "user" });
      expect(result).toBe("last_admin");
    });

    it("should not deactivate last admin (C4 FIX)", () => {
      const admin = service.listUsers().find((u) => u.role === "admin");
      const result = service.updateUser(admin!.id, { is_active: false });
      expect(result).toBe("last_admin");
    });

    it("should allow demoting admin when another admin exists (C4 FIX)", () => {
      service.register("admin2", "pass-123456", "admin");
      const admin1 = service.listUsers().find((u) => u.username === "admin");
      const result = service.updateUser(admin1!.id, { role: "user" });
      expect(result).not.toBe("last_admin");
      expect(result).not.toBeNull();
      expect((result as any).role).toBe("user");
    });

    it("should delete user", () => {
      const newUser = service.register("to-delete", "pass-123456");
      const success = service.deleteUser(newUser!.id);
      expect(success).toBe(true);
      expect(service.getUserById(newUser!.id)).toBeNull();
    });

    it("should not delete last admin", () => {
      const admin = service.listUsers().find((u) => u.role === "admin");
      const success = service.deleteUser(admin!.id);
      expect(success).toBe(false);
    });

    it("should allow deleting admin when another admin exists", () => {
      const admin2 = service.register("admin2", "pass-123456", "admin");
      const admin1 = service.listUsers().find((u) => u.username === "admin");
      const success = service.deleteUser(admin1!.id);
      expect(success).toBe(true);

      // admin2 still exists
      expect(service.getUserById(admin2!.id)).not.toBeNull();
    });
  });

  describe("RBAC", () => {
    it("should return correct permissions for admin", () => {
      const perms = service.getPermissions("admin");
      expect(perms).toContain("users:list");
      expect(perms).toContain("keys:create");
      expect(perms).toContain("config:update");
    });

    it("should return limited permissions for user", () => {
      const perms = service.getPermissions("user");
      expect(perms).toContain("memory:save");
      expect(perms).toContain("keys:self");
      expect(perms).not.toContain("analytics:read");
      expect(perms).not.toContain("audit:read");
      expect(perms).not.toContain("users:list");
      expect(perms).not.toContain("keys:create");
      expect(perms).not.toContain("config:update");
    });

    it("should check permissions correctly", () => {
      expect(service.hasPermission("admin", "users:delete")).toBe(true);
      expect(service.hasPermission("user", "users:delete")).toBe(false);
      expect(service.hasPermission("admin", "memory:search")).toBe(true);
      expect(service.hasPermission("user", "memory:search")).toBe(true);
    });
  });

  describe("Token Verification", () => {
    it("should verify valid JWT tokens", () => {
      const loginResult = service.login("admin", "admin-pass-123");
      const payload = service.verifyToken(loginResult!.accessToken);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBeGreaterThan(0);
    });

    it("should reject invalid tokens", () => {
      expect(service.verifyToken("invalid-token")).toBeNull();
      expect(service.verifyToken("")).toBeNull();
    });
  });

  describe("User Count", () => {
    it("should return correct user count", () => {
      expect(service.getUserCount()).toBe(1);
      service.register("user1", "pass-123456");
      expect(service.getUserCount()).toBe(2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle close gracefully", () => {
      service.close();
      // After close, operations should return safe defaults
      expect(service.listUsers()).toEqual([]);
      expect(service.getUserCount()).toBe(0);
      expect(service.login("admin", "password")).toBeNull();
    });

    it("should handle concurrent operations", () => {
      // 快速连续操作不应崩溃
      for (let i = 0; i < 10; i++) {
        service.register(`user-${i}`, `pass-${i}-123456`);
      }
      expect(service.getUserCount()).toBe(11); // admin + 10
    });
  });
});

// =========================================================================
// ROLE_PERMISSIONS structure
// =========================================================================

describe("ROLE_PERMISSIONS", () => {
  it("admin should have all permissions that user has plus more", () => {
    for (const perm of ROLE_PERMISSIONS.user) {
      expect(ROLE_PERMISSIONS.admin).toContain(perm);
    }
    expect(ROLE_PERMISSIONS.admin.length).toBeGreaterThan(
      ROLE_PERMISSIONS.user.length,
    );
  });

  it("should have no duplicate permissions", () => {
    for (const role of ["admin", "user"] as const) {
      const perms = ROLE_PERMISSIONS[role];
      const unique = new Set(perms);
      expect(unique.size).toBe(perms.length);
    }
  });
});
