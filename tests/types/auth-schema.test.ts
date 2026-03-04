/**
 * @module tests/types/auth-schema
 * @description Auth Schema 验证测试。
 */

import { describe, it, expect } from "vitest";
import {
  LoginInputSchema,
  RegisterInputSchema,
  UpdateUserInputSchema,
  UserRole,
  ROLE_PERMISSIONS,
} from "../../src/types/auth-schema.js";

describe("Auth Schemas", () => {
  describe("LoginInputSchema", () => {
    it("should accept valid login input", () => {
      const result = LoginInputSchema.safeParse({
        username: "admin",
        password: "password123",
      });
      expect(result.success).toBe(true);
    });

    it("should reject short username", () => {
      const result = LoginInputSchema.safeParse({
        username: "a",
        password: "password123",
      });
      expect(result.success).toBe(false);
    });

    it("should reject short password", () => {
      const result = LoginInputSchema.safeParse({
        username: "admin",
        password: "12345",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty fields", () => {
      expect(LoginInputSchema.safeParse({}).success).toBe(false);
      expect(LoginInputSchema.safeParse({ username: "admin" }).success).toBe(
        false,
      );
      expect(LoginInputSchema.safeParse({ password: "pass123" }).success).toBe(
        false,
      );
    });
  });

  describe("RegisterInputSchema", () => {
    it("should accept valid username with alphanumeric and special chars", () => {
      expect(
        RegisterInputSchema.safeParse({
          username: "user-name_123",
          password: "pass123456",
        }).success,
      ).toBe(true);
      expect(
        RegisterInputSchema.safeParse({
          username: "Admin",
          password: "pass123456",
        }).success,
      ).toBe(true);
    });

    it("should reject username with invalid characters", () => {
      expect(
        RegisterInputSchema.safeParse({
          username: "user name",
          password: "pass123456",
        }).success,
      ).toBe(false);
      expect(
        RegisterInputSchema.safeParse({
          username: "user@name",
          password: "pass123456",
        }).success,
      ).toBe(false);
      expect(
        RegisterInputSchema.safeParse({
          username: "用户",
          password: "pass123456",
        }).success,
      ).toBe(false);
    });

    it("should enforce username length limits", () => {
      expect(
        RegisterInputSchema.safeParse({ username: "a", password: "pass123456" })
          .success,
      ).toBe(false);
      expect(
        RegisterInputSchema.safeParse({
          username: "a".repeat(65),
          password: "pass123456",
        }).success,
      ).toBe(false);
      expect(
        RegisterInputSchema.safeParse({
          username: "ab",
          password: "pass123456",
        }).success,
      ).toBe(true);
      expect(
        RegisterInputSchema.safeParse({
          username: "a".repeat(64),
          password: "pass123456",
        }).success,
      ).toBe(true);
    });
  });

  describe("UpdateUserInputSchema", () => {
    it("should accept partial updates", () => {
      expect(UpdateUserInputSchema.safeParse({ role: "admin" }).success).toBe(
        true,
      );
      expect(
        UpdateUserInputSchema.safeParse({ is_active: false }).success,
      ).toBe(true);
      expect(
        UpdateUserInputSchema.safeParse({ password: "newpass123" }).success,
      ).toBe(true);
      expect(UpdateUserInputSchema.safeParse({}).success).toBe(true);
    });

    it("should reject invalid role", () => {
      expect(
        UpdateUserInputSchema.safeParse({ role: "superadmin" }).success,
      ).toBe(false);
    });

    it("should reject short password", () => {
      expect(UpdateUserInputSchema.safeParse({ password: "123" }).success).toBe(
        false,
      );
    });
  });

  describe("UserRole", () => {
    it("should accept valid roles", () => {
      expect(UserRole.safeParse("admin").success).toBe(true);
      expect(UserRole.safeParse("user").success).toBe(true);
    });

    it("should reject invalid roles", () => {
      expect(UserRole.safeParse("superadmin").success).toBe(false);
      expect(UserRole.safeParse("").success).toBe(false);
      expect(UserRole.safeParse(123).success).toBe(false);
    });
  });

  describe("ROLE_PERMISSIONS", () => {
    it("should have correct structure", () => {
      expect(ROLE_PERMISSIONS).toHaveProperty("admin");
      expect(ROLE_PERMISSIONS).toHaveProperty("user");
      expect(Array.isArray(ROLE_PERMISSIONS.admin)).toBe(true);
      expect(Array.isArray(ROLE_PERMISSIONS.user)).toBe(true);
    });

    it("admin should be superset of user permissions", () => {
      for (const perm of ROLE_PERMISSIONS.user) {
        expect(ROLE_PERMISSIONS.admin).toContain(perm);
      }
    });
  });
});
