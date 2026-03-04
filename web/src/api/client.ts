/**
 * API 客户端 — 统一的 HTTP 请求封装。
 * 自动注入 JWT token，处理 401 自动登出。
 */

const API_BASE = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string): void {
  localStorage.setItem("token", token);
}

export function clearToken(): void {
  localStorage.removeItem("token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      (body as { error?: string }).error || `HTTP ${res.status}`,
      body,
    );
  }

  // 处理空响应
  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// =====================================================================
// Auth API
// =====================================================================

export interface LoginResponse {
  token: string;
  user: UserRecord;
  expires_in: number;
}

export interface UserRecord {
  id: number;
  username: string;
  role: "admin" | "user";
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  is_active: boolean;
}

export interface MeResponse {
  user: UserRecord;
  permissions: string[];
}

export const authApi = {
  login: (username: string, password: string) =>
    api.post<LoginResponse>("/auth/login", { username, password }),
  me: () => api.get<MeResponse>("/auth/me"),
  register: (username: string, password: string) =>
    api.post<{ user: UserRecord }>("/auth/register", { username, password }),
  listUsers: () =>
    api.get<{ users: UserRecord[]; total: number }>("/auth/users"),
  updateUser: (
    id: number,
    updates: { role?: string; is_active?: boolean; password?: string },
  ) => api.patch<{ user: UserRecord }>(`/auth/users/${id}`, updates),
  deleteUser: (id: number) =>
    api.delete<{ success: boolean }>(`/auth/users/${id}`),
};

// =====================================================================
// Admin API (proxied through JWT auth)
// =====================================================================

export interface ApiKeyRecord {
  id: number;
  name: string;
  key_hash: string;
  prefix: string;
  scopes: string;
  rate_limit_per_minute: number;
  is_active: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  total_requests: number;
}

export interface BanRecord {
  id: number;
  target_type: string;
  target_value: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  created_by: string;
}

export const adminApi = {
  // Keys
  listKeys: () =>
    api.get<{ keys: ApiKeyRecord[]; total: number }>("/admin/keys"),
  createKey: (data: {
    name: string;
    scopes?: string;
    rate_limit_per_minute?: number;
    expires_in_days?: number;
  }) => api.post<{ key: ApiKeyRecord; raw_key: string }>("/admin/keys", data),
  updateKey: (
    id: number,
    data: {
      name?: string;
      scopes?: string;
      rate_limit_per_minute?: number;
      is_active?: boolean;
    },
  ) => api.patch<{ key: ApiKeyRecord }>(`/admin/keys/${id}`, data),
  deleteKey: (id: number) =>
    api.delete<{ success: boolean }>(`/admin/keys/${id}`),

  // Bans
  listBans: () => api.get<{ bans: BanRecord[]; total: number }>("/admin/bans"),
  createBan: (data: {
    target_type: string;
    target_value: string;
    reason: string;
    duration_hours?: number;
  }) => api.post<{ ban: BanRecord }>("/admin/bans", data),
  deleteBan: (id: number) =>
    api.delete<{ success: boolean }>(`/admin/bans/${id}`),

  // Analytics
  getOverview: (params?: string) =>
    api.get<Record<string, unknown>>(
      `/admin/analytics/overview${params ? `?${params}` : ""}`,
    ),
  getTimeline: (params?: string) =>
    api.get<Record<string, unknown>>(
      `/admin/analytics/timeline${params ? `?${params}` : ""}`,
    ),
  getUsers: (params?: string) =>
    api.get<Record<string, unknown>>(
      `/admin/analytics/users${params ? `?${params}` : ""}`,
    ),
  getOperations: (params?: string) =>
    api.get<Record<string, unknown>>(
      `/admin/analytics/operations${params ? `?${params}` : ""}`,
    ),
  getErrors: (params?: string) =>
    api.get<Record<string, unknown>>(
      `/admin/analytics/errors${params ? `?${params}` : ""}`,
    ),
  getHitRate: (params?: string) =>
    api.get<Record<string, unknown>>(
      `/admin/analytics/hit-rate${params ? `?${params}` : ""}`,
    ),

  // Audit
  getAuditLogs: (params?: string) =>
    api.get<Record<string, unknown>>(
      `/admin/audit/logs${params ? `?${params}` : ""}`,
    ),

  // Config
  getConfig: () => api.get<Record<string, unknown>>("/admin/config"),
  updateConfig: (data: Record<string, unknown>) =>
    api.patch<Record<string, unknown>>("/admin/config", data),
  resetConfig: () => api.post<Record<string, unknown>>("/admin/config/reset"),

  // Actions
  getActions: () => api.get<Record<string, unknown>>("/admin/actions"),
};
