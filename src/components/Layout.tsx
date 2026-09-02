/**
 * 主布局（侧边栏 + 内容区）
 * 使用 React Router v6 的 Outlet 模式
 */
import { Link, useLocation, Outlet } from "react-router-dom";
import { Home, Settings as SettingsIcon, Users, Database } from "lucide-react";
import appIcon from "../assets/app-icon.png";

export default function Layout() {
  const location = useLocation();

  const navItems = [
    { to: "/", icon: Home, label: "微信消息" },
    { to: "/monitors", icon: Users, label: "监控列表" },
    { to: "/data", icon: Database, label: "数据源" },
    { to: "/settings", icon: SettingsIcon, label: "设置" },
  ];

  return (
    <div className="flex h-screen bg-gray-50">
      {/* 侧边栏 */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-gray-200">
          <Link to="/" className="flex items-center gap-2">
            <img src={appIcon} alt="喵秘书" className="w-8 h-8 shrink-0 rounded-md" />
            <div>
              <div className="font-bold text-gray-900">喵秘书</div>
              <div className="text-xs text-gray-400">v1.0.0</div>
            </div>
          </Link>
        </div>

        {/* 导航 */}
        <nav className="flex-1 p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2 px-3 py-2 rounded-md mb-1 text-sm transition-colors ${
                  isActive
                    ? "bg-brand-50 text-brand-700 font-medium"
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* 底部提示 */}
        <div className="p-3 border-t border-gray-200">
          <div className="text-xs text-gray-400 leading-relaxed">
            🔔 通知会实时同步
          </div>
        </div>
      </aside>

      {/* 主内容区 - 用 Outlet 渲染子路由 */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
