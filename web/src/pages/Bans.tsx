import { useState, useEffect, useCallback } from "react";
import { adminApi, type BanRecord } from "../api/client";
import {
  Button,
  Card,
  Table,
  Modal,
  Input,
  Badge,
  Toast,
  EmptyState,
} from "../components/ui";
import { ShieldBan, Plus, Trash2, Clock } from "lucide-react";

export function BansPage() {
  const [bans, setBans] = useState<BanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    target_type: "ip",
    target_value: "",
    reason: "",
    duration_hours: "",
  });
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const fetchBans = useCallback(async () => {
    try {
      const res = await adminApi.listBans();
      setBans(res.data ?? []);
    } catch {
      setToast({ message: "Failed to load bans", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBans();
  }, [fetchBans]);

  const handleCreate = async () => {
    if (!form.target_value.trim() || !form.reason.trim()) return;
    setCreating(true);
    try {
      await adminApi.createBan({
        target_type: form.target_type,
        target_value: form.target_value,
        reason: form.reason,
        ...(form.duration_hours
          ? { duration_hours: parseInt(form.duration_hours) }
          : {}),
      });
      setShowCreate(false);
      setForm({
        target_type: "ip",
        target_value: "",
        reason: "",
        duration_hours: "",
      });
      await fetchBans();
      setToast({ message: "Ban created", type: "success" });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to create ban",
        type: "error",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (ban: BanRecord) => {
    if (!confirm(`Remove ban for ${ban.target_value}?`)) return;
    if (actionLoading !== null) return;
    setActionLoading(ban.id);
    try {
      await adminApi.deleteBan(ban.id);
      setBans((prev) => prev.filter((b) => b.id !== ban.id));
      await fetchBans();
      setToast({ message: "Ban removed", type: "success" });
    } catch {
      setToast({ message: "Failed to remove ban", type: "error" });
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
          <h1 className="text-2xl font-bold text-slate-900">Bans</h1>
          <p className="text-sm text-slate-500 mt-1">Manage IP and key bans</p>
        </div>
        <Button icon={<Plus size={18} />} onClick={() => setShowCreate(true)}>
          Create Ban
        </Button>
      </div>

      <Card padding={false}>
        {bans.length === 0 ? (
          <EmptyState
            icon={<ShieldBan size={32} />}
            title="No Active Bans"
            description="No IP or key bans are currently active"
          />
        ) : (
          <Table
            columns={[
              {
                key: "target_type",
                title: "Type",
                render: (r) => (
                  <Badge variant={r.target_type === "ip" ? "info" : "warning"}>
                    {r.target_type}
                  </Badge>
                ),
              },
              {
                key: "target_value",
                title: "Target",
                render: (r) => (
                  <code className="text-xs bg-slate-100 px-2 py-0.5 rounded">
                    {r.target_value}
                  </code>
                ),
              },
              { key: "reason", title: "Reason" },
              {
                key: "expires_at",
                title: "Expires",
                render: (r) =>
                  r.expires_at ? (
                    <span className="flex items-center gap-1 text-xs">
                      <Clock size={14} />
                      {new Date(r.expires_at).toLocaleString()}
                    </span>
                  ) : (
                    <Badge variant="danger">Permanent</Badge>
                  ),
              },
              {
                key: "created_at",
                title: "Created",
                render: (r) => new Date(r.created_at).toLocaleDateString(),
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
                      title="Remove ban"
                    >
                      {isLoading ? (
                        <svg className="animate-spin w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
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
        title="Create Ban"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleCreate} loading={creating}>
              Create Ban
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">
              Target Type
            </label>
            <select
              value={form.target_type}
              onChange={(e) =>
                setForm((p) => ({ ...p, target_type: e.target.value }))
              }
              className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
            >
              <option value="ip">IP Address</option>
              <option value="key">API Key</option>
            </select>
          </div>
          <Input
            label="Target Value"
            value={form.target_value}
            onChange={(e) =>
              setForm((p) => ({ ...p, target_value: e.target.value }))
            }
            placeholder={
              form.target_type === "ip" ? "192.168.1.1" : "key-hash-prefix"
            }
          />
          <Input
            label="Reason"
            value={form.reason}
            onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
            placeholder="Reason for banning"
          />
          <Input
            label="Duration (hours, empty = permanent)"
            type="number"
            value={form.duration_hours}
            onChange={(e) =>
              setForm((p) => ({ ...p, duration_hours: e.target.value }))
            }
            placeholder="24"
          />
        </div>
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
