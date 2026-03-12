import { useState, useEffect, useCallback, type ReactNode } from "react";
import { adminApi, type ApiKeyRecord } from "../api/client";
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
  CopyableText,
  useConfirmDialog,
} from "../components/ui";
import {
  Key,
  Plus,
  Copy,
  Check,
  Trash2,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";

// ========================== 变更记录 ==========================
// [日期]     2026-03-12
// [类型]     修复Bug
// [描述]     修复 API Keys 页面错误地从 lucide-react 导入 ReactNode 的构建问题。
// [思路]     ReactNode 属于 React 类型系统，应从 react 导入，避免第三方图标包类型出口变化导致构建失败。
// [影响范围] web/src/pages/ApiKeys.tsx
// [潜在风险] 无已知风险。
// ==============================================================

export function ApiKeysPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { confirm: confirmAction, dialog: confirmDialog } =
    useConfirmDialog();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const fetchKeys = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const res = await adminApi.listKeys();
      setKeys(res.data ?? []);
    } catch {
      if (!options?.silent) {
        setToast({ message: t("apiKeys.loadFailed"), type: "error" });
      }
      throw new Error(t("apiKeys.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchKeys().catch(() => undefined);
  }, [fetchKeys]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const res = await adminApi.createKey({ name: newKeyName });
      const createdKey = res.key ?? res.raw_key;
      if (!createdKey) {
        throw new Error("API key payload missing from create response");
      }
      setNewKeyResult(createdKey);
      setNewKeyName("");

      let refreshOk = true;
      try {
        await fetchKeys({ silent: true });
      } catch {
        refreshOk = false;
      }

      setToast({
        message: refreshOk
          ? t("apiKeys.createSuccess")
          : t("apiKeys.createRefreshFailed"),
        type: refreshOk ? "success" : "error",
      });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : t("apiKeys.createFailed"),
        type: "error",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (key: ApiKeyRecord) => {
    if (key.lifecycle_status === "soft_deleted") return;
    if (actionLoading !== null) return;
    setActionLoading(key.id);
    try {
      await adminApi.updateKey(key.id, { is_active: !key.is_active });

      setKeys((prev) =>
        prev.map((k) =>
          k.id === key.id
            ? {
                ...k,
                is_active: !k.is_active,
                revoked_at: k.is_active ? new Date().toISOString() : null,
                lifecycle_status: k.is_active ? "disabled" : "active",
              }
            : k,
        ),
      );

      let refreshOk = true;
      try {
        await fetchKeys({ silent: true });
      } catch {
        refreshOk = false;
      }

      const successMessage = key.is_active
        ? t("apiKeys.disabled")
        : t("apiKeys.enabled");
      const partialMessage = key.is_active
        ? t("apiKeys.disabledRefreshFailed")
        : t("apiKeys.enabledRefreshFailed");

      setToast({
        message: refreshOk ? successMessage : partialMessage,
        type: refreshOk ? "success" : "error",
      });
    } catch {
      setToast({ message: t("apiKeys.updateFailed"), type: "error" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (key: ApiKeyRecord) => {
    const isSecondStage = key.lifecycle_status === "soft_deleted";
    const confirmed = await confirmAction({
      title: t(
        isSecondStage
          ? "apiKeys.confirmSemiDeleteTitle"
          : "apiKeys.confirmSoftDeleteTitle",
      ),
      description: t(
        isSecondStage
          ? "apiKeys.confirmSemiDeleteDescription"
          : "apiKeys.confirmSoftDeleteDescription",
        { name: key.name },
      ),
      variant: "danger",
    });
    if (!confirmed) return;
    if (actionLoading !== null) return;
    setActionLoading(key.id);
    try {
      const res = await adminApi.deleteKey(key.id);

      if (res.deletion_stage === "semi_deleted") {
        setKeys((prev) => prev.filter((k) => k.id !== key.id));
      } else {
        setKeys((prev) =>
          prev.map((k) =>
            k.id === key.id
              ? {
                  ...k,
                  is_active: false,
                  soft_deleted_at:
                    res.key.soft_deleted_at ?? new Date().toISOString(),
                  lifecycle_status: "soft_deleted",
                }
              : k,
          ),
        );
      }

      let refreshOk = true;
      try {
        await fetchKeys({ silent: true });
      } catch {
        refreshOk = false;
      }

      const actionMsg =
        res.deletion_stage === "semi_deleted"
          ? t("apiKeys.semiDeleted")
          : t("apiKeys.softDeleted");

      setToast({
        message: refreshOk
          ? actionMsg
          : `${actionMsg}${t("apiKeys.deleteRefreshFailed")}`,
        type: refreshOk ? "success" : "error",
      });
    } catch {
      setToast({ message: t("apiKeys.deleteFailed"), type: "error" });
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = (key: ApiKeyRecord) => {
    switch (key.lifecycle_status) {
      case "active":
        return <Badge variant="success">{t("apiKeys.statuses.active")}</Badge>;
      case "disabled":
        return <Badge variant="warning">{t("apiKeys.statuses.disabled")}</Badge>;
      case "soft_deleted":
        return <Badge variant="info">{t("apiKeys.statuses.softDeleted")}</Badge>;
      case "expired":
        return <Badge variant="default">{t("apiKeys.statuses.expired")}</Badge>;
      default:
        return <Badge variant="default">{t("apiKeys.statuses.unknown")}</Badge>;
    }
  };

  const copyKey = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          <h1 className="text-2xl font-bold text-slate-900">
            {t("apiKeys.title")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {t("apiKeys.description")}
          </p>
        </div>
        <Button icon={<Plus size={18} />} onClick={() => setShowCreate(true)}>
          {t("apiKeys.createKey")}
        </Button>
      </div>

      <Card padding={false}>
        {keys.length === 0 ? (
          <EmptyState
            icon={<Key size={32} />}
            title={t("apiKeys.noKeysTitle")}
            description={t("apiKeys.noKeysDescription")}
            action={
              <Button
                size="sm"
                icon={<Plus size={16} />}
                onClick={() => setShowCreate(true)}
              >
                {t("apiKeys.createKey")}
              </Button>
            }
          />
        ) : (
          <Table
            columns={[
              {
                key: "name",
                title: t("apiKeys.name"),
                render: (r) => <span className="font-medium">{r.name}</span>,
              },
              {
                key: "prefix",
                title: t("apiKeys.prefix"),
                render: (r) => (
                  <CopyableText
                    text={r.prefix}
                    displayText={r.prefix}
                    className="bg-slate-100 px-2 py-0.5 rounded"
                  />
                ),
              },
              {
                key: "status",
                title: t("apiKeys.status"),
                render: (r) => getStatusBadge(r),
              },
              {
                key: "rate_limit_per_minute",
                title: t("apiKeys.rateLimit"),
                render: (r) =>
                  r.rate_limit_per_minute
                    ? `${r.rate_limit_per_minute}/min`
                    : t("apiKeys.defaultRate"),
              },
              {
                key: "total_requests",
                title: t("apiKeys.requests"),
                render: (r) => formatNumber(r.total_requests),
              },
              {
                key: "last_used_at",
                title: t("apiKeys.lastUsed"),
                render: (r) =>
                  r.last_used_at
                    ? formatDate(r.last_used_at)
                    : t("common.status.never"),
              },
              {
                key: "actions",
                title: "",
                className: "text-right",
                render: (r) => {
                  const isLoading = actionLoading === r.id;
                  const canToggle =
                    r.lifecycle_status === "active" ||
                    r.lifecycle_status === "disabled";
                  let toggleIcon: ReactNode;
                  if (isLoading) {
                    toggleIcon = (
                      <svg
                        className="animate-spin w-5 h-5"
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
                    );
                  } else if (r.is_active) {
                    toggleIcon = (
                      <ToggleRight size={22} className="text-emerald-500" />
                    );
                  } else {
                    toggleIcon = <ToggleLeft size={22} className="text-slate-400" />;
                  }

                  return (
                    <div className="flex items-center justify-end gap-1">
                      {canToggle ? (
                        <button
                          onClick={() => handleToggle(r)}
                          disabled={isLoading}
                          className={`p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                            r.is_active
                              ? "text-emerald-500 hover:text-amber-600 hover:bg-amber-50"
                              : "text-slate-400 hover:text-emerald-600 hover:bg-emerald-50"
                          }`}
                          title={
                            r.is_active
                              ? t("apiKeys.actions.disable")
                              : t("apiKeys.actions.enable")
                          }
                        >
                          {toggleIcon}
                        </button>
                      ) : (
                        <div className="w-8 h-8" />
                      )}
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={isLoading}
                        className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        title={
                          r.lifecycle_status === "soft_deleted"
                            ? t("apiKeys.actions.semiDelete")
                            : t("apiKeys.actions.softDelete")
                        }
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  );
                },
              },
            ]}
            data={keys}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      {/* Create Modal */}
      <Modal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          setNewKeyResult(null);
          setNewKeyName("");
        }}
        title={
          newKeyResult
            ? t("apiKeys.createdModalTitle")
            : t("apiKeys.createModalTitle")
        }
        footer={
          newKeyResult ? (
            <Button
              onClick={() => {
                setShowCreate(false);
                setNewKeyResult(null);
              }}
            >
              {t("common.actions.done")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setShowCreate(false)}>
                {t("common.actions.cancel")}
              </Button>
              <Button onClick={handleCreate} loading={creating}>
                {t("common.actions.create")}
              </Button>
            </>
          )
        }
      >
        {newKeyResult ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              {t("apiKeys.createdDescription")}
            </p>
            <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-200">
              <code className="flex-1 text-sm break-all">{newKeyResult}</code>
              <button
                onClick={() => copyKey(newKeyResult)}
                className="p-1.5 rounded-md hover:bg-slate-200 transition-colors cursor-pointer"
                title={t("common.actions.copy")}
              >
                {copied ? (
                  <Check size={16} className="text-emerald-600" />
                ) : (
                  <Copy size={16} className="text-slate-500" />
                )}
              </button>
            </div>
          </div>
        ) : (
          <Input
            label={t("apiKeys.keyName")}
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder={t("apiKeys.keyNamePlaceholder")}
            autoFocus
          />
        )}
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
