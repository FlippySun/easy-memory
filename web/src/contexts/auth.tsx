import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { authApi, type UserRecord } from "../api/client";

interface AuthState {
  user: UserRecord | null;
  permissions: string[];
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    permissions: [],
    isLoading: true,
    isAuthenticated: false,
  });

  const refreshUser = useCallback(async () => {
    try {
      // SEC-COOKIE: 不再检查 localStorage — cookie 由浏览器自动携带
      const { user, permissions } = await authApi.me();
      setState({ user, permissions, isLoading: false, isAuthenticated: true });
    } catch {
      setState({
        user: null,
        permissions: [],
        isLoading: false,
        isAuthenticated: false,
      });
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  // 监听 API 客户端发出的会话过期事件 — 清除前端认证状态（由 React Router 跳转 /login）
  useEffect(() => {
    const handler = () => {
      setState({
        user: null,
        permissions: [],
        isLoading: false,
        isAuthenticated: false,
      });
    };
    window.addEventListener("auth:session-expired", handler);
    return () => window.removeEventListener("auth:session-expired", handler);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    // SEC-COOKIE: 不再调用 setToken — httpOnly cookie 由服务端 Set-Cookie 写入

    // 先获取完整权限再更新状态，避免两阶段更新导致的权限闪烁
    let permissions: string[] = [];
    try {
      const me = await authApi.me();
      permissions = me.permissions;
    } catch {
      // 权限获取失败时以空数组兜底（admin 角色不受影响，hasPermission 会直接返回 true）
    }

    setState({
      user: res.user,
      permissions,
      isLoading: false,
      isAuthenticated: true,
    });
  }, []);

  /** 公开自助注册 — 注册成功后自动登录 (v0.6.0) */
  const register = useCallback(async (username: string, password: string) => {
    const res = await authApi.registerPublic(username, password);

    // 注册接口自动设置了 JWT cookies，获取完整权限
    let permissions: string[] = [];
    try {
      const me = await authApi.me();
      permissions = me.permissions;
    } catch {
      // 权限获取失败以空数组兜底
    }

    setState({
      user: res.user,
      permissions,
      isLoading: false,
      isAuthenticated: true,
    });
  }, []);

  const logout = useCallback(async () => {
    // W3 FIX: 立即清除前端状态 — 防止 await 期间的幽灵请求
    setState({
      user: null,
      permissions: [],
      isLoading: false,
      isAuthenticated: false,
    });
    try {
      // SEC-COOKIE: 调用后端 logout 端点清除 httpOnly cookies + 撤销 refresh tokens
      await authApi.logout();
    } catch {
      // 后端清理失败不影响前端状态（cookies 可能已过期）
    }
  }, []);

  const hasPermission = useCallback(
    (permission: string) => {
      if (state.user?.role === "admin") return true;
      return state.permissions.includes(permission);
    },
    [state.user, state.permissions],
  );

  return (
    <AuthContext.Provider
      value={{ ...state, login, register, logout, hasPermission, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
