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
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await adminApi.listKeys();
      setKeys(res.data ?? []);
    } catch {
      setToast({ message: "Failed to load API keys", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const res = await adminApi.createKey({ name: newKeyName });
      setNewKeyResult(res.raw_key);
      setNewKeyName("");
      await fetchKeys();
      setToast({ message: "API key created", type: "success" });
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
    if (actionLoading !== null) return;
    setActionLoading(key.id);
    try {
      await adminApi.updateKey(key.id, { is_active: !key.is_active });
      await fetchKeys();
      setToast({
        message: `Key ${key.is_active ? "disabled" : "enabled"}`,
        type: "success",
      });
    } catch {
      setToast({ message: "Failed to update key", type: "error" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (key: ApiKeyRecord) => {
    if (!confirm(`Delete key "${key.name}"?`)) return;
    if (actionLoading !== null) return;
    setActionLoading(key.id);
    try {
      await adminApi.deleteKey(key.id);
      // Optimistic removal — immediately remove from UI, then refetch
      setKeys((prev) => prev.filter((k) => k.id !== key.id));
      await fetchKeys();
      setToast({ message: "Key deleted", type: "success" });
    } catch {
      setToast({ message: "Failed to delete key", type: "error" });
    } finally {
      setActionLoading(null);
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
                render: (r) => (
                  <Badge variant={r.is_active ? "success" : "danger"}>
                    {r.is_active ? "Active" : "Disabled"}
                  </Badge>
                ),
              },
              {
                key: "rate_limit_per_minute",
                title: "Rate Limit",
                render: (r) => `${r.rate_limit_per_minute}/min`,
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
                  return (
                    <div className="flex items-center justify-end gap-1">
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
                          <ToggleRight size={22} className="text-emerald-500" />
                        ) : (
                          <ToggleLeft size={22} className="text-slate-400" />
                        )}
                      </button>
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={isLoading}
                        className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Delete"
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
