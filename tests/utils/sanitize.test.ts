/**
 * @module sanitize.test
 * @description basicSanitize 单元测试 — 覆盖 AWS Key/JWT/PEM/DB 连接串脱敏
 */

import { describe, it, expect } from "vitest";
import { basicSanitize, isFullyRedacted } from "../../src/utils/sanitize.js";

describe("basicSanitize", () => {
  it("should not modify safe text", () => {
    const text = "This is a normal conversation about coding.";
    expect(basicSanitize(text)).toBe(text);
  });

  it("should redact AWS Access Key IDs", () => {
    const text = "My key is AKIAIOSFODNN7EXAMPLE ok";
    const result = basicSanitize(text);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("should redact JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const text = `Bearer ${jwt}`;
    const result = basicSanitize(text);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGciOi");
  });

  it("should redact PEM private keys", () => {
    const text = `Config:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF068lts
-----END RSA PRIVATE KEY-----
End`;
    const result = basicSanitize(text);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("should redact PEM public keys", () => {
    const text = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
-----END PUBLIC KEY-----`;
    const result = basicSanitize(text);
    expect(result).toContain("[REDACTED]");
  });

  it("should redact database connection strings", () => {
    const patterns = [
      "postgres://user:pass@host:5432/db",
      "postgresql://admin:secret@db.example.com/mydb",
      "mysql://root:password@localhost/test",
      "mongodb://user:pass@cluster.mongodb.net/db",
      "mongodb+srv://user:pass@cluster.example.com/db",
      "redis://default:pass@redis.example.com:6379",
    ];

    for (const conn of patterns) {
      const text = `Connect with ${conn} to start.`;
      const result = basicSanitize(text);
      expect(result).toContain("[REDACTED]");
      expect(result).not.toContain(conn);
    }
  });

  it("should redact generic API key patterns", () => {
    const patterns = [
      "api_key=abc123XYZ789longer",
      'secret_key: "mySecretValue1234"',
      "access_token=sk_live_abcdefghijklmnop",
      'password="DatabaseP4ssw0rd!"',
    ];

    for (const pattern of patterns) {
      const text = `Config: ${pattern} end`;
      const result = basicSanitize(text);
      expect(result).toContain("[REDACTED]");
    }
  });

  it("should handle multiple sensitive patterns in one text", () => {
    const text = `Key: AKIAIOSFODNN7EXAMPLE and conn: postgres://user:pass@host/db`;
    const result = basicSanitize(text);
    // Should not contain original sensitive data
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("postgres://");
  });

  it("should be idempotent — double sanitize produces same result", () => {
    const text = "Secret: AKIAIOSFODNN7EXAMPLE in postgres://u:p@h/d";
    const once = basicSanitize(text);
    const twice = basicSanitize(once);
    expect(twice).toBe(once);
  });
});

describe("isFullyRedacted", () => {
  it("should return false for normal text", () => {
    expect(isFullyRedacted("hello", "hello")).toBe(false);
  });

  it("should return true when all content is redacted", () => {
    expect(isFullyRedacted("secret", "[REDACTED]")).toBe(true);
  });

  it("should return false when partial content remains", () => {
    expect(
      isFullyRedacted("My key is AKIAIOSFODNN7EXAMPLE", "My key is [REDACTED]"),
    ).toBe(false);
  });

  it("should return false for empty original", () => {
    expect(isFullyRedacted("", "")).toBe(false);
  });

  it("should return true when only whitespace remains after redaction", () => {
    expect(isFullyRedacted("secret", "  [REDACTED]  ")).toBe(true);
  });
});
