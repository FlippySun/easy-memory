import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
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
import { useAuth } from "../contexts/auth";
import { useI18n } from "../contexts/i18n";

type ViewMode = "card" | "table";

type TranslateFunction = (
  key: string,
  variables?: Record<string, string | number | undefined>,
) => string;

function parseTagInput(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function getProjectSelectionDescription(
  statsLoading: boolean,
  stats: MemoryStatsResponse | null,
  t: TranslateFunction,
): string {
  if (statsLoading) {
    return t("memoryBrowser.selectProjectLoading");
  }

  return stats?.total_projects
    ? t("memoryBrowser.selectProjectWithProjects")
    : t("memoryBrowser.selectProjectEmpty");
}

interface MemoryContentSectionProps {
  loading: boolean;
  error: string | null;
  hasSelectedProject: boolean;
  projectSelectionDescription: string;
  stats: MemoryStatsResponse | null;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  memories: MemoryRecord[];
  viewMode: ViewMode;
  editingId: string | null;
  editForm: MemoryPatchBody;
  patchingIds: Set<string>;
  t: TranslateFunction;
  scopeColor: (scope: string) => string;
  lifecycleVariant: (lifecycle: string) => "success" | "warning" | "default";
  scopeLabel: (scope: string) => string;
  memoryTypeLabel: (memoryType: string) => string;
  lifecycleLabel: (lifecycle: string) => string;
  onSelectProject: (project: string) => void;
  onEditStart: (memory: MemoryRecord) => void;
  onEditCancel: () => void;
  onEditSave: (memory: MemoryRecord) => void | Promise<void>;
  onArchive: (memory: MemoryRecord) => void | Promise<void>;
  onEditFormChange: (updates: Partial<MemoryPatchBody>) => void;
}

function renderMemoryContentSection({
  loading,
  error,
  hasSelectedProject,
  projectSelectionDescription,
  stats,
  formatNumber,
  memories,
  viewMode,
  editingId,
  editForm,
  patchingIds,
  t,
  scopeColor,
  lifecycleVariant,
  scopeLabel,
  memoryTypeLabel,
  lifecycleLabel,
  onSelectProject,
  onEditStart,
  onEditCancel,
  onEditSave,
  onArchive,
  onEditFormChange,
}: MemoryContentSectionProps): ReactNode {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <div className="flex items-center gap-3 text-red-600">
          <AlertCircle size={20} />
          <p className="text-sm font-medium">{error}</p>
        </div>
      </Card>
    );
  }

  if (!hasSelectedProject) {
    return (
      <Card>
        <EmptyState
          icon={<Database size={32} />}
          title={t("memoryBrowser.selectProjectTitle")}
          description={projectSelectionDescription}
        />
        {stats?.collections.length ? (
          <div className="mt-4 flex flex-wrap gap-2 justify-center">
            {stats.collections.slice(0, 6).map((collection) => (
              <button
                key={collection.name}
                type="button"
                onClick={() => onSelectProject(collection.project)}
                className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <span>{collection.project}</span>
                <span className="text-xs text-slate-400">
                  {formatNumber(collection.points_count)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </Card>
    );
  }

  if (memories.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Database size={32} />}
          title={t("memoryBrowser.noMemoriesTitle")}
          description={t("memoryBrowser.noMemoriesDescription")}
        />
      </Card>
    );
  }

  if (viewMode === "card") {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {memories.map((memory) => (
          <Card key={memory.id}>
            <div className="space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${scopeColor(memory.memory_scope)}`}
                  >
                    {scopeLabel(memory.memory_scope)}
                  </span>
                  <Badge variant={lifecycleVariant(memory.lifecycle)}>
                    {lifecycleLabel(memory.lifecycle)}
                  </Badge>
                  <code className="text-xs text-slate-400">
                    {memoryTypeLabel(memory.memory_type)}
                  </code>
                </div>
                <div className="flex items-center gap-1">
                  {editingId === memory.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onEditSave(memory)}
                        disabled={patchingIds.has(memory.id)}
                        className="p-1 rounded hover:bg-green-50 text-green-600 cursor-pointer"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={onEditCancel}
                        className="p-1 rounded hover:bg-slate-100 text-slate-400 cursor-pointer"
                      >
                        <X size={14} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onEditStart(memory)}
                        className="p-1 rounded hover:bg-slate-100 text-slate-400 cursor-pointer"
                        title={t("memoryBrowser.edit")}
                      >
                        <Edit3 size={14} />
                      </button>
                      {memory.lifecycle === "active" && (
                        <button
                          type="button"
                          onClick={() => onArchive(memory)}
                          disabled={patchingIds.has(memory.id)}
                          className="p-1 rounded hover:bg-amber-50 text-amber-500 cursor-pointer"
                          title={t("memoryBrowser.archive")}
                        >
                          <Archive size={14} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <p className="text-sm text-slate-700 line-clamp-3">{memory.content}</p>

              {editingId === memory.id && (
                <div className="bg-slate-50 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-500 w-16">
                      {t("memoryBrowser.fieldWeight")}
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      step={0.5}
                      value={editForm.weight ?? memory.weight}
                      onChange={(event) =>
                        onEditFormChange({
                          weight: Number(event.target.value),
                        })
                      }
                      className="text-xs border border-slate-300 rounded px-2 py-1 w-20"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-500 w-16">
                      {t("memoryBrowser.fieldScope")}
                    </label>
                    <select
                      value={editForm.memory_scope ?? memory.memory_scope}
                      onChange={(event) =>
                        onEditFormChange({
                          memory_scope: event.target.value,
                        })
                      }
                      className="text-xs border border-slate-300 rounded px-2 py-1"
                    >
                      <option value="global">{t("memoryBrowser.scopes.global")}</option>
                      <option value="project">{t("memoryBrowser.scopes.project")}</option>
                      <option value="branch">{t("memoryBrowser.scopes.branch")}</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-500 w-16">
                      {t("memoryBrowser.fieldTags")}
                    </label>
                    <input
                      type="text"
                      value={(editForm.tags ?? memory.tags).join(", ")}
                      onChange={(event) =>
                        onEditFormChange({
                          tags: parseTagInput(event.target.value),
                        })
                      }
                      className="text-xs border border-slate-300 rounded px-2 py-1 flex-1"
                      placeholder={t("memoryBrowser.tagsPlaceholder")}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400">
                <span>{memory.project}</span>
                <span>·</span>
                <span>w={memory.weight}</span>
                {memory.device_id && (
                  <>
                    <span>·</span>
                    <span>{memory.device_id}</span>
                  </>
                )}
                {memory.git_branch && (
                  <>
                    <span>·</span>
                    <span>{memory.git_branch}</span>
                  </>
                )}
              </div>
              {memory.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap">
                  {memory.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-slate-300 font-mono">{memory.id}</p>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <Card padding={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                {t("memoryBrowser.content")}
              </th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                {t("memoryBrowser.project")}
              </th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                {t("memoryBrowser.scope")}
              </th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                {t("memoryBrowser.type")}
              </th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                {t("memoryBrowser.lifecycle")}
              </th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                {t("memoryBrowser.weight")}
              </th>
              <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">
                {t("memoryBrowser.actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {memories.map((memory) => (
              <tr key={memory.id} className="hover:bg-slate-50/80 transition-colors">
                <td className="py-3 px-4 text-slate-700 max-w-xs truncate">
                  {memory.content}
                </td>
                <td className="py-3 px-4 text-slate-700">{memory.project}</td>
                <td className="py-3 px-4">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${scopeColor(memory.memory_scope)}`}
                  >
                    {scopeLabel(memory.memory_scope)}
                  </span>
                </td>
                <td className="py-3 px-4 text-slate-500 text-xs">
                  {memoryTypeLabel(memory.memory_type)}
                </td>
                <td className="py-3 px-4">
                  <Badge variant={lifecycleVariant(memory.lifecycle)}>
                    {lifecycleLabel(memory.lifecycle)}
                  </Badge>
                </td>
                <td className="py-3 px-4 text-slate-700">{memory.weight}</td>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onEditStart(memory)}
                      className="p-1 rounded hover:bg-slate-100 text-slate-400 cursor-pointer"
                      title={t("memoryBrowser.edit")}
                    >
                      <Edit3 size={14} />
                    </button>
                    {memory.lifecycle === "active" && (
                      <button
                        type="button"
                        onClick={() => onArchive(memory)}
                        disabled={patchingIds.has(memory.id)}
                        className="p-1 rounded hover:bg-amber-50 text-amber-500 cursor-pointer"
                        title={t("memoryBrowser.archive")}
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
  );
}

export function MemoryBrowserPage() {
  const { user } = useAuth();
  const { t, formatNumber } = useI18n();
  const isAdmin = user?.role === "admin";
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
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
    lifecycle: "active",
    device_id: "",
    git_branch: "",
    tag: "",
  });

  const abortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);
  const fetchMemoriesRef = useRef<() => Promise<void>>(async () => {});
  const pageSize = 20;
  const selectedProject = filters.project.trim();

  const buildFilterParams = useCallback(
    (options: { alignWithBrowseDefaults?: boolean } = {}) => {
      const params = new URLSearchParams();
      const project = filters.project.trim();
      const lifecycle =
        filters.lifecycle || (options.alignWithBrowseDefaults ? "active" : "");

      if (project) params.set("project", project);
      if (filters.memory_scope)
        params.set("memory_scope", filters.memory_scope);
      if (filters.memory_type) params.set("memory_type", filters.memory_type);
      if (lifecycle) params.set("lifecycle", lifecycle);
      if (filters.device_id) params.set("device_id", filters.device_id);
      if (filters.git_branch) params.set("git_branch", filters.git_branch);
      if (filters.tag) params.set("tag", filters.tag);

      return params;
    },
    [filters],
  );

  const fetchMemories = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    try {
      const params = buildFilterParams({ alignWithBrowseDefaults: true });
      if (!params.get("project")) {
        setMemories([]);
        setNextOffset(null);
        return;
      }

      params.set("limit", String(pageSize));
      const currentOffset = offsets[pageIndex];
      if (currentOffset) params.set("offset", currentOffset);

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
          err instanceof ApiError ? err.message : t("memoryBrowser.loadFailed"),
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [buildFilterParams, offsets, pageIndex, t]);

  useEffect(() => {
    fetchMemoriesRef.current = fetchMemories;
  }, [fetchMemories]);

  useEffect(() => {
    fetchMemories();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchMemories]);

  useEffect(() => {
    statsAbortRef.current?.abort();
    const controller = new AbortController();
    statsAbortRef.current = controller;
    setStatsLoading(true);
    setStatsError(null);
    setStats(null);

    memoryApi
      .stats(buildFilterParams({ alignWithBrowseDefaults: true }).toString(), {
        signal: controller.signal,
      })
      .then((res) => {
        if (!controller.signal.aborted) {
          setStats(res);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setStats(null);
        setStatsError(
          err instanceof ApiError
            ? err.message
            : t("memoryBrowser.summaryLoadFailed"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setStatsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [buildFilterParams, t]);

  const goNext = () => {
    if (!nextOffset || loading) return;
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
    if (pageIndex <= 0 || loading) return;
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
      await fetchMemoriesRef.current();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("memoryBrowser.archiveFailed"),
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
      await fetchMemoriesRef.current();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("memoryBrowser.updateFailed"),
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

  const scopeLabel = (scope: string) => t(`memoryBrowser.scopes.${scope}`);
  const memoryTypeLabel = (memoryType: string) =>
    t(`memoryBrowser.types.${memoryType}`);
  const lifecycleLabel = (lifecycle: string) =>
    t(`memoryBrowser.lifecycles.${lifecycle}`);

  const hasSelectedProject = selectedProject.length > 0;
  const projectSelectionDescription = getProjectSelectionDescription(
    statsLoading,
    stats,
    t,
  );

  const contentSection = renderMemoryContentSection({
    loading,
    error,
    hasSelectedProject,
    projectSelectionDescription,
    stats,
    formatNumber,
    memories,
    viewMode,
    editingId,
    editForm,
    patchingIds,
    t,
    scopeColor,
    lifecycleVariant,
    scopeLabel,
    memoryTypeLabel,
    lifecycleLabel,
    onSelectProject: (project) => {
      setFilters((previous) => ({ ...previous, project }));
      resetPagination();
    },
    onEditStart: startEdit,
    onEditCancel: () => setEditingId(null),
    onEditSave: saveEdit,
    onArchive: handleArchive,
    onEditFormChange: (updates) =>
      setEditForm((previous) => ({
        ...previous,
        ...updates,
      })),
  });

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {t("memoryBrowser.title")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {isAdmin
              ? t("memoryBrowser.descriptionAdmin")
              : t("memoryBrowser.descriptionUser")}
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
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
              <p className="text-2xl font-bold text-slate-900">
                {formatNumber(stats.total_memories)}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {isAdmin
                  ? t("memoryBrowser.visibleMemories")
                  : t("memoryBrowser.yourVisibleMemories")}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
              <p className="text-2xl font-bold text-slate-900">
                {stats.total_projects}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {isAdmin
                  ? t("memoryBrowser.visibleProjects")
                  : t("memoryBrowser.yourVisibleProjects")}
              </p>
            </div>
            {stats.collections.slice(0, 2).map((col) => (
              <div
                key={col.name}
                className="bg-white rounded-xl border border-slate-200 p-4 text-center"
              >
                <p className="text-2xl font-bold text-slate-900">
                  {formatNumber(col.points_count)}
                </p>
                <p className="text-xs text-slate-500 mt-1 truncate">
                  {col.project}
                </p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            {selectedProject
              ? t("memoryBrowser.summaryCurrentFilters")
              : t("memoryBrowser.summaryAllVisible")}
          </p>
        </div>
      )}

      {statsError && (
        <Card>
          <div className="flex items-center gap-3 text-amber-700">
            <AlertCircle size={18} />
            <p className="text-sm font-medium">{statsError}</p>
          </div>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-700">
              {t("memoryBrowser.filters")}
            </span>
          </div>
          <input
            type="text"
            placeholder={t("memoryBrowser.projectPlaceholder")}
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
            <option value="">{t("memoryBrowser.allScopes")}</option>
            <option value="global">{t("memoryBrowser.scopes.global")}</option>
            <option value="project">{t("memoryBrowser.scopes.project")}</option>
            <option value="branch">{t("memoryBrowser.scopes.branch")}</option>
          </select>
          <select
            value={filters.memory_type}
            onChange={(e) => {
              setFilters((p) => ({ ...p, memory_type: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">{t("memoryBrowser.allTypes")}</option>
            <option value="long_term">{t("memoryBrowser.types.long_term")}</option>
            <option value="short_term">{t("memoryBrowser.types.short_term")}</option>
          </select>
          <select
            value={filters.lifecycle}
            onChange={(e) => {
              setFilters((p) => ({ ...p, lifecycle: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">{t("memoryBrowser.allLifecycle")}</option>
            <option value="active">{t("memoryBrowser.lifecycles.active")}</option>
            <option value="archived">{t("memoryBrowser.lifecycles.archived")}</option>
            <option value="deprecated">{t("memoryBrowser.lifecycles.deprecated")}</option>
          </select>
          <input
            type="text"
            placeholder={t("memoryBrowser.deviceIdPlaceholder")}
            value={filters.device_id}
            onChange={(e) => {
              setFilters((p) => ({ ...p, device_id: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-28 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <input
            type="text"
            placeholder={t("memoryBrowser.gitBranchPlaceholder")}
            value={filters.git_branch}
            onChange={(e) => {
              setFilters((p) => ({ ...p, git_branch: e.target.value }));
              resetPagination();
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-28 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <input
            type="text"
            placeholder={t("memoryBrowser.tagPlaceholder")}
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
      {contentSection}

      {/* Pagination */}
      {hasSelectedProject && !loading && !error && memories.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {t("common.pagination.page", { page: pageIndex + 1 })}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={goPrev}
              disabled={pageIndex === 0 || loading}
              className="p-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={goNext}
              disabled={!nextOffset || loading}
              className="p-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
