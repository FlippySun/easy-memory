import { useState, useEffect, useCallback, useRef } from "react";
import { adminApi, ApiError, type AdminAuditLogEntry } from "../api/client";
import { Card, Table, Badge, EmptyState } from "../components/ui";
import {
  ScrollText,
  Filter,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from "lucide-react";

export function AuditLogsPage() {
  const [logs, setLogs] = useState<AdminAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ operation: "", outcome: "" });
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
    </div>
  );
}
