/**
 * @module sanitize
 * @description 基础安全过滤 — 使用正则将敏感信息脱敏为 [REDACTED]。
 *
 * Phase 1 MVP 实现 [CORE_SCHEMA §7 #8]：
 * - AWS Access Key / Secret Key
 * - JWT Token
 * - PEM 密钥 (RSA/EC/DSA)
 * - 数据库连接串 (postgres://, mysql://, mongodb://, redis://)
 *
 * 铁律 [ADR: SEC-2]：安全不可妥协，脱敏失败则阻断写入。
 */

/** 脱敏正则模式集合 */
const SENSITIVE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // AWS Access Key ID (AKIA...)
  {
    name: "aws_access_key",
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
  },
  // D4-3: AWS Secret Access Key — require "aws" context prefix to avoid false positives
  {
    name: "aws_secret_key",
    pattern:
      /(?:aws[_-]?(?:secret[_-]?(?:access[_-]?)?key|SECRET_ACCESS_KEY))\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  // JWT Token (xxx.yyy.zzz, each part is base64url)
  {
    name: "jwt_token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // PEM 密钥块
  {
    name: "pem_key",
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC|EC|DSA)\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC|EC|DSA)\s+KEY-----/g,
  },
  // 数据库连接串 (postgres://, mysql://, mongodb://, redis://)
  {
    name: "db_connection_string",
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s"'`]+/gi,
  },
  // D4-7: Generic API key patterns — require minimum 16 chars to reduce false positives
  {
    name: "generic_secret_param",
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\s*[=:]\s*['"]?[A-Za-z0-9/+=_-]{16,}['"]?/gi,
  },
];

/**
 * 对内容进行基础安全脱敏。
 *
 * @param content - 原始内容
 * @returns 脱敏后的内容
 */
export function basicSanitize(content: string): string {
  // D4-5: Unicode NFKC normalization before pattern matching
  let sanitized = content.normalize("NFKC");

  for (const { pattern } of SENSITIVE_PATTERNS) {
    // 每次使用前重置 lastIndex（全局正则）
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  return sanitized;
}

/**
 * 检查内容是否被完全脱敏（全部变成 [REDACTED]）。
 * 如果是，说明原始内容几乎全是敏感信息，应拒绝存储。
 *
 * @param original - 原始内容
 * @param sanitized - 脱敏后内容
 * @returns true 如果有效内容被完全脱敏
 */
export function isFullyRedacted(original: string, sanitized: string): boolean {
  if (original.trim().length === 0) return false;

  // 移除所有 [REDACTED] 标记后，检查是否还有实质内容
  const remaining = sanitized
    .replace(/\[REDACTED\]/g, "")
    .replace(/\s+/g, "")
    .trim();

  return remaining.length === 0;
}
