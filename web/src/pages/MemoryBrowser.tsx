import { useState, useEffect, useCallback, useRef } from "react";
import {
  memoryApi,
  ApiError,
  type MemoryRecord,
  type MemoryStatsResponse,
  type MemoryPatchBody,
} from "../api/client";
import { Card, Badge, EmptyState } from "../components/ui";
import {
  Database,
  Filter,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Archive,
  Edit3,
  X,
  Check,
  LayoutGrid,
  List,
} from "lucide-react";

type ViewMode = "card" | "table";

export function MemoryBrowserPage() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [nextOffset, setNextOffset] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<string[]>([""]); // stack of offsets for pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<MemoryPatchBody>({});
  const [patchingIds, setPatchingIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState({
    project: "",
    memory_scope: "",
    memory_type: "",
    lifecycle: "",
    device_id: "",
    git_branch: "",
    tag: "",
  });

  const abortRef = useRef<AbortController | null>(null);
  const pageSize = 20;

  // Load stats on mount
  useEffect(() => {
    memoryApi
      .stats()
      .then(setStats)
      .catch(() => {});
  }, []);

  const fetchMemories = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      const currentOffset = offsets[pageIndex];
      if (currentOffset) params.set("offset", currentOffset);
      if (filters.project) params.set("project", filters.project);
      if (filters.memory_scope)
        params.set("memory_scope", filters.memory_scope);
      if (filters.memory_type) params.set("memory_type", filters.memory_type);
      if (filters.lifecycle) params.set("lifecycle", filters.lifecycle);
      if (filters.device_id) params.set("device_id", filters.device_id);
      if (filters.git_branch) params.set("git_branch", filters.git_branch);
      if (filters.tag) params.set("tag", filters.tag);

      const res = await memoryApi.browse(params.toString(), {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setMemories(res.memories);
        setNextOffset(res.next_offset);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(
          err instanceof ApiError ? err.message : "Failed to load memories",
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [pageIndex, offsets, filters]);

  useEffect(() => {
    fetchMemories();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchMemories]);

  const goNext = () => {
    if (!nextOffset) return;
    setOffsets((prev) => {
      const next = [...prev];
      if (next.length <= pageIndex + 1) {
        next.push(nextOffset);
      }
      return next;
    });
    setPageIndex((p) => p + 1);
  };

  const goPrev = () => {
    if (pageIndex <= 0) return;
    setPageIndex((p) => p - 1);
  };

  const resetPagination = () => {
    setOffsets([""]);
    setPageIndex(0);
  };

  const handleArchive = async (mem: MemoryRecord) => {
    setPatchingIds((prev) => new Set(prev).add(mem.id));
    try {
      await memoryApi.patch(mem.project, mem.id, { lifecycle: "archived" });
      await fetchMemories();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to archive memory",
      );
    } finally {
      setPatchingIds((prev) => {
        const next = new Set(prev);
        next.delete(mem.id);
        return next;
      });
    }
  };

  const startEdit = (mem: MemoryRecord) => {
    // Table view 空间不足以放编辑表单 — 自动切到 card view
    if (viewMode === "table") setViewMode("card");
    setEditingId(mem.id);
    setEditForm({
      weight: mem.weight,
      memory_scope: mem.memory_scope,
      memory_type: mem.memory_type,
      tags: mem.tags,
    });
  };

  const saveEdit = async (mem: MemoryRecord) => {
    setPatchingIds((prev) => new Set(prev).add(mem.id));
    try {
      await memoryApi.patch(mem.project, mem.id, editForm);
      setEditingId(null);
      await fetchMemories();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to update memory",
      );
    } finally {
      setPatchingIds((prev) => {
        const next = new Set(prev);
        next.delete(mem.id);
        return next;
      });
    }
  };

  const scopeColor = (scope: string) => {
    switch (scope) {
      case "global":
        return "text-purple-700 bg-purple-50";
      case "project":
        return "text-blue-700 bg-blue-50";
      case "branch":
        return "text-amber-700 bg-amber-50";
      default:
        return "text-slate-700 bg-slate-50";
    }
  };

  const lifecycleVariant = (lc: string) => {
    switch (lc) {
      case "active":
        return "success" as const;
      case "archived":
        return "warning" as const;
      default:
        return "default" as const;
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Memory Browser</h1>
          <p className="text-sm text-slate-500 mt-1">
            Browse, edit and manage stored memories
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode("card")}
            className={`p-2 rounded-lg border transition-colors cursor-pointer ${
              viewMode === "card"
                ? "bg-primary-50 border-primary-300 text-primary-700"
                : "border-slate-300 text-slate-400 hover:bg-slate-50"
            }`}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={`p-2 rounded-lg border transition-colors cursor-pointer ${
              viewMode === "table"
                ? "bg-primary-50 border-primary-300 text-primary-700"
                : "border-slate-300 text-slate-400 hover:bg-slate-50"
            }`}
          >
            <List size={16} />
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
            <p className="text-2xl font-bold text-slate-900">
              {stats.total_memories.toLocaleString()}
            </p>
            <p className="text-xs text-slate-500 mt-1">Total Memories</p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
            <p className="text-2xl font-bold text-slate-900">
              {stats.total_projects}
            </p>
            <p className="text-xs text-slate-500 mt-1">Projects</p>
          </div>
          {stats.collections.slice(0, 2).map((col) => (
            <div
              key={col.name}
              className="bg-white rounded-xl border border-slate-200 p-4 text-center"
            >
              <p className="text-2xl font-bold text-slate-900">
                {col.points_count.toLocaleString()}
              </p>
              <p className="text-xs text-slate-500 mt-1 truncate">{col.name}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-700">Filters:</span>
          </div>
          <input
            type="text"
            placeholder="Project"
            value={filters.project}
            onChange={(e) => {
              setFilters((p) => ({ ...p, project: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-32 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <select
            value={filters.memory_scope}
            onChange={(e) => {
              setFilters((p) => ({ ...p, memory_scope: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">All Scopes</option>
            <option value="global">global</option>
            <option value="project">project</option>
            <option value="branch">branch</option>
          </select>
          <select
            value={filters.memory_type}
            onChange={(e) => {
              setFilters((p) => ({ ...p, memory_type: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">All Types</option>
            <option value="long_term">long_term</option>
            <option value="short_term">short_term</option>
          </select>
          <select
            value={filters.lifecycle}
            onChange={(e) => {
              setFilters((p) => ({ ...p, lifecycle: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">All Lifecycle</option>
            <option value="active">active</option>
            <option value="archived">archived</option>
            <option value="deprecated">deprecated</option>
          </select>
          <input
            type="text"
            placeholder="Device ID"
            value={filters.device_id}
            onChange={(e) => {
              setFilters((p) => ({ ...p, device_id: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-28 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Git Branch"
            value={filters.git_branch}
            onChange={(e) => {
              setFilters((p) => ({ ...p, git_branch: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-28 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Tag"
            value={filters.tag}
            onChange={(e) => {
              setFilters((p) => ({ ...p, tag: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-28 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
        </div>
      </Card>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : error ? (
        <Card>
          <div className="flex items-center gap-3 text-red-600">
            <AlertCircle size={20} />
            <p className="text-sm font-medium">{error}</p>
          </div>
        </Card>
      ) : memories.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Database size={32} />}
            title="No Memories Found"
            description="No memories match the current filters"
          />
        </Card>
      ) : viewMode === "card" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {memories.map((mem) => (
            <Card key={mem.id}>
              <div className="space-y-3">
                {/* Header */}
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${scopeColor(mem.memory_scope)}`}
                    >
                      {mem.memory_scope}
                    </span>
                    <Badge variant={lifecycleVariant(mem.lifecycle)}>
                      {mem.lifecycle}
                    </Badge>
                    <code className="text-xs text-slate-400">
                      {mem.memory_type}
                    </code>
                  </div>
                  <div className="flex items-center gap-1">
                    {editingId === mem.id ? (
                      <>
                        <button
                          onClick={() => saveEdit(mem)}
                          disabled={patchingIds.has(mem.id)}
                          className="p-1 rounded hover:bg-green-50 text-green-600 cursor-pointer"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-1 rounded hover:bg-slate-100 text-slate-400 cursor-pointer"
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(mem)}
                          className="p-1 rounded hover:bg-slate-100 text-slate-400 cursor-pointer"
                          title="Edit"
                        >
                          <Edit3 size={14} />
                        </button>
                        {mem.lifecycle === "active" && (
                          <button
                            onClick={() => handleArchive(mem)}
                            disabled={patchingIds.has(mem.id)}
                            className="p-1 rounded hover:bg-amber-50 text-amber-500 cursor-pointer"
                            title="Archive"
                          >
                            <Archive size={14} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Content */}
                <p className="text-sm text-slate-700 line-clamp-3">
                  {mem.content}
                </p>

                {/* Edit form */}
                {editingId === mem.id && (
                  <div className="bg-slate-50 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-slate-500 w-16">
                        Weight
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.5}
                        value={editForm.weight ?? mem.weight}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            weight: Number(e.target.value),
                          }))
                        }
                        className="text-xs border border-slate-300 rounded px-2 py-1 w-20"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-slate-500 w-16">
                        Scope
                      </label>
                      <select
                        value={editForm.memory_scope ?? mem.memory_scope}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            memory_scope: e.target.value,
                          }))
                        }
                        className="text-xs border border-slate-300 rounded px-2 py-1"
                      >
                        <option value="global">global</option>
                        <option value="project">project</option>
                        <option value="branch">branch</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-slate-500 w-16">
                        Tags
                      </label>
                      <input
                        type="text"
                        value={(editForm.tags ?? mem.tags).join(", ")}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            tags: e.target.value
                              .split(",")
                              .map((t) => t.trim())
                              .filter(Boolean),
                          }))
                        }
                        className="text-xs border border-slate-300 rounded px-2 py-1 flex-1"
                        placeholder="comma separated"
                      />
                    </div>
                  </div>
                )}

                {/* Meta */}
                <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400">
                  <span>{mem.project}</span>
                  <span>·</span>
                  <span>w={mem.weight}</span>
                  {mem.device_id && (
                    <>
                      <span>·</span>
                      <span>{mem.device_id}</span>
                    </>
                  )}
                  {mem.git_branch && (
                    <>
                      <span>·</span>
                      <span>{mem.git_branch}</span>
                    </>
                  )}
                </div>
                {mem.tags.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {mem.tags.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-slate-300 font-mono">{mem.id}</p>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        /* Table View */
        <Card padding={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                    Content
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                    Project
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                    Scope
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                    Type
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                    Lifecycle
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                    Weight
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {memories.map((mem) => (
                  <tr
                    key={mem.id}
                    className="hover:bg-slate-50/80 transition-colors"
                  >
                    <td className="py-3 px-4 text-slate-700 max-w-xs truncate">
                      {mem.content}
                    </td>
                    <td className="py-3 px-4 text-slate-700">{mem.project}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${scopeColor(mem.memory_scope)}`}
                      >
                        {mem.memory_scope}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-500 text-xs">
                      {mem.memory_type}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={lifecycleVariant(mem.lifecycle)}>
                        {mem.lifecycle}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-slate-700">{mem.weight}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => startEdit(mem)}
                          className="p-1 rounded hover:bg-slate-100 text-slate-400 cursor-pointer"
                        >
                          <Edit3 size={14} />
                        </button>
                        {mem.lifecycle === "active" && (
                          <button
                            onClick={() => handleArchive(mem)}
                            disabled={patchingIds.has(mem.id)}
                            className="p-1 rounded hover:bg-amber-50 text-amber-500 cursor-pointer"
                          >
                            <Archive size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Page {pageIndex + 1}</p>
        <div className="flex items-center gap-2">
          <button
            onClick={goPrev}
            disabled={pageIndex === 0}
            className="p-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={goNext}
            disabled={!nextOffset}
            className="p-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
