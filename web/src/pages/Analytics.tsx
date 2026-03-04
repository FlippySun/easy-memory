import { useState, useEffect, useCallback, useRef } from "react";
import { adminApi, ApiError } from "../api/client";
import { Card, StatCard } from "../components/ui";
import {
  BarChart3,
  TrendingUp,
  AlertCircle,
  Zap,
  Users,
  Activity,
} from "lucide-react";

interface AnalyticsData {
  overview: Record<string, unknown> | null;
  timeline: Record<string, unknown> | null;
  operations: Record<string, unknown> | null;
  errors: Record<string, unknown> | null;
}

export function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>({
    overview: null,
    timeline: null,
    operations: null,
    errors: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("24h");
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    // 取消前一个正在进行的请求，防止快速切换 timeRange 导致的竞态
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const hours = timeRange === "24h" ? 24 : timeRange === "7d" ? 168 : 720;
      const param = `hours=${hours}`;
      const [overview, timeline, operations, errors] = await Promise.all([
        adminApi.getOverview(param),
        adminApi.getTimeline(param),
        adminApi.getOperations(param),
        adminApi.getErrors(param),
      ]);
      // 仅在未被中止时更新状态
      if (!controller.signal.aborted) {
        setData({ overview, timeline, operations, errors });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(
          err instanceof ApiError
            ? err.message
            : "Failed to load analytics data",
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [timeRange]);

  useEffect(() => {
    fetchData();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchData]);

  const period = (data.overview?.period as Record<string, unknown>) ?? {};
  const totals = (period?.totals as Record<string, number>) ?? {};
  const opBreakdown =
    (data.operations?.operations as Array<Record<string, unknown>>) ?? [];
  const errorList =
    (data.errors?.errors as Array<Record<string, unknown>>) ?? [];
  const timelineData =
    (data.timeline?.timeline as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Analytics</h1>
          <p className="text-sm text-slate-500 mt-1">
            Service usage and performance metrics
          </p>
        </div>
        <div className="flex gap-1 bg-white border border-slate-200 rounded-lg p-1">
          {["24h", "7d", "30d"].map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors cursor-pointer ${
                timeRange === range
                  ? "bg-primary-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
        </div>
      ) : error ? (
        <Card>
          <div className="flex items-center gap-3 text-red-600">
            <AlertCircle size={20} />
            <p className="text-sm font-medium">{error}</p>
          </div>
        </Card>
      ) : (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title="Total Requests"
              value={totals?.total_requests ?? 0}
              icon={<Activity size={22} />}
            />
            <StatCard
              title="Success Rate"
              value={
                totals?.total_requests
                  ? `${Math.round(((totals?.successful_requests ?? 0) / totals.total_requests) * 100)}%`
                  : "—"
              }
              icon={<TrendingUp size={22} />}
            />
            <StatCard
              title="Avg Latency"
              value={
                totals?.avg_latency_ms
                  ? `${Math.round(totals.avg_latency_ms)}ms`
                  : "—"
              }
              icon={<Zap size={22} />}
            />
            <StatCard
              title="Unique Users"
              value={totals?.unique_key_prefixes ?? 0}
              icon={<Users size={22} />}
            />
          </div>

          {/* Operations Breakdown */}
          <Card>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
                <BarChart3 size={20} />
              </div>
              <h3 className="font-semibold text-slate-900">
                Operations Breakdown
              </h3>
            </div>
            {opBreakdown.length === 0 ? (
              <p className="text-sm text-slate-500">
                No operation data for this period
              </p>
            ) : (
              <div className="space-y-3">
                {opBreakdown.map((op, i) => {
                  const count = (op.count as number) || 0;
                  const maxCount = Math.max(
                    ...opBreakdown.map((o) => (o.count as number) || 0),
                  );
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  return (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-700">
                          {op.operation as string}
                        </span>
                        <span className="text-slate-500">
                          {count.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary-500 rounded-full transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Timeline */}
          {timelineData.length > 0 && (
            <Card>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600">
                  <TrendingUp size={20} />
                </div>
                <h3 className="font-semibold text-slate-900">
                  Request Timeline
                </h3>
              </div>
              <div className="flex items-end gap-1 h-32">
                {timelineData.slice(-48).map((point, i) => {
                  const count = (point.count as number) || 0;
                  const maxVal = Math.max(
                    ...timelineData
                      .slice(-48)
                      .map((p) => (p.count as number) || 0),
                  );
                  const height = maxVal > 0 ? (count / maxVal) * 100 : 0;
                  return (
                    <div
                      key={i}
                      className="flex-1 bg-primary-200 hover:bg-primary-400 rounded-t transition-colors cursor-default"
                      style={{ height: `${Math.max(height, 2)}%` }}
                      title={`${point.bucket}: ${count} requests`}
                    />
                  );
                })}
              </div>
            </Card>
          )}

          {/* Errors */}
          {errorList.length > 0 && (
            <Card>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-red-50 text-red-600">
                  <AlertCircle size={20} />
                </div>
                <h3 className="font-semibold text-slate-900">Recent Errors</h3>
              </div>
              <div className="space-y-2">
                {errorList.slice(0, 10).map((err, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-sm p-2 rounded-lg bg-red-50/50"
                  >
                    <span className="text-red-800 font-medium">
                      {err.operation as string}
                    </span>
                    <span className="text-red-600">
                      {(err.count as number)?.toLocaleString()} occurrences
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
