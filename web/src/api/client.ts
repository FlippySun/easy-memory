/**
 * API 客户端 — 统一的 HTTP 请求封装。
 * SEC-COOKIE: JWT 通过 httpOnly cookie 传递，不再使用 localStorage。
 * 自动处理 401 → 尝试 refresh → 失败则跳转登录。
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

// =====================================================================
// Token Refresh 机制 — 防止并发 refresh 竞态
// =====================================================================

/** 是否正在刷新中 */
let isRefreshing = false;
/** 排队等待 refresh 完成的请求 */
let refreshQueue: Array<{
  resolve: (value: boolean) => void;
}> = [];

/**
 * 尝试通过 refresh token 续签 access token。
 * 使用锁机制防止多个并发 401 同时触发 refresh。
 * @returns true 如果 refresh 成功，false 如果失败（需要重新登录）
 */
async function tryRefresh(): Promise<boolean> {
  if (isRefreshing) {
    // 已有 refresh 请求正在飞行 — 排队等待结果
    return new Promise<boolean>((resolve) => {
      refreshQueue.push({ resolve });
    });
  }

  isRefreshing = true;

  // C2 FIX: 超时控制 — 防止网关挂起导致全局 API 死锁
  const controller = new AbortController();
  const refreshTimeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    });

    const success = res.ok;

    // 通知所有排队的请求
    refreshQueue.forEach((q) => q.resolve(success));
    refreshQueue = [];

    return success;
  } catch {
    // C1 FIX: resolve(false) 而非 reject — 确保排队请求统一走登录重定向路径
    refreshQueue.forEach((q) => q.resolve(false));
    refreshQueue = [];
    return false;
  } finally {
    clearTimeout(refreshTimeout);
    isRefreshing = false;
  }
}

// =====================================================================
// 核心请求函数
// =====================================================================

async function request<T>(
  path: string,
  options: RequestInit = {},
  _retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  // SEC-COOKIE: 不再注入 Authorization header — JWT 通过 httpOnly cookie 自动携带
  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include", // 确保 cookie 随请求发送
  });

  if (res.status === 401 && !_retried) {
    // 首次 401 — 尝试 refresh token 续签
    const refreshed = await tryRefresh();
    if (refreshed) {
      // refresh 成功 — 重放原始请求 (标记为 retried 防止无限循环)
      return request<T>(path, options, true);
    }

    // refresh 失败 — 跳转登录页
    window.location.href = "/login";
    throw new ApiError(401, "Session expired, please login again");
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
  logout: () => api.post<{ success: boolean }>("/auth/logout"),
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
