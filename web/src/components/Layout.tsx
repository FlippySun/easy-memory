import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/auth";
import {
  LayoutDashboard,
  Key,
  KeyRound,
  ShieldBan,
  BarChart3,
  ScrollText,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
  Brain,
  ChevronDown,
} from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  permission?: string;
}

const navItems: NavItem[] = [
  { to: "/", label: "Dashboard", icon: <LayoutDashboard size={20} /> },
  {
    to: "/my-keys",
    label: "My API Keys",
    icon: <KeyRound size={20} />,
    permission: "keys:self",
  },
  {
    to: "/api-keys",
    label: "API Keys",
    icon: <Key size={20} />,
    permission: "keys:list",
  },
  {
    to: "/bans",
    label: "Bans",
    icon: <ShieldBan size={20} />,
    permission: "bans:list",
  },
  {
    to: "/analytics",
    label: "Analytics",
    icon: <BarChart3 size={20} />,
    permission: "analytics:read",
  },
  {
    to: "/audit",
    label: "Audit Logs",
    icon: <ScrollText size={20} />,
    permission: "audit:read",
  },
  {
    to: "/users",
    label: "Users",
    icon: <Users size={20} />,
    permission: "users:list",
  },
  {
    to: "/settings",
    label: "Settings",
    icon: <Settings size={20} />,
    permission: "config:read",
  },
];

export function Layout() {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const filteredNav = navItems.filter(
    (item) => !item.permission || hasPermission(item.permission),
  );

  return (
    <div className="min-h-screen flex bg-surface">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 
          flex flex-col transition-transform duration-300 ease-in-out
          lg:translate-x-0 lg:static lg:z-auto
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-200">
          <div className="p-2 rounded-lg bg-primary-600 text-white">
            <Brain size={22} />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900">Easy Memory</h1>
            <p className="text-xs text-slate-400">Admin Panel</p>
          </div>
          <button
            className="p-1 ml-auto rounded-md text-slate-400 hover:text-slate-600 lg:hidden cursor-pointer"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {filteredNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group ${
                  isActive
                    ? "bg-primary-50 text-primary-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`
              }
            >
              <span className="shrink-0 group-hover:scale-110 transition-transform duration-200">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User section */}
        <div className="border-t border-slate-200 p-3">
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-semibold text-sm">
                {user?.username.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 text-left">
                <p className="font-medium text-slate-900 truncate">
                  {user?.username}
                </p>
                <p className="text-xs text-slate-400 capitalize">
                  {user?.role}
                </p>
              </div>
              <ChevronDown
                size={16}
                className={`text-slate-400 transition-transform duration-200 ${
                  userMenuOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {userMenuOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-1 bg-white rounded-lg border border-slate-200 shadow-lg py-1 animate-scale-in">
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                >
                  <LogOut size={16} />
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center h-16 px-4 sm:px-6 bg-white/80 backdrop-blur-md border-b border-slate-200">
          <button
            className="p-2 rounded-md text-slate-500 hover:text-slate-700 hover:bg-slate-100 lg:hidden cursor-pointer"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
