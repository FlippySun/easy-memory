import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
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
import { useAuth } from "../contexts/auth";
import { useI18n } from "../contexts/i18n";

// ========================== 变更记录 ==========================
// [日期]     2026-03-12
// [类型]     修复Bug
// [描述]     重写 Analytics 页面渲染结构，修复之前残留的重复 JSX 与不完整返回分支，并继续保持全量中英文适配。
// [思路]     将页面拆为“数据请求 + 统计计算 + 单一 content 渲染出口”，避免分支复制导致的结构错乱，同时保留现有数据聚合逻辑与图表表现。
// [影响范围] web/src/pages/Analytics.tsx、web/src/i18n/resources.ts（依赖既有 key）、web/src/components/ui.tsx（展示组件）
// [潜在风险] 图表区仍依赖后端统计字段完整性；若某些增强统计接口暂不可用，会展示本地化警告但不影响主页面可用性。
// ==============================================================

interface AnalyticsData {
  overview: AdminOverviewResponse | null;
  timeline: { data: AdminTimelinePoint[]; total: number } | null;
  operations: { data: AdminOperationDistribution[]; total: number } | null;
  errors: AdminErrorRateResponse | null;
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

type TimeRange = "24h" | "7d" | "30d";

interface OptionalPanelResult<T> {
  data: T | null;
  failed: boolean;
  label?: string;
}

interface SearchQualitySummary {
  totalSearches: number;
  hitCount: number;
  weightedScore: number;
  weightedResults: number;
}

type TranslateFunction = (
  key: string,
  variables?: Record<string, string | number | undefined>,
) => string;

interface AnalyticsContentProps {
  loading: boolean;
  error: string | null;
  warningMessage: string | null;
  analyticsReady: boolean;
  t: TranslateFunction;
  formatDateTime: (
    value: Date | string | number,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  totalRequests: number;
  successRate: string;
  avgLatencyMs: number;
  overview: AdminOverviewResponse | null;
  opBreakdown: AdminOperationDistribution[];
  timelineData: AdminTimelinePoint[];
  errorList: Array<{ operation: string; count: number }>;
  data: AnalyticsData;
  searchQualitySummary?: SearchQualitySummary;
  emptyValue: string;
}

const TIME_RANGES: readonly TimeRange[] = ["24h", "7d", "30d"];

function renderAnalyticsContent({
  loading,
  error,
  warningMessage,
  analyticsReady,
  t,
  formatDateTime,
  formatNumber,
  totalRequests,
  successRate,
  avgLatencyMs,
  overview,
  opBreakdown,
  timelineData,
  errorList,
  data,
  searchQualitySummary,
  emptyValue,
}: AnalyticsContentProps): ReactNode {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
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

  return (
    <>
      {warningMessage && (
        <Card>
          <div className="flex items-center gap-3 text-amber-700">
            <AlertCircle size={18} />
            <p className="text-sm font-medium">{warningMessage}</p>
          </div>
        </Card>
      )}

      {!analyticsReady && (
        <Card>
          <div className="flex items-center gap-3 text-amber-700">
            <AlertCircle size={18} />
            <p className="text-sm font-medium">{t("analytics.analyticsNotReady")}</p>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title={t("analytics.totalRequests")}
          value={formatNumber(totalRequests)}
          icon={<Activity size={22} />}
        />
        <StatCard
          title={t("analytics.successRate")}
          value={successRate}
          icon={<TrendingUp size={22} />}
        />
        <StatCard
          title={t("analytics.errorRate")}
          value={
            overview
              ? `${Math.round((overview.error_rate ?? 0) * 100)}%`
              : emptyValue
          }
          icon={<Zap size={22} />}
        />
        <StatCard
          title={t("analytics.avgLatency")}
          value={avgLatencyMs > 0 ? `${Math.round(avgLatencyMs)}ms` : emptyValue}
          icon={<Activity size={22} />}
        />
      </div>

      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
            <BarChart3 size={20} />
          </div>
          <h3 className="font-semibold text-slate-900">
            {t("analytics.operationsBreakdown")}
          </h3>
        </div>
        {opBreakdown.length === 0 ? (
          <p className="text-sm text-slate-500">{t("analytics.noOperationData")}</p>
        ) : (
          <div className="space-y-3">
            {opBreakdown.map((operation) => {
              const count = operation.count || 0;
              const percentage = Math.max(
                0,
                Math.min(100, (operation.percentage ?? 0) * 100),
              );

              return (
                <div key={operation.operation} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-700">
                      {operation.operation}
                    </span>
                    <span className="text-slate-500">{formatNumber(count)}</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary-500 rounded-full transition-all duration-500"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {timelineData.length > 0 && (
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600">
              <TrendingUp size={20} />
            </div>
            <h3 className="font-semibold text-slate-900">
              {t("analytics.requestTimeline")}
            </h3>
          </div>
          <div className="flex items-end gap-1 h-32">
            {timelineData.map((point) => {
              const count = point.total_count || 0;
              const maxValue = Math.max(
                ...timelineData.map((item) => item.total_count || 0),
              );
              const height = maxValue > 0 ? (count / maxValue) * 100 : 0;

              return (
                <div
                  key={point.time_bucket}
                  className="flex-1 bg-primary-200 hover:bg-primary-400 rounded-t transition-colors cursor-default"
                  style={{ height: `${Math.max(height, 2)}%` }}
                  title={t("analytics.timelineTooltip", {
                    time: formatDateTime(point.time_bucket),
                    count: formatNumber(count),
                  })}
                />
              );
            })}
          </div>
        </Card>
      )}

      {errorList.length > 0 && (
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-red-50 text-red-600">
              <AlertCircle size={20} />
            </div>
            <h3 className="font-semibold text-slate-900">
              {t("analytics.recentErrors")}
            </h3>
          </div>
          <div className="space-y-2">
            {errorList.slice(0, 10).map((item) => (
              <div
                key={item.operation}
                className="flex items-center justify-between text-sm p-2 rounded-lg bg-red-50/50"
              >
                <span className="text-red-800 font-medium">{item.operation}</span>
                <span className="text-red-600">
                  {t("analytics.occurrences", {
                    count: formatNumber(item.count),
                  })}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {data.memoryGrowth && data.memoryGrowth.length > 0 && (
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-purple-50 text-purple-600">
              <Database size={20} />
            </div>
            <h3 className="font-semibold text-slate-900">
              {t("analytics.memoryGrowth")}
            </h3>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.memoryGrowth}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} stroke="#94a3b8" />
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
                name={t("analytics.savedMemories")}
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {data.searchQuality && data.searchQuality.length > 0 && (
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-cyan-50 text-cyan-600">
              <Search size={20} />
            </div>
            <h3 className="font-semibold text-slate-900">
              {t("analytics.searchQuality")}
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <div className="text-center p-3 bg-slate-50 rounded-lg">
              <p className="text-2xl font-bold text-slate-900">
                {searchQualitySummary && searchQualitySummary.totalSearches > 0
                  ? `${Math.round((searchQualitySummary.hitCount / searchQualitySummary.totalSearches) * 100)}%`
                  : emptyValue}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {t("analytics.rangeHitRate")}
              </p>
            </div>
            <div className="text-center p-3 bg-slate-50 rounded-lg">
              <p className="text-2xl font-bold text-slate-900">
                {searchQualitySummary && searchQualitySummary.totalSearches > 0
                  ? (
                      searchQualitySummary.weightedScore /
                      searchQualitySummary.totalSearches
                    ).toFixed(3)
                  : emptyValue}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {t("analytics.rangeAvgScore")}
              </p>
            </div>
            <div className="text-center p-3 bg-slate-50 rounded-lg">
              <p className="text-2xl font-bold text-slate-900">
                {searchQualitySummary && searchQualitySummary.totalSearches > 0
                  ? (
                      searchQualitySummary.weightedResults /
                      searchQualitySummary.totalSearches
                    ).toFixed(1)
                  : emptyValue}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {t("analytics.rangeAvgResults")}
              </p>
            </div>
          </div>
        </Card>
      )}

      {data.performance && data.performance.length > 0 && (
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-amber-50 text-amber-600">
              <Timer size={20} />
            </div>
            <h3 className="font-semibold text-slate-900">
              {t("analytics.performanceBreakdown")}
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
                name={t("analytics.avgMs")}
                fill="#f59e0b"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="p95_ms"
                name={t("analytics.p95Ms")}
                fill="#06b6d4"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="max_ms"
                name={t("analytics.maxMs")}
                fill="#ef4444"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}
    </>
  );
}

export function AnalyticsPage() {
  const { user } = useAuth();
  const { t, formatDateTime, formatNumber } = useI18n();
  const isAdmin = user?.role === "admin";
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
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const abortRef = useRef<AbortController | null>(null);
  const timelineGranularity = timeRange === "24h" ? "hourly" : "daily";
  const emptyValue = t("common.emptyValue");

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setWarningMessage(null);

    try {
      const sharedParams = new URLSearchParams({ range: timeRange });
      const timelineParams = new URLSearchParams(sharedParams);
      timelineParams.set("granularity", timelineGranularity);

      const loadOptionalPanel = async <T,>(
        request: Promise<{ data: T }>,
        label: string,
      ): Promise<OptionalPanelResult<T>> => {
        try {
          const response = await request;
          return { data: response.data, failed: false };
        } catch {
          return { data: null, failed: true, label };
        }
      };

      const [overview, timeline, operations, errors, memGrowth, searchQual, perf] =
        await Promise.all([
          adminApi.getOverview(sharedParams.toString(), {
            signal: controller.signal,
          }),
          adminApi.getTimeline(timelineParams.toString(), {
            signal: controller.signal,
          }),
          adminApi.getOperations(sharedParams.toString(), {
            signal: controller.signal,
          }),
          adminApi.getErrors(sharedParams.toString(), {
            signal: controller.signal,
          }),
          loadOptionalPanel(
            adminApi.getMemoryGrowth(sharedParams.toString(), {
              signal: controller.signal,
            }),
            t("analytics.panels.memoryGrowth"),
          ),
          loadOptionalPanel(
            adminApi.getSearchQuality(sharedParams.toString(), {
              signal: controller.signal,
            }),
            t("analytics.panels.searchQuality"),
          ),
          loadOptionalPanel(
            adminApi.getPerformance(sharedParams.toString(), {
              signal: controller.signal,
            }),
            t("analytics.panels.performance"),
          ),
        ]);

      if (controller.signal.aborted) {
        return;
      }

      const failedPanels = [memGrowth, searchQual, perf].flatMap((result) =>
        result.failed && result.label ? [result.label] : [],
      );

      if (failedPanels.length > 0) {
        setWarningMessage(
          t("analytics.warningEnhancedPanels", {
            panels: failedPanels.join(", "),
          }),
        );
      }

      setData({
        overview,
        timeline,
        operations,
        errors,
        memoryGrowth: memGrowth.data,
        searchQuality: searchQual.data,
        performance: perf.data,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }

      setError(err instanceof ApiError ? err.message : t("analytics.loadFailed"));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [t, timeRange, timelineGranularity]);

  useEffect(() => {
    fetchData();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchData]);

  const overview = data.overview;
  const opBreakdown = data.operations?.data ?? [];
  const timelineData = data.timeline?.data ?? [];
  const analyticsReady = overview?.analytics_ready !== false;
  const searchQualitySummary = data.searchQuality?.reduce(
    (accumulator, point) => {
      accumulator.totalSearches += point.total_searches;
      accumulator.hitCount += point.hit_count;
      accumulator.weightedScore += point.avg_score * point.total_searches;
      accumulator.weightedResults +=
        point.avg_result_count * point.total_searches;
      return accumulator;
    },
    {
      totalSearches: 0,
      hitCount: 0,
      weightedScore: 0,
      weightedResults: 0,
    },
  );

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
      : emptyValue;

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
    .sort((left, right) => right.count - left.count);

  const content = renderAnalyticsContent({
    loading,
    error,
    warningMessage,
    analyticsReady,
    t,
    formatDateTime,
    formatNumber,
    totalRequests,
    successRate,
    avgLatencyMs,
    overview,
    opBreakdown,
    timelineData,
    errorList,
    data,
    searchQualitySummary,
    emptyValue,
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {t("analytics.title")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {isAdmin
              ? t("analytics.descriptionAdmin")
              : t("analytics.descriptionUser")}
          </p>
        </div>
        <div className="flex gap-1 bg-white border border-slate-200 rounded-lg p-1">
          {TIME_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors cursor-pointer ${
                timeRange === range
                  ? "bg-primary-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {t(`analytics.timeRanges.${range}`)}
            </button>
          ))}
        </div>
      </div>

      {content}
    </div>
  );
}
