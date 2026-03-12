import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { useI18n } from "../contexts/i18n";

// ========================== 变更记录 ==========================
// [日期]     2026-03-11
// [类型]     新增功能
// [描述]     为共享 UI 组件接入多语言默认文案、确认对话能力与更稳定的交互语义。
// [思路]     把默认提示文案收口到共享层，减少页面级重复翻译；同时补上应用内确认流所需的基础设施，替代原生 confirm。
// [影响范围] web/src/pages/*、web/src/components/Layout.tsx
// [潜在风险] 若页面仍绕过共享能力继续使用原生 confirm 或硬编码文案，会出现局部语言不一致，需要在页面迁移阶段逐步收敛。
// ==============================================================

// =====================================================================
// Button
// =====================================================================

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading,
  icon,
  children,
  className = "",
  disabled,
  ...props
}: Readonly<ButtonProps>) {
  const base =
    "inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

  const variants = {
    primary:
      "bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500 shadow-sm",
    secondary:
      "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus:ring-primary-500 shadow-sm",
    danger:
      "bg-red-600 text-white hover:bg-red-700 focus:ring-red-500 shadow-sm",
    ghost:
      "text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:ring-primary-500",
  };

  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-2.5 text-base",
  };

  let leadingIcon: ReactNode = null;
  if (loading) {
    leadingIcon = (
      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    );
  } else if (icon) {
    leadingIcon = <span className="shrink-0">{icon}</span>;
  }

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {leadingIcon}
      {children}
    </button>
  );
}

// =====================================================================
// Input
// =====================================================================

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: ReactNode;
}

export function Input({
  label,
  error,
  icon,
  className = "",
  id,
  ...props
}: Readonly<InputProps>) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="space-y-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-slate-700"
        >
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
            {icon}
          </div>
        )}
        <input
          id={inputId}
          className={`
            block w-full rounded-lg border border-slate-300 bg-white
            px-3 py-2 text-sm text-slate-900 placeholder-slate-400
            focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none
            transition-all duration-200
            ${icon ? "pl-10" : ""}
            ${error ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : ""}
            ${className}
          `}
          {...props}
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

// =====================================================================
// Card
// =====================================================================

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: boolean;
  hover?: boolean;
}

export function Card({
  children,
  className = "",
  padding = true,
  hover = false,
}: Readonly<CardProps>) {
  return (
    <div
      className={`
        bg-white rounded-xl border border-slate-200 shadow-sm
        ${padding ? "p-6" : ""}
        ${hover ? "hover:shadow-md hover:border-slate-300 transition-shadow duration-200" : ""}
        ${className}
      `}
    >
      {children}
    </div>
  );
}

// =====================================================================
// Badge
// =====================================================================

interface BadgeProps {
  children: ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
}

export function Badge({
  children,
  variant = "default",
  className = "",
}: Readonly<BadgeProps>) {
  const variants = {
    default: "bg-slate-100 text-slate-700",
    success: "bg-emerald-50 text-emerald-700",
    warning: "bg-amber-50 text-amber-700",
    danger: "bg-red-50 text-red-700",
    info: "bg-blue-50 text-blue-700",
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

// =====================================================================
// StatCard
// =====================================================================

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ReactNode;
  trend?: { value: number; label: string };
}

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  trend,
}: Readonly<StatCardProps>) {
  return (
    <Card className="animate-fade-in">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p className="text-2xl font-bold text-slate-900">{value}</p>
          {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
          {trend && (
            <p
              className={`text-xs font-medium ${
                trend.value >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {trend.value >= 0 ? "+" : ""}
              {trend.value}% {trend.label}
            </p>
          )}
        </div>
        <div className="p-2.5 rounded-lg bg-primary-50 text-primary-600">
          {icon}
        </div>
      </div>
    </Card>
  );
}

// =====================================================================
// EmptyState
// =====================================================================

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: Readonly<EmptyStateProps>) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center animate-fade-in">
      <div className="p-3 rounded-full bg-slate-100 text-slate-400 mb-4">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-slate-900 mb-1">{title}</h3>
      <p className="text-sm text-slate-500 max-w-sm mb-4">{description}</p>
      {action}
    </div>
  );
}

// =====================================================================
// Modal
// =====================================================================

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: Readonly<ModalProps>) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-label={t("common.actions.close")}
      />
      <div className="relative bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg mx-4 animate-scale-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
            aria-label={t("common.actions.close")}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50/50 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

interface ConfirmDialogOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
}

interface ConfirmDialogState extends Required<ConfirmDialogOptions> {
  resolve: (result: boolean) => void;
}

export function useConfirmDialog() {
  const { t } = useI18n();
  const [state, setState] = useState<ConfirmDialogState | null>(null);

  const closeDialog = useCallback((result: boolean) => {
    setState((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  const confirm = useCallback(
    (options: ConfirmDialogOptions) =>
      new Promise<boolean>((resolve) => {
        setState({
          title: options.title,
          description: options.description,
          confirmLabel: options.confirmLabel ?? t("common.actions.confirm"),
          cancelLabel: options.cancelLabel ?? t("common.actions.cancel"),
          variant: options.variant ?? "primary",
          resolve,
        });
      }),
    [t],
  );

  const dialog = state ? (
    <Modal
      open
      onClose={() => closeDialog(false)}
      title={state.title}
      footer={
        <>
          <Button variant="secondary" onClick={() => closeDialog(false)}>
            {state.cancelLabel}
          </Button>
          <Button
            variant={state.variant === "danger" ? "danger" : "primary"}
            onClick={() => closeDialog(true)}
          >
            {state.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">{state.description}</p>
    </Modal>
  ) : null;

  return { confirm, dialog };
}

// =====================================================================
// Table
// =====================================================================

interface Column<T> {
  key: string;
  title: string;
  render?: (row: T) => ReactNode;
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string | number;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
}

export function Table<T>({
  columns,
  data,
  rowKey,
  emptyMessage,
  onRowClick,
}: Readonly<TableProps<T>>) {
  const { t } = useI18n();

  if (data.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-slate-500">
        {emptyMessage || t("common.table.noData")}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider ${col.className || ""}`}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((row) => (
            <tr
              key={rowKey(row)}
              className={`hover:bg-slate-50/80 transition-colors ${onRowClick ? "cursor-pointer" : ""}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`py-3 px-4 text-slate-700 ${col.className || ""}`}
                >
                    {col.render
                      ? col.render(row)
                      : (() => {
                          const rawValue = (row as Record<string, unknown>)[col.key];
                          if (rawValue === null || rawValue === undefined) {
                            return "";
                          }
                          if (
                            typeof rawValue === "string" ||
                            typeof rawValue === "number"
                          ) {
                            return rawValue;
                          }
                          if (typeof rawValue === "boolean") {
                            return t(
                              rawValue
                                ? "common.boolean.true"
                                : "common.boolean.false",
                            );
                          }
                          return JSON.stringify(rawValue);
                        })()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================
// Toast (simple notification)
// =====================================================================

interface ToastProps {
  message: string;
  type?: "success" | "error" | "info";
  onClose: () => void;
}

export function Toast({
  message,
  type = "info",
  onClose,
}: Readonly<ToastProps>) {
  const colors = {
    success: "bg-emerald-50 text-emerald-800 border-emerald-200",
    error: "bg-red-50 text-red-800 border-red-200",
    info: "bg-blue-50 text-blue-800 border-blue-200",
  };

  // Auto-dismiss: success/info after 3s, error after 5s
  useEffect(() => {
    const timeout = type === "error" ? 5000 : 3000;
    const timer = setTimeout(onClose, timeout);
    return () => clearTimeout(timer);
  }, [type, onClose]);

  return (
    <div
      className={`fixed top-4 right-4 z-100 flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg animate-slide-in ${colors[type]}`}
    >
      <p className="text-sm font-medium">{message}</p>
      <button
        onClick={onClose}
        className="p-0.5 rounded hover:bg-black/5 transition-colors cursor-pointer"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

// =====================================================================
// CopyableText — 带 hover 复制按钮的文本
// =====================================================================

interface CopyableTextProps {
  text: string;
  displayText?: string;
  className?: string;
  mono?: boolean;
}

export function CopyableText({
  text,
  displayText,
  className = "",
  mono = true,
}: Readonly<CopyableTextProps>) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={`group inline-flex items-center gap-1.5 cursor-pointer ${className}`}
      onClick={handleCopy}
      title={t("common.copy.click")}
      aria-label={t("common.copy.click")}
    >
      <span className={mono ? "font-mono text-xs" : ""}>
        {displayText ?? text}
      </span>
      <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0">
        {copied ? (
          <svg
            className="w-3.5 h-3.5 text-emerald-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
        ) : (
          <svg
            className="w-3.5 h-3.5 text-slate-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
      </span>
      {copied && (
        <span className="text-xs text-emerald-600 font-medium animate-fade-in">
          {t("common.copy.copied")}
        </span>
      )}
    </button>
  );
}
