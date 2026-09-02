/**
 * 主应用 - 智能引导路由
 *
 * 关键设计：
 * - onboarded=false 时：直接渲染 <Onboarding />，不用路由（避免嵌套 Routes 问题）
 * - onboarded=true 时：渲染主布局 + 主路由
 *
 * 这样 "重新走引导" 只需修改 state，不需要 navigate
 */
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider, useApp } from "./lib/store/AppContext";
import { ToastProvider } from "./components/ui/Toast";
import Onboarding from "./components/Onboarding";
import Layout from "./components/Layout";
import { devStartSidecar, sidecarRequest, startSidecar } from "./lib/tauri/commands";
import { useMonitorLoop } from "./lib/monitor/useMonitorLoop";
import Timeline from "./pages/Timeline";
import Monitors from "./pages/Monitors";
import Settings from "./pages/Settings";
import DataSources from "./pages/DataSources";

export default function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </AppProvider>
    </ToastProvider>
  );
}

/**
 * 应用外壳 - 根据 onboarded 状态决定渲染引导页还是主应用
 * 这层不放在路由里，避免嵌套 Routes 的复杂性
 */
function AppShell() {
  const { config } = useApp();

  // 应用一启动就尝试把 sidecar 后端拉起来（生产模式走 bundled，开发模式走 Python venv）
  // 失败静默：用户可以从数据源页手动启动
  useEffect(() => {
    (async () => {
      try {
        const health = await sidecarRequest("GET", "/health").catch(() => null);
        if (health) return; // 已起
        if (import.meta.env.DEV) {
          await devStartSidecar();
        } else {
          await startSidecar("binaries/miao-backend");
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // 后台监控轮询(每分钟检查一次,到点自动抓+分析+入库)
  useMonitorLoop();

  // 未配置 → 直接渲染 Onboarding（不用路由）
  if (!config.onboarded) {
    return <Onboarding />;
  }

  // 已配置 → 主应用
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Timeline />} />
        <Route path="/monitors" element={<Monitors />} />
        <Route path="/data" element={<DataSources />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:tab" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
