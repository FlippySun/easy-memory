import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./contexts/auth";
import { useI18n } from "./contexts/i18n";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { ApiKeysPage } from "./pages/ApiKeys";
import { BansPage } from "./pages/Bans";
import { AnalyticsPage } from "./pages/Analytics";
import { AuditLogsPage } from "./pages/AuditLogs";
import { MemoryBrowserPage } from "./pages/MemoryBrowser";
import { UsersPage } from "./pages/Users";
import { SettingsPage } from "./pages/Settings";
import RegisterPage from "./pages/Register";
import MyKeysPage from "./pages/MyKeys";

function ProtectedRoute({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PermissionGuard({
  permission,
  children,
}: Readonly<{
  permission: string;
  children: React.ReactNode;
}>) {
  const { hasPermission } = useAuth();
  const { t } = useI18n();

  if (!hasPermission(permission)) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
        <h2 className="text-lg font-semibold text-slate-900 mb-2">
          {t("app.accessDeniedTitle")}
        </h2>
        <p className="text-sm text-slate-500">
          {t("app.accessDeniedDescription")}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

export function App() {
  const { isAuthenticated, isLoading } = useAuth();
  const { t } = useI18n();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-600 border-t-transparent" />
          <p className="text-sm text-slate-500">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/register"
        element={
          isAuthenticated ? <Navigate to="/" replace /> : <RegisterPage />
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route
          path="/api-keys"
          element={
            <PermissionGuard permission="keys:list">
              <ApiKeysPage />
            </PermissionGuard>
          }
        />
        <Route
          path="/bans"
          element={
            <PermissionGuard permission="bans:list">
              <BansPage />
            </PermissionGuard>
          }
        />
        <Route
          path="/analytics"
          element={
            <PermissionGuard permission="analytics:read">
              <AnalyticsPage />
            </PermissionGuard>
          }
        />
        <Route
          path="/audit"
          element={
            <PermissionGuard permission="audit:read">
              <AuditLogsPage />
            </PermissionGuard>
          }
        />
        <Route
          path="/memories"
          element={
            <PermissionGuard permission="memories:browse">
              <MemoryBrowserPage />
            </PermissionGuard>
          }
        />
        <Route
          path="/users"
          element={
            <PermissionGuard permission="users:list">
              <UsersPage />
            </PermissionGuard>
          }
        />
        <Route
          path="/settings"
          element={
            <PermissionGuard permission="config:read">
              <SettingsPage />
            </PermissionGuard>
          }
        />
        <Route
          path="/my-keys"
          element={
            <PermissionGuard permission="keys:self">
              <MyKeysPage />
            </PermissionGuard>
          }
        />
      </Route>

      {/* Catch-all: redirect to dashboard */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
