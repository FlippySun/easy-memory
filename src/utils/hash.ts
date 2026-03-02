/**
 * @module hash
 * @description SHA-256 content hash 计算 — 去重前必须先执行 trim() 并统一换行符。
 *
 * 铁律 [CORE_SCHEMA §3]: content_hash = SHA-256(normalizeForHash(截断后脱敏内容))
 */

import { createHash } from "node:crypto";

/**
 * 归一化文本用于 hash 计算。
 * 完整 8 步归一化流程 [CORE_SCHEMA §3]:
 * 1. 移除 BOM (\uFEFF)
 * 2. Unicode NFKC 归一化
 * 3. trim() 去除首尾空白
 * 4. 统一换行符为 \n（抹平 \r\n 和 \r）
 * 5. 移除不可见字符（零宽空格、零宽连接符、软连字符等）
 * 6. 移除每行末尾空白
 * 7. 合并连续空行为单个空行
 * 8. 行内连续空白 → 单个空格
 *
 * @param text - 原始文本
 * @returns 归一化后的文本
 */
export function normalizeForHash(text: string): string {
  return (
    text
      // Step 1: Remove BOM
      .replace(/^\uFEFF/, "")
      // Step 2: Unicode NFKC normalization
      .normalize("NFKC")
      // Step 3: Trim outer whitespace
      .trim()
      // Step 4: Unify line endings
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Step 5: Remove invisible characters (zero-width spaces, soft hyphens, etc.)
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g, "")
      // Step 6: Remove trailing whitespace per line
      .replace(/[^\S\n]+$/gm, "")
      // Step 7: Merge consecutive blank lines into a single blank line
      .replace(/\n{3,}/g, "\n\n")
      // Step 8: Collapse inline whitespace → single space
      .replace(/[^\S\n]+/g, " ")
  );
}

/**
 * 计算文本的 SHA-256 hash。
 * 内部先调用 normalizeForHash 归一化。
 *
 * @param text - 原始文本（通常为截断后的脱敏内容）
 * @returns 十六进制 SHA-256 hash 字符串
 */
export function computeHash(text: string): string {
  const normalized = normalizeForHash(text);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
