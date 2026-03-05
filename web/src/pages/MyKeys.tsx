import { useState, useEffect, useCallback } from "react";
import {
  userKeysApi,
  type UserKeyRecord,
  type UserKeyCreateResponse,
} from "../api/client";
import { Button, Input, CopyableText } from "../components/ui";
import { Key, Plus, Trash2, Copy, Check, AlertCircle } from "lucide-react";

export default function MyKeys() {
  const [keys, setKeys] = useState<UserKeyRecord[]>([]);
  const [maxKeys, setMaxKeys] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create key state
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);

  // Newly created key (shown once)
  const [createdKey, setCreatedKey] = useState<UserKeyCreateResponse | null>(
    null,
  );
  const [copied, setCopied] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadKeys = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const res = await userKeysApi.list();
      setKeys(res.keys);
      setMaxKeys(res.max_keys);
      setError("");
    } catch (err) {
      if (!options?.silent) {
        setError(
          err instanceof Error ? err.message : "Failed to load API keys",
        );
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys().catch(() => undefined);
  }, [loadKeys]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const res = await userKeysApi.create(newKeyName.trim());
      setCreatedKey(res);
      setNewKeyName("");
      setShowCreate(false);

      let refreshOk = true;
      try {
        await loadKeys({ silent: true });
      } catch {
        refreshOk = false;
      }

      if (!refreshOk) {
        setError("Key created, but failed to refresh key list.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create key";
      if (msg.includes("max:") || msg.includes("409")) {
        setError(
          `You already have ${maxKeys} active API keys (maximum allowed).`,
        );
      } else {
        setError(msg);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (actionLoading !== null) return;
    if (
      !confirm(
        "Delete this API key from your list? You won't be able to recover it from My API Keys.",
      )
    ) {
      return;
    }
    setActionLoading(id);
    try {
      await userKeysApi.revoke(id);

      // 假删除后，用户侧列表应立即不可见
      setKeys((prev) => prev.filter((k) => k.id !== id));

      setCreatedKey(null);

      let refreshOk = true;
      try {
        await loadKeys({ silent: true });
      } catch {
        refreshOk = false;
      }

      if (!refreshOk) {
        setError("Key deleted from your list, but refresh failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete key");
    } finally {
      setActionLoading(null);
    }
  };

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const activeKeys = keys.filter((k) => k.is_active);

  /** 生成 MCP 配置 JSON 片段 */
  const getMcpConfig = (apiKey: string) =>
    JSON.stringify(
      {
        "easy-memory": {
          type: "stdio",
          command: "npx",
          args: ["-y", "easy-memory@latest"],
          env: {
            EASY_MEMORY_TOKEN: apiKey,
            EASY_MEMORY_URL: window.location.origin,
          },
        },
      },
      null,
      2,
    );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">My API Keys</h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage your API keys for MCP client connections ({activeKeys.length}
            /{maxKeys})
          </p>
        </div>

        {activeKeys.length < maxKeys && (
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Create Key
          </Button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Create Key Form */}
      {showCreate && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Create New API Key</h2>
          <div className="flex gap-3">
            <Input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g. Cursor, VS Code)"
              className="flex-1"
              maxLength={128}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <Button
              onClick={handleCreate}
              disabled={creating || !newKeyName.trim()}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setShowCreate(false);
                setNewKeyName("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Newly Created Key Alert */}
      {createdKey && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-6 space-y-4">
          <div className="flex items-start gap-2">
            <Check className="w-5 h-5 text-green-600 mt-0.5" />
            <div>
              <h3 className="font-semibold text-green-900">
                API Key Created Successfully
              </h3>
              <p className="text-sm text-green-700 mt-1">
                Copy your API key now — it won't be shown again!
              </p>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-green-300 p-3">
            <div className="flex items-center justify-between">
              <code className="text-sm font-mono text-slate-800 break-all">
                {createdKey.key}
              </code>
              <button
                onClick={() => copyToClipboard(createdKey.key, "key")}
                className="ml-2 p-1.5 rounded hover:bg-slate-100 shrink-0"
                title="Copy API Key"
              >
                {copied === "key" ? (
                  <Check className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4 text-slate-400" />
                )}
              </button>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-green-900 mb-2">
              MCP Client Configuration
            </h4>
            <p className="text-xs text-green-700 mb-2">
              Add this to your MCP client config (e.g. Claude Desktop, Cursor,
              VS Code):
            </p>
            <div className="bg-slate-900 rounded-lg p-4 relative">
              <pre className="text-sm text-green-400 font-mono overflow-x-auto whitespace-pre">
                {getMcpConfig(createdKey.key)}
              </pre>
              <button
                onClick={() =>
                  copyToClipboard(getMcpConfig(createdKey.key), "mcp")
                }
                className="absolute top-2 right-2 p-1.5 rounded bg-slate-700 hover:bg-slate-600"
                title="Copy MCP Config"
              >
                {copied === "mcp" ? (
                  <Check className="w-4 h-4 text-green-400" />
                ) : (
                  <Copy className="w-4 h-4 text-slate-400" />
                )}
              </button>
            </div>
          </div>

          <button
            onClick={() => setCreatedKey(null)}
            className="text-sm text-green-700 hover:text-green-800 underline"
          >
            I've saved my key, dismiss this
          </button>
        </div>
      )}

      {/* Keys List */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {keys.length === 0 ? (
          <div className="p-12 text-center">
            <Key className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <h3 className="text-lg font-medium text-slate-700">
              No API Keys Yet
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Create an API key to connect your MCP clients.
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                  Prefix
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                  Created
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                  Requests
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {keys.map((key) => (
                <tr key={key.id} className={key.is_active ? "" : "opacity-50"}>
                  <td className="px-6 py-4 text-sm font-medium text-slate-900">
                    {key.name}
                  </td>
                  <td className="px-6 py-4 text-sm font-mono text-slate-600">
                    <CopyableText
                      text={key.prefix}
                      displayText={`${key.prefix}...`}
                    />
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-500">
                    {new Date(key.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4">
                    {key.is_active ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                        Revoked
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-500">
                    {key.total_requests.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {key.is_active && (
                      <button
                        onClick={() => handleRevoke(key.id)}
                        disabled={actionLoading === key.id}
                        className="text-red-500 hover:text-red-700 p-1.5 rounded-md hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Revoke key"
                      >
                        {actionLoading === key.id ? (
                          <svg
                            className="animate-spin w-4 h-4"
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
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
