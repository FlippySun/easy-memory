import { useState, useEffect, useCallback } from "react";
import { adminApi } from "../api/client";
import { Button, Card, Input, Toast } from "../components/ui";
import { Settings, Save, RotateCcw } from "lucide-react";

interface ConfigData {
  [key: string]: unknown;
}

export function SettingsPage() {
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
      setConfig(res);
      // Convert config to string form fields
      const formData: Record<string, string> = {};
      const configObj = (res.config ?? res) as Record<string, unknown>;
      for (const [key, val] of Object.entries(configObj)) {
        formData[key] = String(val ?? "");
      }
      setForm(formData);
    } catch {
      setToast({ message: "Failed to load config", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

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
        if (!isNaN(num) && val.trim() !== "") {
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
      setToast({ message: "Config saved", type: "success" });
      fetchConfig();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to save",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm("Reset all configuration to defaults?")) return;
    try {
      await adminApi.resetConfig();
      fetchConfig();
      setToast({ message: "Config reset to defaults", type: "success" });
    } catch {
      setToast({ message: "Failed to reset config", type: "error" });
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
    key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Group config keys by category
  const configKeys = Object.keys(form).sort();
  void config; // referenced to avoid unused warning

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
          <p className="text-sm text-slate-500 mt-1">
            Runtime configuration management
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<RotateCcw size={16} />}
            onClick={handleReset}
          >
            Reset Defaults
          </Button>
          <Button
            icon={<Save size={16} />}
            onClick={handleSave}
            loading={saving}
          >
            Save Changes
          </Button>
        </div>
      </div>

      <Card>
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-slate-100 text-slate-600">
            <Settings size={20} />
          </div>
          <h3 className="font-semibold text-slate-900">
            Runtime Configuration
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {configKeys.map((key) => (
            <Input
              key={key}
              label={formatLabel(key)}
              value={form[key] ?? ""}
              onChange={(e) =>
                setForm((p) => ({ ...p, [key]: e.target.value }))
              }
            />
          ))}
        </div>

        {configKeys.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-4">
            No configurable settings available
          </p>
        )}
      </Card>

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
