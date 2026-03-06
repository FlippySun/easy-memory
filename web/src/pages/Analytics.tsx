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
  Database,
  Search,
  Timer,
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface AnalyticsData {
  overview: AdminOverviewResponse | null;
  timeline: { data: AdminTimelinePoint[]; total: number } | null;
  operations: { data: AdminOperationDistribution[]; total: number } | null;
  errors: AdminErrorRateResponse | null;
  // v0.7.0
  memoryGrowth: Array<{ date: string; save_count: number }> | null;
  searchQuality: Array<{
    date: string;
    total_searches: number;
    hit_count: number;
    hit_rate: number;
    avg_score: number;
    avg_result_count: number;
  }> | null;
  performance: Array<{
    operation: string;
    avg_ms: number;
    p95_ms: number;
    max_ms: number;
    count: number;
  }> | null;
}

export function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData>({
    overview: null,
    timeline: null,
    operations: null,
    errors: null,
    memoryGrowth: null,
    searchQuality: null,
    performance: null,
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
      const [
        overview,
        timeline,
        operations,
        errors,
        memGrowth,
        searchQual,
        perf,
      ] = await Promise.all([
        adminApi.getOverview(param, { signal: controller.signal }),
        adminApi.getTimeline(param, { signal: controller.signal }),
        adminApi.getOperations(param, { signal: controller.signal }),
        adminApi.getErrors(param, { signal: controller.signal }),
        adminApi
          .getMemoryGrowth(param, { signal: controller.signal })
          .catch(() => null),
        adminApi
          .getSearchQuality(param, { signal: controller.signal })
          .catch(() => null),
        adminApi
          .getPerformance(param, { signal: controller.signal })
          .catch(() => null),
      ]);
      // 仅在未被中止时更新状态
      if (!controller.signal.aborted) {
        setData({
          overview,
          timeline,
          operations,
          errors,
          memoryGrowth: memGrowth?.data ?? null,
          searchQuality: searchQual?.data ?? null,
          performance: perf?.data ?? null,
        });
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

          {/* v0.7.0: Memory Growth Trend */}
          {data.memoryGrowth && data.memoryGrowth.length > 0 && (
            <Card>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-purple-50 text-purple-600">
                  <Database size={20} />
                </div>
                <h3 className="font-semibold text-slate-900">
                  Memory Growth Trend
                </h3>
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={data.memoryGrowth}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12 }}
                    stroke="#94a3b8"
                  />
                  <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid #e2e8f0",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="save_count"
                    name="Saved Memories"
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          )}

          {/* v0.7.0: Search Quality Metrics */}
          {data.searchQuality && data.searchQuality.length > 0 && (
            <Card>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-cyan-50 text-cyan-600">
                  <Search size={20} />
                </div>
                <h3 className="font-semibold text-slate-900">Search Quality</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                <div className="text-center p-3 bg-slate-50 rounded-lg">
                  <p className="text-2xl font-bold text-slate-900">
                    {Math.round(data.searchQuality[0].hit_rate * 100)}%
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Hit Rate</p>
                </div>
                <div className="text-center p-3 bg-slate-50 rounded-lg">
                  <p className="text-2xl font-bold text-slate-900">
                    {data.searchQuality[0].avg_score.toFixed(3)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Avg Score</p>
                </div>
                <div className="text-center p-3 bg-slate-50 rounded-lg">
                  <p className="text-2xl font-bold text-slate-900">
                    {data.searchQuality[0].avg_result_count.toFixed(1)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Avg Results</p>
                </div>
              </div>
            </Card>
          )}

          {/* v0.7.0: Performance Breakdown */}
          {data.performance && data.performance.length > 0 && (
            <Card>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-amber-50 text-amber-600">
                  <Timer size={20} />
                </div>
                <h3 className="font-semibold text-slate-900">
                  Performance Breakdown
                </h3>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.performance}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="operation"
                    tick={{ fontSize: 12 }}
                    stroke="#94a3b8"
                  />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    stroke="#94a3b8"
                    label={{ value: "ms", angle: -90, position: "insideLeft" }}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid #e2e8f0",
                    }}
                  />
                  <Legend />
                  <Bar
                    dataKey="avg_ms"
                    name="Avg (ms)"
                    fill="#f59e0b"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="p95_ms"
                    name="P95 (ms)"
                    fill="#06b6d4"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="max_ms"
                    name="Max (ms)"
                    fill="#ef4444"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
