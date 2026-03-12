import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/auth";
import { useI18n } from "../contexts/i18n";
import { adminApi, type AdminOverviewResponse } from "../api/client";
import { StatCard, Card } from "../components/ui";
import {
  Activity,
  Database,
  Key,
  ShieldBan,
  Users,
  Zap,
  TrendingUp,
  Clock,
} from "lucide-react";

// ========================== 变更记录 ==========================
// [日期]     2026-03-12
// [类型]     修复Bug
// [描述]     清理 Dashboard 页面残留的硬编码空值占位，保证统计卡片在无数据场景下也走统一翻译文案。
// [思路]     复用 `common.emptyValue` 作为空值单一来源，避免不同卡片出现中英文混杂或多个占位风格。
// [影响范围] web/src/pages/Dashboard.tsx、web/src/i18n/resources.ts
// [潜在风险] 无已知风险。
// ==============================================================

interface DashboardData {
  overview: AdminOverviewResponse | null;
  loading: boolean;
  error: string | null;
}

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const { t, formatDate, formatNumber } = useI18n();
  const emptyValue = t("common.emptyValue");
  const [data, setData] = useState<DashboardData>({
    overview: null,
    loading: true,
    error: null,
  });

  const isAdmin = user?.role === "admin";

  const fetchData = useCallback(async () => {
    if (!isAdmin) {
      setData({ overview: null, loading: false, error: null });
      return;
    }
    try {
      const overview = await adminApi.getOverview();
      setData({ overview, loading: false, error: null });
    } catch (err) {
      setData({
        overview: null,
        loading: false,
        error: err instanceof Error ? err.message : t("dashboard.loadFailed"),
      });
    }
  }, [isAdmin, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (data.loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  const overview = data.overview;
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
  const activeSince =
    overview && overview.uptime_ms > 0
      ? formatDate(Date.now() - overview.uptime_ms)
      : emptyValue;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          {t("dashboard.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t("dashboard.welcomeBack", { username: user?.username ?? "" })}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title={t("dashboard.totalRequests")}
          value={overview ? formatNumber(overview.requests_total) : emptyValue}
          icon={<Activity size={22} />}
        />
        <StatCard
          title={t("dashboard.successRate")}
          value={successRate}
          icon={<TrendingUp size={22} />}
        />
        <StatCard
          title={t("dashboard.errorRate")}
          value={
            overview ? `${Math.round((overview.error_rate ?? 0) * 100)}%` : emptyValue
          }
          icon={<Zap size={22} />}
        />
        <StatCard
          title={t("dashboard.activeSince")}
          value={activeSince}
          icon={<Clock size={22} />}
        />
      </div>

      {/* Quick Info Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="animate-fade-in">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <Database size={20} />
            </div>
            <h3 className="font-semibold text-slate-900">
              {t("dashboard.systemStatus")}
            </h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">{t("dashboard.mode")}</span>
              <span className="font-medium text-slate-900">
                {t("common.mode.http")}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">{t("dashboard.yourRole")}</span>
              <span className="font-medium text-slate-900">
                {t(`common.roles.${user?.role ?? "user"}`)}
              </span>
            </div>
          </div>
        </Card>

        {hasPermission("keys:list") && (
          <Card className="animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-amber-50 text-amber-600">
                <Key size={20} />
              </div>
              <h3 className="font-semibold text-slate-900">
                {t("dashboard.apiKeysTitle")}
              </h3>
            </div>
            <p className="text-sm text-slate-500">
              {t("dashboard.apiKeysDescription")}
            </p>
          </Card>
        )}

        {hasPermission("bans:list") && (
          <Card className="animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-red-50 text-red-600">
                <ShieldBan size={20} />
              </div>
              <h3 className="font-semibold text-slate-900">
                {t("dashboard.securityTitle")}
              </h3>
            </div>
            <p className="text-sm text-slate-500">
              {t("dashboard.securityDescription")}
            </p>
          </Card>
        )}

        {hasPermission("users:list") && (
          <Card className="animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-violet-50 text-violet-600">
                <Users size={20} />
              </div>
              <h3 className="font-semibold text-slate-900">
                {t("dashboard.userManagementTitle")}
              </h3>
            </div>
            <p className="text-sm text-slate-500">
              {t("dashboard.userManagementDescription")}
            </p>
          </Card>
        )}
      </div>

      {data.error && (
        <Card>
          <p className="text-sm text-red-600">
            {t("common.errorLabel")}: {data.error}
          </p>
        </Card>
      )}
    </div>
  );
}
