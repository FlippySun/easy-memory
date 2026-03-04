import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { authApi, setToken, clearToken, type UserRecord } from "../api/client";

interface AuthState {
  user: UserRecord | null;
  permissions: string[];
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
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
      const token = localStorage.getItem("token");
      if (!token) {
        setState({
          user: null,
          permissions: [],
          isLoading: false,
          isAuthenticated: false,
        });
        return;
      }

      const { user, permissions } = await authApi.me();
      setState({ user, permissions, isLoading: false, isAuthenticated: true });
    } catch {
      clearToken();
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

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    setToken(res.token);

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

  const logout = useCallback(() => {
    clearToken();
    setState({
      user: null,
      permissions: [],
      isLoading: false,
      isAuthenticated: false,
    });
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
      value={{ ...state, login, logout, hasPermission, refreshUser }}
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
