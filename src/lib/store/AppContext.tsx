/**
 * 全局应用 Context
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { loadConfig, saveConfig, type AppConfig } from "./config";

interface AppContextValue {
  config: AppConfig;
  refresh: () => void;
  update: (patch: Partial<AppConfig>) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());

  // 监听 storage 事件，多窗口同步
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "miao-secretary-config") {
        setConfig(loadConfig());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const refresh = () => setConfig(loadConfig());

  const update = (patch: Partial<AppConfig>) => {
    const updated = { ...config, ...patch };
    setConfig(updated);
    saveConfig(updated);
  };

  return (
    <AppContext.Provider value={{ config, refresh, update }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
