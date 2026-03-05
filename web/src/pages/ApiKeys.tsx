import { useState, useEffect, useCallback } from "react";
import { adminApi, type ApiKeyRecord } from "../api/client";
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

export function ApiKeysPage() {
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
        setToast({ message: "Failed to load API keys", type: "error" });
      }
      throw new Error("Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

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
          ? "API key created"
          : "API key created, but list refresh failed",
        type: refreshOk ? "success" : "error",
      });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to create key",
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

      setToast({
        message: refreshOk
          ? `Key ${key.is_active ? "disabled" : "enabled"}`
          : `Key ${key.is_active ? "disabled" : "enabled"}, but refresh failed`,
        type: refreshOk ? "success" : "error",
      });
    } catch {
      setToast({ message: "Failed to update key", type: "error" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (key: ApiKeyRecord) => {
    const isSecondStage = key.lifecycle_status === "soft_deleted";
    const confirmed = confirm(
      isSecondStage
        ? `Permanently hide key "${key.name}" from Admin UI? It will be physically purged after 30 days.`
        : `Soft-delete key "${key.name}"? It will disappear from My API Keys and user APIs, but remain visible to Admin.`,
    );
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
          ? "Key semi-deleted (hidden from Admin UI, purge in 30 days)"
          : "Key soft-deleted";

      setToast({
        message: refreshOk
          ? actionMsg
          : `${actionMsg}, but list refresh failed`,
        type: refreshOk ? "success" : "error",
      });
    } catch {
      setToast({ message: "Failed to delete key", type: "error" });
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = (key: ApiKeyRecord) => {
    switch (key.lifecycle_status) {
      case "active":
        return <Badge variant="success">Active</Badge>;
      case "disabled":
        return <Badge variant="warning">Disabled</Badge>;
      case "soft_deleted":
        return <Badge variant="info">Soft Deleted</Badge>;
      case "expired":
        return <Badge variant="default">Expired</Badge>;
      default:
        return <Badge variant="default">Unknown</Badge>;
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
          <h1 className="text-2xl font-bold text-slate-900">API Keys</h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage API keys for service authentication
          </p>
        </div>
        <Button icon={<Plus size={18} />} onClick={() => setShowCreate(true)}>
          Create Key
        </Button>
      </div>

      <Card padding={false}>
        {keys.length === 0 ? (
          <EmptyState
            icon={<Key size={32} />}
            title="No API Keys"
            description="Create your first API key to enable service authentication"
            action={
              <Button
                size="sm"
                icon={<Plus size={16} />}
                onClick={() => setShowCreate(true)}
              >
                Create Key
              </Button>
            }
          />
        ) : (
          <Table
            columns={[
              {
                key: "name",
                title: "Name",
                render: (r) => <span className="font-medium">{r.name}</span>,
              },
              {
                key: "prefix",
                title: "Prefix",
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
                title: "Status",
                render: (r) => getStatusBadge(r),
              },
              {
                key: "rate_limit_per_minute",
                title: "Rate Limit",
                render: (r) =>
                  r.rate_limit_per_minute
                    ? `${r.rate_limit_per_minute}/min`
                    : "Default",
              },
              {
                key: "total_requests",
                title: "Requests",
                render: (r) => r.total_requests.toLocaleString(),
              },
              {
                key: "last_used_at",
                title: "Last Used",
                render: (r) =>
                  r.last_used_at
                    ? new Date(r.last_used_at).toLocaleDateString()
                    : "Never",
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
                          title={r.is_active ? "Disable" : "Enable"}
                        >
                          {isLoading ? (
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
                          ) : r.is_active ? (
                            <ToggleRight
                              size={22}
                              className="text-emerald-500"
                            />
                          ) : (
                            <ToggleLeft size={22} className="text-slate-400" />
                          )}
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
                            ? "Semi Delete"
                            : "Soft Delete"
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
        title={newKeyResult ? "Key Created" : "Create API Key"}
        footer={
          newKeyResult ? (
            <Button
              onClick={() => {
                setShowCreate(false);
                setNewKeyResult(null);
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} loading={creating}>
                Create
              </Button>
            </>
          )
        }
      >
        {newKeyResult ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Copy this key now. You won't be able to see it again.
            </p>
            <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-200">
              <code className="flex-1 text-sm break-all">{newKeyResult}</code>
              <button
                onClick={() => copyKey(newKeyResult)}
                className="p-1.5 rounded-md hover:bg-slate-200 transition-colors cursor-pointer"
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
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="e.g., production-server"
            autoFocus
          />
        )}
      </Modal>

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
