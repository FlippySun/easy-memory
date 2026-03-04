import { useState, useEffect, useCallback } from "react";
import { authApi, type UserRecord } from "../api/client";
import { useAuth } from "../contexts/auth";
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
import {
  Users,
  Plus,
  Trash2,
  Shield,
  ShieldCheck,
  UserX,
  UserCheck,
} from "lucide-react";

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await authApi.listUsers();
      setUsers(res.users);
    } catch {
      setToast({ message: "Failed to load users", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreate = async () => {
    if (!form.username.trim() || !form.password.trim()) return;
    setCreating(true);
    try {
      await authApi.register(form.username, form.password);
      setShowCreate(false);
      setForm({ username: "", password: "" });
      await fetchUsers();
      setToast({ message: "User created", type: "success" });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to create user",
        type: "error",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleRoleToggle = async (user: UserRecord) => {
    const newRole = user.role === "admin" ? "user" : "admin";
    if (!confirm(`Change ${user.username}'s role to ${newRole}?`)) return;
    if (actionLoading !== null) return;
    setActionLoading(user.id);
    try {
      await authApi.updateUser(user.id, { role: newRole });
      await fetchUsers();
      setToast({ message: `Role changed to ${newRole}`, type: "success" });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to update role",
        type: "error",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleActive = async (user: UserRecord) => {
    if (actionLoading !== null) return;
    setActionLoading(user.id);
    try {
      await authApi.updateUser(user.id, { is_active: !user.is_active });
      await fetchUsers();
      setToast({
        message: user.is_active ? "User disabled" : "User enabled",
        type: "success",
      });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to update user",
        type: "error",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (user: UserRecord) => {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`))
      return;
    if (actionLoading !== null) return;
    setActionLoading(user.id);
    try {
      await authApi.deleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      await fetchUsers();
      setToast({ message: "User deleted", type: "success" });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to delete user",
        type: "error",
      });
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
          <h1 className="text-2xl font-bold text-slate-900">Users</h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage admin panel users and roles
          </p>
        </div>
        <Button icon={<Plus size={18} />} onClick={() => setShowCreate(true)}>
          Create User
        </Button>
      </div>

      <Card padding={false}>
        {users.length === 0 ? (
          <EmptyState
            icon={<Users size={32} />}
            title="No Users"
            description="No users have been created yet"
            action={
              <Button
                size="sm"
                icon={<Plus size={16} />}
                onClick={() => setShowCreate(true)}
              >
                Create User
              </Button>
            }
          />
        ) : (
          <Table
            columns={[
              {
                key: "username",
                title: "Username",
                render: (r) => (
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-semibold text-xs">
                      {r.username.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium">{r.username}</span>
                    {r.id === currentUser?.id && (
                      <Badge variant="info">You</Badge>
                    )}
                  </div>
                ),
              },
              {
                key: "role",
                title: "Role",
                render: (r) => (
                  <Badge variant={r.role === "admin" ? "warning" : "default"}>
                    <span className="flex items-center gap-1">
                      {r.role === "admin" ? (
                        <ShieldCheck size={12} />
                      ) : (
                        <Shield size={12} />
                      )}
                      {r.role}
                    </span>
                  </Badge>
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
                key: "last_login_at",
                title: "Last Login",
                render: (r) =>
                  r.last_login_at
                    ? new Date(r.last_login_at).toLocaleString()
                    : "Never",
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
                  const isSelf = r.id === currentUser?.id;
                  const isLoading = actionLoading === r.id;
                  return (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleRoleToggle(r)}
                        disabled={isSelf || isLoading}
                        className="p-1.5 rounded-md text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                        title={`Change to ${r.role === "admin" ? "user" : "admin"}`}
                      >
                        {r.role === "admin" ? (
                          <Shield size={18} />
                        ) : (
                          <ShieldCheck size={18} />
                        )}
                      </button>
                      <button
                        onClick={() => handleToggleActive(r)}
                        disabled={isSelf || isLoading}
                        className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                        title={r.is_active ? "Disable" : "Enable"}
                      >
                        {r.is_active ? (
                          <UserX size={18} />
                        ) : (
                          <UserCheck size={18} />
                        )}
                      </button>
                      <button
                        onClick={() => handleDelete(r)}
                        disabled={isSelf || isLoading}
                        className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                        title="Delete"
                      >
                        {isLoading ? (
                          <svg className="animate-spin w-4.5 h-4.5" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        ) : (
                          <Trash2 size={18} />
                        )}
                      </button>
                    </div>
                  );
                },
              },
            ]}
            data={users}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create User"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} loading={creating}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Username"
            value={form.username}
            onChange={(e) =>
              setForm((p) => ({ ...p, username: e.target.value }))
            }
            placeholder="e.g., john-doe"
            autoFocus
          />
          <Input
            label="Password"
            type="password"
            value={form.password}
            onChange={(e) =>
              setForm((p) => ({ ...p, password: e.target.value }))
            }
            placeholder="Min 6 characters"
          />
          <p className="text-xs text-slate-500">
            New users are created with the "user" role by default.
          </p>
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
