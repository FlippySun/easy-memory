import { useState, useEffect, useCallback, useRef } from "react";
import { adminApi, ApiError, type AdminAuditLogEntry } from "../api/client";
import { Card, Table, Badge, EmptyState } from "../components/ui";
import {
  ScrollText,
  Filter,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  X,
  ExternalLink,
} from "lucide-react";
import { useAuth } from "../contexts/auth";
import { useI18n } from "../contexts/i18n";

// ========================== 变更记录 ==========================
// [日期]     2026-03-12
// [类型]     修复Bug
// [描述]     收敛 Audit Logs 页面残留的硬编码标题与空态占位值，保证审计页头部与表格回退值也跟随当前语言。
// [思路]     复用现有翻译 key 与 `common.emptyValue`，只修正显示层，不改动审计查询与详情抽屉逻辑。
// [影响范围] web/src/pages/AuditLogs.tsx、web/src/i18n/resources.ts
// [潜在风险] 若后端返回新的 outcome 或 memory_scope 枚举值，动态 key 仍会回退为原 key；本次不改变该既有行为。
// ==============================================================

export function AuditLogsPage() {
  const { user } = useAuth();
  const { t, formatDateTime, formatNumber } = useI18n();
  const isAdmin = user?.role === "admin";
  const emptyValue = t("common.emptyValue");
  const [logs, setLogs] = useState<AdminAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    operation: "",
    outcome: "",
    device_id: "",
    git_branch: "",
    memory_scope: "",
  });
  const [selectedEvent, setSelectedEvent] = useState<AdminAuditLogEntry | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const pageSize = 50;
  const abortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);

  const closeDetail = useCallback(() => {
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    setDetailLoading(false);
    setSelectedEvent(null);
  }, []);

  const fetchLogs = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      if (filters.operation) params.set("operation", filters.operation);
      if (filters.outcome) params.set("outcome", filters.outcome);
      if (filters.device_id) params.set("device_id", filters.device_id);
      if (filters.git_branch) params.set("git_branch", filters.git_branch);
      if (filters.memory_scope)
        params.set("memory_scope", filters.memory_scope);

      const res = await adminApi.getAuditLogs(params.toString(), {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setLogs(res.data ?? res.logs ?? []);
        setTotal(res.pagination?.total_count ?? res.total ?? 0);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(
          err instanceof ApiError ? err.message : t("audit.loadFailed"),
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [filters, page, t]);

  useEffect(() => {
    fetchLogs();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / pageSize);

  useEffect(() => {
    closeDetail();
  }, [page, filters, closeDetail]);

  useEffect(() => {
    return () => {
      detailAbortRef.current?.abort();
    };
  }, []);

  const handleRowClick = useCallback(async (entry: AdminAuditLogEntry) => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;

    setDetailLoading(true);
    setSelectedEvent(entry);
    try {
      const res = await adminApi.getAuditEventDetail(entry.event_id, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setSelectedEvent(res.data);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // fall back to basic entry already set
    } finally {
      if (!controller.signal.aborted) {
        setDetailLoading(false);
      }
    }
  }, []);

  const outcomeVariant = (outcome: string) => {
    switch (outcome) {
      case "success":
        return "success";
      case "error":
        return "danger";
      case "rejected":
      case "unauthorized":
      case "rate_limited":
        return "warning";
      default:
        return "default";
    }
  };

  const latencyClassName = (elapsedMs: number) => {
    if (elapsedMs > 1000) return "text-red-600";
    if (elapsedMs > 500) return "text-amber-600";
    return "text-emerald-600";
  };

  let tableContent: React.ReactNode;
  if (loading) {
    tableContent = (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary-600 border-t-transparent" />
      </div>
    );
  } else if (error) {
    tableContent = (
      <div className="flex items-center gap-3 text-red-600 p-6">
        <AlertCircle size={20} />
        <p className="text-sm font-medium">{error}</p>
      </div>
    );
  } else if (logs.length === 0) {
    tableContent = (
      <EmptyState
        icon={<ScrollText size={32} />}
        title={t("audit.noLogsTitle")}
        description={t("audit.noLogsDescription")}
      />
    );
  } else {
    tableContent = (
      <Table
        columns={[
          {
            key: "timestamp",
            title: t("audit.time"),
            render: (r) => (
              <span className="text-xs whitespace-nowrap">
                {formatDateTime(r.timestamp)}
              </span>
            ),
          },
          {
            key: "operation",
            title: t("audit.operation"),
            render: (r) => (
              <code className="text-xs bg-slate-100 px-2 py-0.5 rounded">
                {r.operation}
              </code>
            ),
          },
          {
            key: "outcome",
            title: t("audit.outcome"),
            render: (r) => (
              <Badge variant={outcomeVariant(r.outcome)}>
                {t(`common.outcomes.${r.outcome}`)}
              </Badge>
            ),
          },
          {
            key: "project",
            title: t("audit.project"),
            render: (r) => r.project || emptyValue,
          },
          {
            key: "key_prefix",
            title: t("audit.key"),
            render: (r) =>
              r.key_prefix ? <code className="text-xs">{r.key_prefix}</code> : emptyValue,
          },
          {
            key: "client_ip",
            title: t("audit.clientIp"),
            render: (r) => <span className="text-xs">{r.client_ip}</span>,
          },
          {
            key: "latency_ms",
            title: t("audit.latency"),
            render: (r) => (
              <span
                className={`text-xs font-medium ${latencyClassName(r.elapsed_ms)}`}
              >
                {r.elapsed_ms}ms
              </span>
            ),
          },
          {
            key: "error_message",
            title: t("audit.error"),
            render: (r) =>
              r.outcome !== "success" && r.outcome_detail ? (
                <span
                  className="text-xs text-red-600 max-w-50 truncate block"
                  title={r.outcome_detail}
                >
                  {r.outcome_detail}
                </span>
              ) : null,
          },
        ]}
        data={logs}
        rowKey={(r) => r.event_id}
        onRowClick={handleRowClick}
      />
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t("audit.title")}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {isAdmin
            ? t("audit.descriptionAdmin")
            : t("audit.descriptionUser")}
        </p>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-700">
              {t("audit.filters")}
            </span>
          </div>
          <select
            value={filters.operation}
            onChange={(e) => {
              setFilters((p) => ({ ...p, operation: e.target.value }));
              setPage(1);
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">{t("audit.allOperations")}</option>
            <option value="memory_save">memory_save</option>
            <option value="memory_search">memory_search</option>
            <option value="memory_forget">memory_forget</option>
            <option value="memory_status">memory_status</option>
          </select>
          <select
            value={filters.outcome}
            onChange={(e) => {
              setFilters((p) => ({ ...p, outcome: e.target.value }));
              setPage(1);
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">{t("audit.allOutcomes")}</option>
            <option value="success">{t("common.outcomes.success")}</option>
            <option value="error">{t("common.outcomes.error")}</option>
            <option value="rejected">{t("common.outcomes.rejected")}</option>
            <option value="unauthorized">{t("common.outcomes.unauthorized")}</option>
            <option value="rate_limited">{t("common.outcomes.rate_limited")}</option>
          </select>
          <input
            type="text"
            placeholder={t("audit.placeholders.deviceId")}
            value={filters.device_id}
            onChange={(e) => {
              setFilters((p) => ({ ...p, device_id: e.target.value }));
              setPage(1);
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-32 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <input
            type="text"
            placeholder={t("audit.placeholders.gitBranch")}
            value={filters.git_branch}
            onChange={(e) => {
              setFilters((p) => ({ ...p, git_branch: e.target.value }));
              setPage(1);
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-32 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <select
            value={filters.memory_scope}
            onChange={(e) => {
              setFilters((p) => ({ ...p, memory_scope: e.target.value }));
              setPage(1);
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">{t("audit.allScopes")}</option>
            <option value="global">{t("memoryBrowser.scopes.global")}</option>
            <option value="project">{t("memoryBrowser.scopes.project")}</option>
            <option value="branch">{t("memoryBrowser.scopes.branch")}</option>
          </select>
          <span className="ml-auto text-xs text-slate-500">
            {loading
              ? t("audit.loadingRecords")
              : t("audit.totalRecords", { count: formatNumber(total) })}
          </span>
        </div>
      </Card>

      {/* Logs Table */}
      <Card padding={false}>
        {tableContent}
      </Card>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {t("audit.pageOf", { page, total: totalPages })}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="p-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Detail Drawer */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            onClick={closeDetail}
            aria-label={t("common.actions.close")}
          />
          <div className="relative w-full max-w-lg bg-white shadow-xl overflow-y-auto animate-slide-in">
            <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <ExternalLink size={18} className="text-slate-400" />
                <h2 className="font-semibold text-slate-900">
                  {t("audit.eventDetail")}
                </h2>
              </div>
              <button
                onClick={closeDetail}
                className="p-1 rounded-lg hover:bg-slate-100 cursor-pointer"
                aria-label={t("common.actions.close")}
              >
                <X size={18} />
              </button>
            </div>
            {detailLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary-600 border-t-transparent" />
              </div>
            ) : (
              <div className="p-6 space-y-4">
                <DetailRow
                  label={t("audit.detail.eventId")}
                  value={selectedEvent.event_id}
                  mono
                />
                <DetailRow
                  label={t("audit.detail.timestamp")}
                  value={formatDateTime(selectedEvent.timestamp)}
                />
                <DetailRow
                  label={t("audit.detail.operation")}
                  value={selectedEvent.operation}
                />
                <DetailRow
                  label={t("audit.detail.outcome")}
                  value={t(`common.outcomes.${selectedEvent.outcome}`)}
                />
                <DetailRow
                  label={t("audit.detail.project")}
                  value={selectedEvent.project}
                />
                <DetailRow
                  label={t("audit.detail.keyPrefix")}
                  value={selectedEvent.key_prefix}
                  mono
                />
                <DetailRow
                  label={t("audit.detail.clientIp")}
                  value={selectedEvent.client_ip}
                />
                <DetailRow
                  label={t("audit.detail.latency")}
                  value={`${selectedEvent.elapsed_ms}ms`}
                />
                <DetailRow
                  label={t("audit.detail.http")}
                  value={`${selectedEvent.http_method} ${selectedEvent.http_path}`}
                  mono
                />
                <DetailRow
                  label={t("audit.detail.httpStatus")}
                  value={String(selectedEvent.http_status)}
                />
                {selectedEvent.device_id && (
                  <DetailRow
                    label={t("audit.detail.deviceId")}
                    value={selectedEvent.device_id}
                  />
                )}
                {selectedEvent.git_branch && (
                  <DetailRow
                    label={t("audit.detail.gitBranch")}
                    value={selectedEvent.git_branch}
                  />
                )}
                {selectedEvent.memory_scope && (
                  <DetailRow
                    label={t("audit.detail.memoryScope")}
                    value={t(`memoryBrowser.scopes.${selectedEvent.memory_scope}`)}
                  />
                )}
                {selectedEvent.outcome_detail && (
                  <DetailRow
                    label={t("audit.detail.detail")}
                    value={selectedEvent.outcome_detail}
                  />
                )}
                {selectedEvent.error_code && (
                  <DetailRow
                    label={t("audit.detail.errorCode")}
                    value={selectedEvent.error_code}
                    mono
                  />
                )}
                {selectedEvent.error_stack && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">
                      {t("audit.detail.errorStack")}
                    </p>
                    <pre className="text-xs bg-red-50 text-red-800 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                      {selectedEvent.error_stack}
                    </pre>
                  </div>
                )}
                {selectedEvent.content_full && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">
                      {t("audit.detail.content")}
                    </p>
                    <pre className="text-xs bg-slate-50 text-slate-800 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-64">
                      {selectedEvent.content_full}
                    </pre>
                  </div>
                )}
                {selectedEvent.query_full && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">
                      {t("audit.detail.query")}
                    </p>
                    <pre className="text-xs bg-slate-50 text-slate-800 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-64">
                      {selectedEvent.query_full}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: Readonly<{
  label: string;
  value: string;
  mono?: boolean;
}>) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 mb-0.5">{label}</p>
      <p
        className={`text-sm text-slate-900 ${mono ? "font-mono" : ""} break-all`}
      >
        {value}
      </p>
    </div>
  );
}
