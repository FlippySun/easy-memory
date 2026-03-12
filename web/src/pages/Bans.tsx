import { useState, useEffect, useCallback } from "react";
import { adminApi, type BanRecord } from "../api/client";
import { useI18n } from "../contexts/i18n";
import {
  Button,
  Card,
  Table,
  Modal,
  Input,
  Badge,
  Toast,
  EmptyState,
  useConfirmDialog,
} from "../components/ui";
import { ShieldBan, Plus, Trash2, Clock } from "lucide-react";

export function BansPage() {
  const { t, formatDate, formatDateTime } = useI18n();
  const { confirm: confirmAction, dialog: confirmDialog } =
    useConfirmDialog();
  const [bans, setBans] = useState<BanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    type: "ip" as "ip" | "api_key",
    target: "",
    reason: "",
    durationHours: "",
  });
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchBans = useCallback(async () => {
    try {
      const res = await adminApi.listBans();
      setBans(res.data ?? []);
    } catch {
      setToast({ message: t("bans.createFailed"), type: "error" });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchBans();
  }, [fetchBans]);

  const handleCreate = async () => {
    if (!form.target.trim() || !form.reason.trim()) return;
    setCreating(true);
    try {
      const hours = Number.parseInt(form.durationHours, 10);
      await adminApi.createBan({
        type: form.type,
        target: form.target,
        reason: form.reason,
        ...(Number.isFinite(hours) && hours > 0
          ? { ttl_seconds: hours * 3600 }
          : {}),
      });
      setShowCreate(false);
      setForm({
        type: "ip",
        target: "",
        reason: "",
        durationHours: "",
      });
      await fetchBans();
      setToast({ message: t("bans.createSuccess"), type: "success" });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : t("bans.createFailed"),
        type: "error",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (ban: BanRecord) => {
    const confirmed = await confirmAction({
      title: t("bans.confirmRemoveTitle"),
      description: t("bans.confirmRemoveDescription", { target: ban.target }),
      variant: "danger",
    });
    if (!confirmed) return;
    if (actionLoading !== null) return;
    setActionLoading(ban.id);
    try {
      await adminApi.deleteBan(ban.id);
      setBans((prev) => prev.filter((b) => b.id !== ban.id));
      await fetchBans();
      setToast({ message: t("bans.removeSuccess"), type: "success" });
    } catch {
      setToast({ message: t("bans.removeFailed"), type: "error" });
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("bans.title")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("bans.description")}</p>
        </div>
        <Button icon={<Plus size={18} />} onClick={() => setShowCreate(true)}>
          {t("bans.createBan")}
        </Button>
      </div>

      <Card padding={false}>
        {bans.length === 0 ? (
          <EmptyState
            icon={<ShieldBan size={32} />}
            title={t("bans.noActiveBansTitle")}
            description={t("bans.noActiveBansDescription")}
          />
        ) : (
          <Table
            columns={[
              {
                key: "type",
                title: t("bans.type"),
                render: (r) => (
                  <Badge variant={r.type === "ip" ? "info" : "warning"}>
                    {r.type === "ip"
                      ? t("bans.targetTypeIp")
                      : t("bans.targetTypeApiKey")}
                  </Badge>
                ),
              },
              {
                key: "target",
                title: t("bans.target"),
                render: (r) => (
                  <code className="text-xs bg-slate-100 px-2 py-0.5 rounded">
                    {r.target}
                  </code>
                ),
              },
              { key: "reason", title: t("bans.reason") },
              {
                key: "expires_at",
                title: t("bans.expires"),
                render: (r) =>
                  r.expires_at ? (
                    <span className="flex items-center gap-1 text-xs">
                      <Clock size={14} />
                      {formatDateTime(r.expires_at)}
                    </span>
                  ) : (
                    <Badge variant="danger">{t("common.status.permanent")}</Badge>
                  ),
              },
              {
                key: "created_at",
                title: t("bans.created"),
                render: (r) => formatDate(r.created_at),
              },
              {
                key: "actions",
                title: "",
                className: "text-right",
                render: (r) => {
                  const isLoading = actionLoading === r.id;
                  return (
                    <button
                      onClick={() => handleDelete(r)}
                      disabled={isLoading}
                      className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      title={t("bans.removeTooltip")}
                    >
                      {isLoading ? (
                        <svg
                          className="animate-spin w-4.5 h-4.5"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
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
                      ) : (
                        <Trash2 size={18} />
                      )}
                    </button>
                  );
                },
              },
            ]}
            data={bans}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t("bans.createModalTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              {t("common.actions.cancel")}
            </Button>
            <Button variant="danger" onClick={handleCreate} loading={creating}>
              {t("bans.createBan")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              {t("bans.targetType")}
            </label>
            <select
              value={form.type}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  type: e.target.value as "ip" | "api_key",
                }))
              }
              className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
            >
              <option value="ip">{t("bans.targetTypeIp")}</option>
              <option value="api_key">{t("bans.targetTypeApiKey")}</option>
            </select>
          </div>
          <Input
            label={t("bans.targetValue")}
            value={form.target}
            onChange={(e) => setForm((p) => ({ ...p, target: e.target.value }))}
            placeholder={
              form.type === "ip"
                ? t("bans.targetValueIpPlaceholder")
                : t("bans.targetValueKeyPlaceholder")
            }
          />
          <Input
            label={t("bans.reasonLabel")}
            value={form.reason}
            onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
            placeholder={t("bans.reasonPlaceholder")}
          />
          <Input
            label={t("bans.duration")}
            type="number"
            value={form.durationHours}
            onChange={(e) =>
              setForm((p) => ({ ...p, durationHours: e.target.value }))
            }
            placeholder={t("bans.durationPlaceholder")}
          />
        </div>
      </Modal>

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
