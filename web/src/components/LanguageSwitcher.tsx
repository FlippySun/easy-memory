import { useI18n } from "../contexts/i18n";

// ========================== 变更记录 ==========================
// [日期]     2026-03-11
// [类型]     新增功能
// [描述]     提供登录态与未登录态共用的语言切换组件。
// [思路]     用同一组件复用到登录页、注册页和顶栏，确保用户在进入系统前后都能切换语言，避免出现“默认语言锁死”的断点。
// [影响范围] web/src/pages/Login.tsx、web/src/pages/Register.tsx、web/src/components/Layout.tsx
// [潜在风险] 若后续扩展语言数量增多，当前双按钮布局需要调整；当前仅针对中英文优化。
// ==============================================================

interface LanguageSwitcherProps {
  className?: string;
}

export function LanguageSwitcher({
  className = "",
}: Readonly<LanguageSwitcherProps>) {
  const { locale, setLocale, t } = useI18n();

  const options = [
    { value: "zh-CN" as const, label: t("common.language.zhCN") },
    { value: "en" as const, label: t("common.language.en") },
  ];

  return (
    <div
      className={`inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/90 p-1 shadow-sm ${className}`}
    >
      {options.map((option) => {
        const active = locale === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setLocale(option.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              active
                ? "bg-primary-600 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
            title={option.label}
            aria-label={`${t("common.language.label")}: ${option.label}`}
            aria-pressed={active}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
