import { useState, useEffect, useCallback, useRef } from "react";
import {
  adminApi,
  ApiError,
  type AdminOverviewResponse,
  type AdminTimelinePoint,
  type AdminOperationDistribution,
  type AdminErrorRateResponse,
} from "../api/client";
import { Card, StatCard } from "../components/ui";
import {
  BarChart3,
  TrendingUp,
  AlertCircle,
  Zap,
  Activity,
} from "lucide-react";

interface AnalyticsData {
  overview: AdminOverviewResponse | null;
  timeline: { data: AdminTimelinePoint[]; total: number } | null;
  operations: { data: AdminOperationDistribution[]; total: number } | null;
  errors: AdminErrorRateResponse | null;
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
      const param = `range=${encodeURIComponent(timeRange)}`;
      const [overview, timeline, operations, errors] = await Promise.all([
        adminApi.getOverview(param, { signal: controller.signal }),
        adminApi.getTimeline(param, { signal: controller.signal }),
        adminApi.getOperations(param, { signal: controller.signal }),
        adminApi.getErrors(param, { signal: controller.signal }),
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

  const overview = data.overview;
  const opBreakdown = data.operations?.data ?? [];
  const timelineData = data.timeline?.data ?? [];

  const totalRequests = overview?.requests_total ?? 0;
  const successfulRequests = Math.max(
    0,
    totalRequests -
      (overview?.errors_total ?? 0) -
      (overview?.rejected_total ?? 0) -
      (overview?.rate_limited_total ?? 0),
  );
  const successRate =
    totalRequests > 0
      ? `${Math.round((successfulRequests / totalRequests) * 100)}%`
      : "—";

  const totalTimelineRequests = timelineData.reduce(
    (sum, point) => sum + point.total_count,
    0,
  );
  const weightedLatencySum = timelineData.reduce(
    (sum, point) => sum + point.avg_elapsed_ms * point.total_count,
    0,
  );
  const avgLatencyMs =
    totalTimelineRequests > 0 ? weightedLatencySum / totalTimelineRequests : 0;

  const errorList = Object.entries(data.errors?.by_operation ?? {})
    .map(([operation, stats]) => ({
      operation,
      count: stats.errors,
      total: stats.total,
      rate: stats.rate,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);

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
              value={totalRequests}
              icon={<Activity size={22} />}
            />
            <StatCard
              title="Success Rate"
              value={successRate}
              icon={<TrendingUp size={22} />}
            />
            <StatCard
              title="Error Rate"
              value={
                overview
                  ? `${Math.round((overview.error_rate ?? 0) * 100)}%`
                  : "—"
              }
              icon={<Zap size={22} />}
            />
            <StatCard
              title="Avg Latency"
              value={avgLatencyMs > 0 ? `${Math.round(avgLatencyMs)}ms` : "—"}
              icon={<Activity size={22} />}
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
                  const count = op.count || 0;
                  const maxCount = Math.max(
                    ...opBreakdown.map((o) => o.count || 0),
                  );
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  return (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-700">
                          {op.operation}
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
                  const count = point.total_count || 0;
                  const maxVal = Math.max(
                    ...timelineData.slice(-48).map((p) => p.total_count || 0),
                  );
                  const height = maxVal > 0 ? (count / maxVal) * 100 : 0;
                  return (
                    <div
                      key={i}
                      className="flex-1 bg-primary-200 hover:bg-primary-400 rounded-t transition-colors cursor-default"
                      style={{ height: `${Math.max(height, 2)}%` }}
                      title={`${new Date(point.time_bucket).toLocaleString()}: ${count} requests`}
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
                      {err.operation}
                    </span>
                    <span className="text-red-600">
                      {err.count.toLocaleString()} occurrences
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
