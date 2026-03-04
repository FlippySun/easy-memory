import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/auth";
import { adminApi } from "../api/client";
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

interface DashboardData {
  overview: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
}

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
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
        error: err instanceof Error ? err.message : "Failed to load",
      });
    }
  }, [isAdmin]);

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

  const overview = data.overview as Record<string, unknown> | null;
  const period = overview?.period as Record<string, unknown> | undefined;
  const totals = period?.totals as Record<string, number> | undefined;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">
          Welcome back, {user?.username}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Requests"
          value={totals?.total_requests ?? "—"}
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
          title="Active Since"
          value={
            period?.start
              ? new Date(period.start as string).toLocaleDateString()
              : "—"
          }
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
            <h3 className="font-semibold text-slate-900">System Status</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Mode</span>
              <span className="font-medium text-slate-900">HTTP</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Your Role</span>
              <span className="font-medium text-slate-900 capitalize">
                {user?.role}
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
              <h3 className="font-semibold text-slate-900">API Keys</h3>
            </div>
            <p className="text-sm text-slate-500">
              Manage API keys for service authentication
            </p>
          </Card>
        )}

        {hasPermission("bans:list") && (
          <Card className="animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-red-50 text-red-600">
                <ShieldBan size={20} />
              </div>
              <h3 className="font-semibold text-slate-900">Security</h3>
            </div>
            <p className="text-sm text-slate-500">
              Monitor bans and access control
            </p>
          </Card>
        )}

        {hasPermission("users:list") && (
          <Card className="animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-violet-50 text-violet-600">
                <Users size={20} />
              </div>
              <h3 className="font-semibold text-slate-900">User Management</h3>
            </div>
            <p className="text-sm text-slate-500">
              Manage admin panel users and roles
            </p>
          </Card>
        )}
      </div>

      {data.error && (
        <Card>
          <p className="text-sm text-red-600">Error: {data.error}</p>
        </Card>
      )}
    </div>
  );
}
