import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import {
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  formatDate,
  formatDateTime,
  formatNumber,
  normalizeLocale,
  type SupportedLocale,
} from "../i18n";

// ========================== 变更记录 ==========================
// [日期]     2026-03-12
// [类型]     重构
// [描述]     将前端全局语言状态从自研字典实现切换到 i18next 驱动，同时保持 useI18n 的消费接口稳定。
// [思路]     通过独立 Context 包装 i18next，继续与 AuthProvider 解耦，并保持切换语言时不会触发认证链路重挂载。
// [影响范围] web/src/main.tsx、web/src/components/LanguageSwitcher.tsx、web/src/pages/*、web/src/components/*
// [潜在风险] 翻译 key 仍采用字符串路径，若拼写错误会回退为 key 自身；通过集中资源文件与残留扫描降低风险。
// ==============================================================

interface TranslateVariables {
  [key: string]: string | number | undefined;
}

interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  supportedLocales: readonly SupportedLocale[];
  t: (key: string, variables?: TranslateVariables) => string;
  formatDate: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatDateTime: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { t: translate, i18n: i18nInstance } = useTranslation();
  const locale = normalizeLocale(
    i18nInstance.resolvedLanguage ?? i18nInstance.language,
  );

  const t = useCallback(
    (key: string, variables?: TranslateVariables) =>
      String(translate(key, variables)),
    [translate],
  );

  useEffect(() => {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale;
    document.title = t("common.browserTitle");
  }, [locale, t]);

  const updateLocale = useCallback((nextLocale: SupportedLocale) => {
    i18n.changeLanguage(normalizeLocale(nextLocale)).catch(() => undefined);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: updateLocale,
      supportedLocales: SUPPORTED_LOCALES,
      t,
      formatDate: (value, options) => formatDate(value, locale, options),
      formatDateTime: (value, options) =>
        formatDateTime(value, locale, options),
      formatNumber: (value, options) => formatNumber(value, locale, options),
    }),
    [locale, updateLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
