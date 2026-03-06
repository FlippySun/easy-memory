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

export function AuditLogsPage() {
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
          err instanceof ApiError ? err.message : "Failed to load audit logs",
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [page, filters]);

  useEffect(() => {
    fetchLogs();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / pageSize);

  const detailAbortRef = useRef<AbortController | null>(null);

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

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Audit Logs</h1>
        <p className="text-sm text-slate-500 mt-1">
          Detailed operation audit trail
        </p>
      </div>

      {/* Filters */}
      <Card>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-700">Filters:</span>
          </div>
          <select
            value={filters.operation}
            onChange={(e) => {
              setFilters((p) => ({ ...p, operation: e.target.value }));
              setPage(1);
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          >
            <option value="">All Operations</option>
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
            <option value="">All Outcomes</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="rejected">Rejected</option>
            <option value="unauthorized">Unauthorized</option>
            <option value="rate_limited">Rate Limited</option>
          </select>
          <input
            type="text"
            placeholder="Device ID"
            value={filters.device_id}
            onChange={(e) => {
              setFilters((p) => ({ ...p, device_id: e.target.value }));
              setPage(1);
            }}
            className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 w-32 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Git Branch"
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
            <option value="">All Scopes</option>
            <option value="global">global</option>
            <option value="project">project</option>
            <option value="branch">branch</option>
          </select>
          <span className="ml-auto text-xs text-slate-500">
            {total.toLocaleString()} total records
          </span>
        </div>
      </Card>

      {/* Logs Table */}
      <Card padding={false}>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary-600 border-t-transparent" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-3 text-red-600 p-6">
            <AlertCircle size={20} />
            <p className="text-sm font-medium">{error}</p>
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={32} />}
            title="No Audit Logs"
            description="No audit logs match the current filters"
          />
        ) : (
          <Table
            columns={[
              {
                key: "timestamp",
                title: "Time",
                render: (r) => (
                  <span className="text-xs whitespace-nowrap">
                    {new Date(r.timestamp).toLocaleString()}
                  </span>
                ),
              },
              {
                key: "operation",
                title: "Operation",
                render: (r) => (
                  <code className="text-xs bg-slate-100 px-2 py-0.5 rounded">
                    {r.operation}
                  </code>
                ),
              },
              {
                key: "outcome",
                title: "Outcome",
                render: (r) => (
                  <Badge variant={outcomeVariant(r.outcome)}>{r.outcome}</Badge>
                ),
              },
              {
                key: "project",
                title: "Project",
                render: (r) => r.project || "—",
              },
              {
                key: "key_prefix",
                title: "Key",
                render: (r) =>
                  r.key_prefix ? (
                    <code className="text-xs">{r.key_prefix}</code>
                  ) : (
                    "—"
                  ),
              },
              {
                key: "client_ip",
                title: "Client IP",
                render: (r) => <span className="text-xs">{r.client_ip}</span>,
              },
              {
                key: "latency_ms",
                title: "Latency",
                render: (r) => (
                  <span
                    className={`text-xs font-medium ${
                      r.elapsed_ms > 1000
                        ? "text-red-600"
                        : r.elapsed_ms > 500
                          ? "text-amber-600"
                          : "text-emerald-600"
                    }`}
                  >
                    {r.elapsed_ms}ms
                  </span>
                ),
              },
              {
                key: "error_message",
                title: "Error",
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
        )}
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            Page {page} of {totalPages}
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
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSelectedEvent(null)}
          />
          <div className="relative w-full max-w-lg bg-white shadow-xl overflow-y-auto animate-slide-in">
            <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <ExternalLink size={18} className="text-slate-400" />
                <h2 className="font-semibold text-slate-900">Event Detail</h2>
              </div>
              <button
                onClick={() => setSelectedEvent(null)}
                className="p-1 rounded-lg hover:bg-slate-100 cursor-pointer"
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
                  label="Event ID"
                  value={selectedEvent.event_id}
                  mono
                />
                <DetailRow
                  label="Timestamp"
                  value={new Date(selectedEvent.timestamp).toLocaleString()}
                />
                <DetailRow label="Operation" value={selectedEvent.operation} />
                <DetailRow label="Outcome" value={selectedEvent.outcome} />
                <DetailRow label="Project" value={selectedEvent.project} />
                <DetailRow
                  label="Key Prefix"
                  value={selectedEvent.key_prefix}
                  mono
                />
                <DetailRow label="Client IP" value={selectedEvent.client_ip} />
                <DetailRow
                  label="Latency"
                  value={`${selectedEvent.elapsed_ms}ms`}
                />
                <DetailRow
                  label="HTTP"
                  value={`${selectedEvent.http_method} ${selectedEvent.http_path}`}
                  mono
                />
                <DetailRow
                  label="HTTP Status"
                  value={String(selectedEvent.http_status)}
                />
                {selectedEvent.device_id && (
                  <DetailRow
                    label="Device ID"
                    value={selectedEvent.device_id}
                  />
                )}
                {selectedEvent.git_branch && (
                  <DetailRow
                    label="Git Branch"
                    value={selectedEvent.git_branch}
                  />
                )}
                {selectedEvent.memory_scope && (
                  <DetailRow
                    label="Memory Scope"
                    value={selectedEvent.memory_scope}
                  />
                )}
                {selectedEvent.outcome_detail && (
                  <DetailRow
                    label="Detail"
                    value={selectedEvent.outcome_detail}
                  />
                )}
                {selectedEvent.error_code && (
                  <DetailRow
                    label="Error Code"
                    value={selectedEvent.error_code}
                    mono
                  />
                )}
                {selectedEvent.error_stack && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">
                      Error Stack
                    </p>
                    <pre className="text-xs bg-red-50 text-red-800 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
                      {selectedEvent.error_stack}
                    </pre>
                  </div>
                )}
                {selectedEvent.content_full && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">
                      Content
                    </p>
                    <pre className="text-xs bg-slate-50 text-slate-800 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-64">
                      {selectedEvent.content_full}
                    </pre>
                  </div>
                )}
                {selectedEvent.query_full && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">
                      Query
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
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
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
