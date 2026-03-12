import { useState, useEffect, useCallback } from "react";
import { adminApi } from "../api/client";
import { useI18n } from "../contexts/i18n";
import { Button, Card, Input, Toast, useConfirmDialog } from "../components/ui";
import { Settings, Save, RotateCcw } from "lucide-react";

// ========================== 变更记录 ==========================
// [日期]     2026-03-12
// [类型]     修复Bug
// [描述]     修复 Settings 页面在处理后端配置响应时的 unknown 类型构建错误，并显式只编辑扁平可序列化配置项。
// [思路]     先对后端返回值做对象窄化，再提取 effective 配置字典，避免直接对 unknown 调用 Object.entries。
// [影响范围] web/src/pages/Settings.tsx、web/src/api/client.ts（消费方式）
// [潜在风险] 若后端未来返回非对象结构，将安全回退为空配置列表，而不会造成页面崩溃。
// ==============================================================

interface ConfigData {
  [key: string]: unknown;
}

function isConfigMap(value: unknown): value is ConfigData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeConfigValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

export function SettingsPage() {
  const { t } = useI18n();
  const { confirm: confirmAction, dialog: confirmDialog } =
    useConfirmDialog();
  const [config, setConfig] = useState<ConfigData>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await adminApi.getConfig();
      const responseConfig = isConfigMap(res) ? res : {};
      // Backend returns { effective: {...}, defaults: {...}, overrides: {...} }
      // Use 'effective' as the editable config — it's the flat key-value map
      const configObj = isConfigMap(responseConfig.effective)
        ? responseConfig.effective
        : responseConfig;

      setConfig(configObj);

      const formData: Record<string, string> = {};
      for (const [key, val] of Object.entries(configObj)) {
        // Skip nested objects — only show primitive values
        if (val !== null && typeof val === "object") continue;
        formData[key] = serializeConfigValue(val);
      }
      setForm(formData);
    } catch {
      setToast({ message: t("settings.loadFailed"), type: "error" });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(form)) {
        // Try to parse as number
        const num = Number(val);
        if (!Number.isNaN(num) && val.trim() !== "") {
          updates[key] = num;
        } else if (val === "true") {
          updates[key] = true;
        } else if (val === "false") {
          updates[key] = false;
        } else {
          updates[key] = val;
        }
      }
      await adminApi.updateConfig(updates);
      setToast({ message: t("settings.saveSuccess"), type: "success" });
      fetchConfig();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : t("settings.saveFailed"),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const confirmed = await confirmAction({
      title: t("settings.confirmResetTitle"),
      description: t("settings.confirmResetDescription"),
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await adminApi.resetConfig();
      fetchConfig();
      setToast({ message: t("settings.resetSuccess"), type: "success" });
    } catch {
      setToast({ message: t("settings.resetFailed"), type: "error" });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  // Label formatting helper
  const formatLabel = (key: string): string =>
    key
      .replaceAll("_", " ")
      .replaceAll(/\b\w/g, (char) => char.toUpperCase());

  // Group config keys by category
  const configKeys = Object.keys(form).sort((left, right) =>
    left.localeCompare(right),
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("settings.title")}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {t("settings.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<RotateCcw size={16} />}
            onClick={handleReset}
          >
            {t("common.actions.resetDefaults")}
          </Button>
          <Button
            icon={<Save size={16} />}
            onClick={handleSave}
            loading={saving}
          >
            {t("common.actions.saveChanges")}
          </Button>
        </div>
      </div>

      <Card>
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-slate-100 text-slate-600">
            <Settings size={20} />
          </div>
          <h3 className="font-semibold text-slate-900">
            {t("settings.runtimeConfiguration")}
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {configKeys.map((key) => {
            const effectiveValue = config[key];
            const placeholder =
              effectiveValue === undefined
                ? undefined
                : `${t("common.status.default")}: ${serializeConfigValue(effectiveValue)}`;

            return (
              <Input
                key={key}
                label={formatLabel(key)}
                value={form[key] ?? ""}
                onChange={(e) =>
                  setForm((p) => ({ ...p, [key]: e.target.value }))
                }
                placeholder={placeholder}
              />
            );
          })}
        </div>

        {configKeys.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-4">
            {t("settings.noSettings")}
          </p>
        )}
      </Card>

      {confirmDialog}

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
