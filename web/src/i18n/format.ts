// ========================== 变更记录 ==========================
// [日期]     2026-03-11
// [类型]     新增功能
// [描述]     提供与应用语言绑定的日期时间与数字格式化辅助函数。
// [思路]     用显式 locale 包装浏览器原生格式化能力，避免界面语言与 `toLocale*()` 默认语言分裂。
// [影响范围] web/src/contexts/i18n.tsx、web/src/pages/*
// [潜在风险] 若页面绕过 helper 直接调用 `toLocale*()`，仍会出现混合语言；需要在验证阶段检索兜底。
// ==============================================================

import { DEFAULT_LOCALE, type SupportedLocale } from "./resources";

export type LocalizableValue = Date | string | number;

export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  if (locale === "en") return "en";
  return DEFAULT_LOCALE;
}

function toDate(value: LocalizableValue): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatDate(
  value: LocalizableValue,
  locale: SupportedLocale,
  options?: Intl.DateTimeFormatOptions,
): string {
  return toDate(value).toLocaleDateString(locale, options);
}

export function formatDateTime(
  value: LocalizableValue,
  locale: SupportedLocale,
  options?: Intl.DateTimeFormatOptions,
): string {
  return toDate(value).toLocaleString(locale, options);
}

export function formatNumber(
  value: number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions,
): string {
  return value.toLocaleString(locale, options);
}
