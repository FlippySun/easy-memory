import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  translations,
  type SupportedLocale,
} from "./resources";
import { normalizeLocale } from "./format";

// ========================== 变更记录 ==========================
// [日期]     2026-03-12
// [类型]     重构
// [描述]     将前端 i18n 底层引擎切换为 i18next，同时保留现有 TS 资源与上层 useI18n 包装接口。
// [思路]     通过 i18next + react-i18next 提供成熟的语言切换和插值能力，但继续复用现有资源对象，避免页面层大面积返工。
// [影响范围] web/src/contexts/i18n.tsx、web/src/main.tsx、web/src/pages/*、web/src/components/*
// [潜在风险] 若底层初始化早于浏览器 localStorage 可用时会回退默认中文；当前通过安全读取与 fallback 降低风险。
// ==============================================================

const resources = SUPPORTED_LOCALES.reduce<Resource>((accumulator, locale) => {
  accumulator[locale] = {
    translation: translations[locale],
  };
  return accumulator;
}, {});

function resolveInitialLocale(): SupportedLocale {
  const storedLocale = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
  return normalizeLocale(storedLocale);
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: resolveInitialLocale(),
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
    returnNull: false,
  });
}

export default i18n;
export {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  translations,
  type SupportedLocale,
  type TranslationTree,
} from "./resources";
export {
  normalizeLocale,
  formatDate,
  formatDateTime,
  formatNumber,
} from "./format";
