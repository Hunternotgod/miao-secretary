/**
 * 监控列表管理
 * 读取 PC 微信聊天记录,选择要监控的群/单聊。
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  Users,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  MessageSquare,
  RefreshCw,
  Search,
  Check,
  AlertCircle,
  Clock,
  Pause,
  Play, Loader2, CheckCircle2,
  X,
  ChevronDown,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

function formatRelative(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86400)} 天`;
}

/**
 * 把小时数格式化成人类可读字符串:
 * - 1 / 6 → "1 时" / "6 时"
 * - 24 / 72 / 168 / 720 → "1 天" / "3 天" / "7 天" / "30 天"
 * - 其他整除 24 → "N 天"
 * - 兜底 → "N 时"
 */
function formatBackfillHours(h: number): string {
  if (h < 24 && Number.isInteger(h)) return `${h} 时`;
  if (h === 24) return "1 天";
  if (h === 72) return "3 天";
  if (h === 168) return "7 天";
  if (h === 720) return "30 天";
  if (h % 24 === 0) return `${h / 24} 天`;
  return `${h} 时`;
}
import { useApp } from "../lib/store/AppContext";
import { sidecarRequest, getAppInfo } from "../lib/tauri/commands";
import { SCHEDULE_PRESETS, nextPollHint, DEFAULT_INTERVAL_SEC, DEFAULT_DAILY_TIMES, splitSeconds, joinSeconds, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC, DEFAULT_BACKFILL_HOURS } from "../lib/monitor/schedule";
import { forcePollOne, usePollingStatus } from "../lib/monitor/useMonitorLoop";
import { toast } from "../components/ui/Toast";
import type { MonitorSchedule } from "../lib/store/config";
import {
  loadNotifications,
  subscribeNotifications,
} from "../lib/store/notifications";

interface WeChatSession {
  chat: string;
  username: string;
  is_group: boolean;
  unread: number;
  last_message: string;
  msg_type: string;
  sender: string;
  timestamp: number;
  time: string;
}

export default function Monitors() {
  const { config, update } = useApp();
  const pollStatus = usePollingStatus();
  const navigate = useNavigate();
  // 记录「正在 force-poll」的监控 id(用于按钮 spinner)
  const [forcePolling, setForcePolling] = useState<Set<string>>(new Set());
  const [forceDoneFlash, setForceDoneFlash] = useState<Set<string>>(new Set());
  const [prevBackfilling, setPrevBackfilling] = useState<Set<string>>(new Set());

  // 监听 pollStatus.backfilling 变化,完成后弹 toast
  useEffect(() => {
    const current = pollStatus.backfilling;
    // 找出这次有但上次没有的(刚完成)
    const justFinished = Array.from(prevBackfilling).filter(id => !current.has(id));
    for (const id of justFinished) {
      // 找监控名称
      const m = config.monitors.find(x => x.chatroomId === id);
      if (m) {
        // 是否有错误?
        if (pollStatus.lastErrors[id]) {
          toast.error(`${m.name} 拉取失败: ${pollStatus.lastErrors[id]}`, {
            duration: 5000,
            action: { label: '重试', onClick: () => doForcePoll(id, m.name) },
          });
        } else {
          // 成功
          toast.success(`${m.name} 已拉取`, { duration: 2500 });
        }
      }
      // 触发按钮 ✓ flash
      setForceDoneFlash(prev => new Set([...prev, id]));
      setTimeout(() => {
        setForceDoneFlash(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 600);
    }
    setPrevBackfilling(current);
  }, [pollStatus.backfilling, pollStatus.lastErrors, config.monitors, prevBackfilling]);

  // ===== 微信会话状态 =====
  const [sessions, setSessions] = useState<WeChatSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [onlyGroups, setOnlyGroups] = useState(true);
  // 新加监控的默认回补窗口(小时)
  const [defaultBackfillHours, setDefaultBackfillHours] = useState<number>(168);
  const BACKFILL_PRESETS: Array<{ h: number; label: string }> = [
    { h: 1, label: "1 时" },
    { h: 6, label: "6 时" },
    { h: 24, label: "1 天" },
    { h: 72, label: "3 天" },
    { h: 168, label: "7 天" },
    { h: 720, label: "30 天" },
  ];

  // 「立即拉取」下拉菜单:控制哪个监控的下拉开着
  const [openForceMenu, setOpenForceMenu] = useState<string | null>(null);

  // 立即拉取(含可选时间范围):null startSec = 增量(默认);数字 = 从那一刻起
  function doForcePoll(chatroomId: string, name: string, hours?: number) {
    setForcePolling(prev => new Set([...prev, chatroomId]));
    const startSec = hours === undefined
      ? undefined
      : Math.floor(Date.now() / 1000) - hours * 3600;
    forcePollOne(chatroomId, name, { startSec });
    setTimeout(() => {
      setForcePolling(prev => {
        const next = new Set(prev);
        next.delete(chatroomId);
        return next;
      });
    }, 5000);
    setOpenForceMenu(null);
  }

  // About 信息
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    getAppInfo().then((i) => setAppVersion(i.version)).catch(() => {});
  }, []);

  // 已添加的 username 集合
  const addedUsernames = useMemo(
    () => new Set(config.monitors.map((m) => m.chatroomId)),
    [config.monitors],
  );

  // 已配置监控群对应的通知数(用于判断「⚠️ 空监控」)
  // 用户反馈:清空 IndexedDB 后空监控常驻看不出 → 用此 Map 给视觉提示
  const [notifByConv, setNotifByConv] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    const refresh = async () => {
      try {
        const items = await loadNotifications();
        const m = new Map<string, number>();
        for (const n of items) {
          if (n.conversationId) {
            m.set(n.conversationId, (m.get(n.conversationId) ?? 0) + 1);
          }
        }
        setNotifByConv(m);
      } catch {
        // db 已删等情况静默
        setNotifByConv(new Map());
      }
    };
    refresh();
    const unsub = subscribeNotifications(refresh);
    return () => unsub();
  }, []);

  const toggleMonitor = (id: string) => {
    update({
      monitors: config.monitors.map((m) =>
        m.chatroomId === id ? { ...m, enabled: !m.enabled } : m,
      ),
    });
  };

  const setSchedule = (id: string, schedule: MonitorSchedule) => {
    update({
      monitors: config.monitors.map((m) => {
        if (m.chatroomId !== id) return m;
        // 切换档位时,补一个合理的默认值,避免空白
        if (schedule === "interval" && (!m.intervalSeconds || m.intervalSeconds <= 0)) {
          return { ...m, schedule, intervalSeconds: DEFAULT_INTERVAL_SEC };
        }
        if (schedule === "daily" && (!m.dailyTimes || m.dailyTimes.length === 0)) {
          return { ...m, schedule, dailyTimes: [...DEFAULT_DAILY_TIMES] };
        }
        return { ...m, schedule };
      }),
    });
  };

  const setIntervalSeconds = (id: string, seconds: number) => {
    const clamped = Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.round(seconds)));
    update({
      monitors: config.monitors.map((m) =>
        m.chatroomId === id ? { ...m, intervalSeconds: clamped } : m,
      ),
    });
  };

  const setDailyTimes = (id: string, times: string[]) => {
    update({
      monitors: config.monitors.map((m) =>
        m.chatroomId === id ? { ...m, dailyTimes: times } : m,
      ),
    });
  };

  /** 设置首次拉取回补窗口(小时)。仅对未轮询过的监控生效。 */
  const setBackfillHours = (id: string, hours: number) => {
    update({
      monitors: config.monitors.map((m) =>
        m.chatroomId === id ? { ...m, backfillHours: hours } : m,
      ),
    });
  };

  /** 全部暂停(把 enabled=false,但保留 schedule,用户可一键恢复) */
  const pauseAll = () => {
    if (!confirm("暂停所有监控?已设置的 schedule 会保留,只是不再自动跑")) return;
    update({
      monitors: config.monitors.map((m) => ({ ...m, enabled: false })),
    });
  };

  const resumeAll = () => {
    update({
      monitors: config.monitors.map((m) => ({ ...m, enabled: true })),
    });
  };

  const removeMonitor = (id: string) => {
    update({
      monitors: config.monitors.filter((m) => m.chatroomId !== id),
    });
  };

  // ===== 加载会话 =====
  const loadSessions = async () => {
    setLoadingSessions(true);
    setSessionsError(null);
    try {
      const list = await sidecarRequest<WeChatSession[]>(
        "GET",
        "/wechat/sessions?limit=200",
      );
      setSessions(list);
    } catch (e: any) {
      const msg = e?.message || String(e) || "加载失败";
      if (
        msg.includes("WeChatError") ||
        msg.includes("未初始化") ||
        msg.includes("not initialized") ||
        msg.includes("session.db")
      ) {
        setSessionsError("微信通道尚未初始化，请先到「数据源」完成初始化。");
      } else {
        setSessionsError(msg);
      }
    } finally {
      setLoadingSessions(false);
    }
  };

  // 进入页面就自动加载一次
  useEffect(() => {
    loadSessions();
  }, []);

  const addSession = (s: WeChatSession) => {
    if (addedUsernames.has(s.username)) return;
    update({
      monitors: [
        ...config.monitors,
        {
          chatroomId: s.username,
          name: s.chat || s.username,
          enabled: true,
          backfillHours: defaultBackfillHours,
        },
      ],
    });
  };

  // 过滤后的会话
  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    return sessions
      .filter((s) => !onlyGroups || s.is_group)
      .filter((s) => {
        if (!q) return true;
        const hay = `${s.chat} ${s.sender} ${s.last_message}`.toLowerCase();
        return hay.includes(q);
      });
  }, [sessions, sessionSearch, onlyGroups]);

  const addedInFiltered = filteredSessions.filter((s) =>
    addedUsernames.has(s.username),
  ).length;

  return (
    <div className="h-full flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-3">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Users className="w-5 h-5" />
          监控列表
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">
          从微信最近会话里选择要监控的群和好友
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-4">
          {/* ========== 微信最近会话(主要添加方式) ========== */}
          <div className="card">
            <h3 className="font-medium mb-1">从微信最近会话添加</h3>
            <p className="text-xs text-gray-500 mb-3">
              需先在「数据源」初始化微信通道（需要 PC 微信已登录）
            </p>

            {/* 新加监控的默认拉取范围 */}
            <div className="mb-3 pb-3 border-b border-gray-100">
              <div className="text-xs text-gray-500 mb-1.5">新监控首次拉取范围：</div>
              <div className="flex flex-wrap gap-1">
                {BACKFILL_PRESETS.map((opt) => (
                  <button
                    key={opt.h}
                    onClick={() => setDefaultBackfillHours(opt.h)}
                    className={`px-2 py-0.5 text-xs rounded ${
                      defaultBackfillHours === opt.h
                        ? "bg-brand-500 text-white"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 工具栏 */}
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  className="input pl-8 text-sm"
                  placeholder="搜索会话名 / 发送者 / 最近消息"
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-1.5 text-sm text-gray-600 px-2 shrink-0 select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyGroups}
                  onChange={(e) => setOnlyGroups(e.target.checked)}
                  className="rounded"
                />
                只看群
              </label>
              <button
                onClick={loadSessions}
                disabled={loadingSessions}
                className="btn-secondary shrink-0 text-sm"
                title="刷新会话列表"
              >
                <RefreshCw className={`w-4 h-4 ${loadingSessions ? "animate-spin" : ""}`} />
              </button>
            </div>

            {/* 错误提示 */}
            {sessionsError && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 mb-3 text-sm text-amber-800">
                <AlertCircle className="w-4 h-4 inline mr-1" />
                {sessionsError}
                {sessionsError.includes("数据源") && (
                  <button
                    onClick={() => navigate("/data-sources")}
                    className="ml-2 underline"
                  >
                    去初始化 →
                  </button>
                )}
              </div>
            )}

            {/* 加载中 / 空状态 / 列表 */}
            {loadingSessions ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                <RefreshCw className="w-5 h-5 inline animate-spin mr-2" />
                正在读取微信会话...
              </div>
            ) : sessions.length === 0 && !sessionsError ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                <MessageSquare className="w-8 h-8 inline mb-2 opacity-50" />
                <p>点击右侧 ↻ 按钮加载最近会话</p>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm">
                没有匹配的会话
              </div>
            ) : (
              <div className="space-y-1.5 max-h-96 overflow-y-auto -mx-1 px-1">
                {filteredSessions.map((s) => {
                  const added = addedUsernames.has(s.username);
                  return (
                    <div
                      key={s.username}
                      className={`flex items-center gap-3 p-2.5 rounded-md border ${
                        added
                          ? "bg-green-50 border-green-200"
                          : "bg-white border-gray-200 hover:border-brand-300 hover:bg-brand-50/30"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-sm truncate">
                            {s.chat || s.username}
                          </span>
                          {s.is_group ? (
                            <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded shrink-0">
                              群
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded shrink-0">
                              单聊
                            </span>
                          )}
                          {s.unread > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-red-500 text-white rounded-full shrink-0">
                              {s.unread}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 truncate mt-0.5">
                          {s.is_group && s.sender && (
                            <span className="text-gray-600">{s.sender}: </span>
                          )}
                          {s.last_message || `(${s.msg_type})`}
                        </div>
                      </div>
                      <span className="text-[10px] text-gray-400 shrink-0">
                        {s.time}
                      </span>
                      <button
                        onClick={() => addSession(s)}
                        disabled={added}
                        className={`shrink-0 text-sm px-2.5 py-1 rounded-md ${
                          added
                            ? "bg-green-100 text-green-700 cursor-default"
                            : "bg-brand-500 text-white hover:bg-brand-600"
                        }`}
                        title={added ? "已添加到监控" : "添加到监控"}
                      >
                        {added ? (
                          <>
                            <Check className="w-3.5 h-3.5 inline mr-0.5" />
                            已添加
                          </>
                        ) : (
                          <>
                            <Plus className="w-3.5 h-3.5 inline mr-0.5" />
                            添加
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {sessions.length > 0 && (
              <div className="text-xs text-gray-400 mt-3">
                共 {sessions.length} 个会话，显示 {filteredSessions.length} 个 · 已添加 {addedInFiltered} 个
              </div>
            )}
          </div>

          {/* ========== 当前监控的会话 ========== */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium">
                当前监控
                <span className="text-xs text-gray-400 font-normal ml-2">
                  ({config.monitors.filter((m) => m.enabled).length}/{config.monitors.length} 启用)
                </span>
              </h3>
              {config.monitors.length > 0 && (
                <div className="flex gap-1.5">
                  {config.monitors.some((m) => m.enabled) ? (
                    <button
                      onClick={pauseAll}
                      className="text-xs px-2 py-1 text-gray-600 hover:text-amber-700 hover:bg-amber-50 rounded flex items-center gap-1"
                      title="暂停所有监控(保留 schedule)"
                    >
                      <Pause className="w-3 h-3" />
                      全部暂停
                    </button>
                  ) : (
                    <button
                      onClick={resumeAll}
                      className="text-xs px-2 py-1 text-gray-600 hover:text-green-700 hover:bg-green-50 rounded flex items-center gap-1"
                      title="启动所有监控"
                    >
                      <Play className="w-3 h-3" />
                      全部启动
                    </button>
                  )}
                </div>
              )}
            </div>

            {config.monitors.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">还没有添加监控</p>
                <p className="text-xs text-gray-400 mt-1">
                  从上方微信会话里点「+ 添加」
                  {appVersion && ` · v${appVersion}`}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {config.monitors.map((m) => {
                  // 反查一下原始会话,显示最后消息预览(如果在列表里)
                  const live = sessions.find((s) => s.username === m.chatroomId);
                  return (
                    <div
                      key={m.chatroomId}
                      className="flex items-center gap-3 p-2.5 rounded-md border border-gray-200"
                    >
                      <Users className="w-5 h-5 text-gray-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div
                          className="font-medium text-sm truncate"
                          title={m.name}
                        >
                          {m.name}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {pollStatus.backfilling.has(m.chatroomId) && (
                            <span
                              className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded shrink-0 flex items-center gap-0.5 animate-pulse-dot"
                              title="自动补拉:软件关闭期间错过的消息,下次打开会按这个窗口补拉"
                            >
                              <span className="animate-pulse">●</span>
                              拉取最近 {formatBackfillHours(m.backfillHours ?? DEFAULT_BACKFILL_HOURS)}
                            </span>
                          )}
                          {pollStatus.clustering.has(m.chatroomId) && (
                            <span className="text-[10px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded shrink-0 flex items-center gap-0.5 animate-pulse-dot">
                              <span className="animate-pulse">●</span>
                              分簇中
                            </span>
                          )}
                          {pollStatus.aiAnalyzing.has(m.chatroomId) && (
                            <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded shrink-0 flex items-center gap-0.5 animate-pulse-dot">
                              <span className="animate-pulse">●</span>
                              AI 分析中
                            </span>
                          )}
                          {pollStatus.lastErrors[m.chatroomId] && !pollStatus.backfilling.has(m.chatroomId) && !pollStatus.clustering.has(m.chatroomId) && !pollStatus.aiAnalyzing.has(m.chatroomId) && (
                            <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded shrink-0" title={pollStatus.lastErrors[m.chatroomId]}>
                              ❌ 错误
                            </span>
                          )}
                          {m.lastPolledAt && !pollStatus.backfilling.has(m.chatroomId) && !pollStatus.clustering.has(m.chatroomId) && !pollStatus.aiAnalyzing.has(m.chatroomId) && !pollStatus.lastErrors[m.chatroomId] && (
                            <span className="text-[11px] text-gray-700 font-medium shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
                              <span
                                className="flex items-center gap-1"
                                title={`上次同步:${new Date(m.lastPolledAt).toLocaleString("zh-CN")} · 距今 ${formatRelative(Date.now() - m.lastPolledAt)}`}
                              >
                                <span className="text-gray-400">⏱</span>
                                <span>上次同步:{new Date(m.lastPolledAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                              </span>
                              {m.lastPolledMessageCount !== undefined && m.lastPolledMessageCount > 0 && (
                                <span
                                  className="flex items-center gap-1 text-blue-700"
                                  title="上一次轮询时新拉取的消息数(进入 AI 分析队列)"
                                >
                                  <span>📥</span>未同步 {m.lastPolledMessageCount} 条
                                </span>
                              )}
                              {m.lastPolledClusterCount !== undefined && m.lastPolledClusterCount > 0 && (
                                <span className="flex items-center gap-1 text-violet-700">
                                  <span>🔀</span>{m.lastPolledClusterCount} 簇
                                </span>
                              )}
                              {m.lastPolledCacheHits !== undefined && m.lastPolledCacheHits > 0 && (
                                <span className="flex items-center gap-1 text-green-700">
                                  <span>⚡</span>命中缓存 {m.lastPolledCacheHits}
                                </span>
                              )}
                            </span>
                          )}
                          {!m.lastPolledAt && m.enabled && !pollStatus.backfilling.has(m.chatroomId) && !pollStatus.clustering.has(m.chatroomId) && !pollStatus.aiAnalyzing.has(m.chatroomId) && (
                            <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded shrink-0">
                              ⏳ 首次轮询中…
                            </span>
                          )}
                          {/* 已轮询过但 IndexedDB 仍空(典型:刚清空 IndexedDB):视觉提示 */}
                          {m.lastPolledAt && (notifByConv.get(m.chatroomId) ?? 0) === 0 && !pollStatus.backfilling.has(m.chatroomId) && !pollStatus.clustering.has(m.chatroomId) && !pollStatus.aiAnalyzing.has(m.chatroomId) && (
                            <span
                              className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded shrink-0 flex items-center gap-0.5"
                              title="此监控已轮询过,但目前 IndexedDB 中没有它的通知数据。可能是:① 该时段确实没文本消息 ② IndexedDB 刚被清空(用右上的「清空监控列表」或重新立即拉取)"
                            >
                              ⚠️ 暂无数据
                            </span>
                          )}
                        </div>
                        {live ? (
                          <div className="text-xs text-gray-500 truncate mt-0.5">
                            {live.is_group && live.sender && (
                              <span className="text-gray-600">{live.sender}: </span>
                            )}
                            {live.last_message || `(${live.msg_type})`}
                            <span className="text-gray-300 ml-2">{live.time}</span>
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 truncate mt-0.5">
                            最近无活动
                          </div>
                        )}
                      </div>
                      <ScheduleControl
                        monitor={m}
                        onSchedule={(s) => setSchedule(m.chatroomId, s)}
                        onIntervalChange={(secs) => setIntervalSeconds(m.chatroomId, secs)}
                        onTimesChange={(times) => setDailyTimes(m.chatroomId, times)}
                        onBackfillHoursChange={(h) => setBackfillHours(m.chatroomId, h)}
                      />
                      {m.enabled && (
                        <div className="relative shrink-0 flex items-stretch rounded overflow-hidden border border-gray-200">
                          <button
                            onClick={() => doForcePoll(m.chatroomId, m.name)}
                            disabled={forcePolling.has(m.chatroomId)}
                            className={clsx(
                              "px-1.5 py-1 transition-all",
                              forcePolling.has(m.chatroomId) && "text-brand-500 bg-gray-50 animate-pulse",
                              forceDoneFlash.has(m.chatroomId) && "text-green-500 bg-green-50",
                              !forcePolling.has(m.chatroomId) && !forceDoneFlash.has(m.chatroomId) && "text-gray-500 hover:text-brand-600 hover:bg-gray-50"
                            )}
                            title={(() => {
                              const t = m.lastPolledAt
                                ? `上次同步:${new Date(m.lastPolledAt).toLocaleString("zh-CN")}`
                                : "尚未同步过";
                              const n = m.lastPolledMessageCount !== undefined
                                ? ` · 未同步 ${m.lastPolledMessageCount} 条`
                                : "";
                              return `立即增量拉取(上次轮询至今)\n${t}${n}`;
                            })()}
                          >
                            {forceDoneFlash.has(m.chatroomId) ? (
                              <CheckCircle2 className="w-4 h-4" />
                            ) : forcePolling.has(m.chatroomId) ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Play className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={() => setOpenForceMenu(openForceMenu === m.chatroomId ? null : m.chatroomId)}
                            className="px-1 py-1 border-l border-gray-200 text-gray-500 hover:text-brand-600 hover:bg-gray-50"
                            title="选时间范围拉取"
                          >
                            <ChevronDown className="w-3 h-3" />
                          </button>
                          {openForceMenu === m.chatroomId && (
                            <>
                              {/* 点击外部关闭 */}
                              <div
                                className="fixed inset-0 z-10"
                                onClick={() => setOpenForceMenu(null)}
                              />
                              <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-md shadow-lg py-1 min-w-[160px]">
                                <div className="px-3 py-1 text-[10px] text-gray-400 border-b border-gray-100">
                                  选时间范围拉取
                                </div>
                                <button
                                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between"
                                  onClick={() => doForcePoll(m.chatroomId, m.name)}
                                >
                                  <span>↻ 增量(上次至今)</span>
                                </button>
                                {BACKFILL_PRESETS.map((opt) => (
                                  <button
                                    key={opt.h}
                                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between"
                                    onClick={() => doForcePoll(m.chatroomId, m.name, opt.h)}
                                  >
                                    <span>拉取最近 {opt.label}</span>
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      <button
                        onClick={() => toggleMonitor(m.chatroomId)}
                        className="text-gray-400 hover:text-brand-500 shrink-0"
                        title={m.enabled ? "已启用" : "已停用"}
                      >
                        {m.enabled ? (
                          <ToggleRight className="w-6 h-6 text-brand-500" />
                        ) : (
                          <ToggleLeft className="w-6 h-6" />
                        )}
                      </button>
                      <button
                        onClick={() => removeMonitor(m.chatroomId)}
                        className="text-gray-300 hover:text-red-500 shrink-0"
                        title="删除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 调度控制组件(小白友好版)
 * - interval: 数字输入 + 单位下拉
 * - daily: 时间点 chips,可加减
 */
const BACKFILL_OPTIONS: Array<{ h: number; label: string }> = [
  { h: 1, label: "1 时" },
  { h: 6, label: "6 时" },
  { h: 24, label: "1 天" },
  { h: 72, label: "3 天" },
  { h: 168, label: "7 天" },
  { h: 720, label: "30 天" },
];

function ScheduleControl({
  monitor,
  onSchedule,
  onIntervalChange,
  onTimesChange,
  onBackfillHoursChange,
}: {
  monitor: {
    schedule?: MonitorSchedule;
    intervalSeconds?: number;
    dailyTimes?: string[];
    backfillHours?: number;
    lastPolledAt?: number;
    enabled: boolean;
  };
  onSchedule: (s: MonitorSchedule) => void;
  onIntervalChange: (mins: number) => void;
  onTimesChange: (times: string[]) => void;
  onBackfillHoursChange: (h: number) => void;
}) {
  const backfillHours = monitor.backfillHours ?? 168;
  const schedule: MonitorSchedule = monitor.schedule ?? "interval";
  const preset = SCHEDULE_PRESETS.find((p) => p.id === schedule) ?? SCHEDULE_PRESETS[2];

  const hint = nextPollHint(
    schedule,
    monitor.lastPolledAt,
    monitor.intervalSeconds,
    monitor.dailyTimes,
    monitor.enabled,
  );

  // interval 子组件(秒数从 monitor 读,UI 拆成时/分/秒)
  const intervalSeconds = monitor.intervalSeconds ?? DEFAULT_INTERVAL_SEC;

  // daily 子组件
  const times = monitor.dailyTimes ?? DEFAULT_DAILY_TIMES;

  function addTime() {
    // 默认加 18:00,或基于最后一个时间点 + 3 小时
    const last = times[times.length - 1];
    let newTime = "18:00";
    if (last) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(last);
      if (m) {
        const h = (parseInt(m[1], 10) + 3) % 24;
        newTime = `${h.toString().padStart(2, "0")}:${m[2]}`;
      }
    }
    onTimesChange([...times, newTime].sort());
  }

  function removeTime(t: string) {
    onTimesChange(times.filter((x) => x !== t));
  }

  function updateTime(idx: number, value: string) {
    const next = [...times];
    next[idx] = value;
    onTimesChange(next.sort());
  }

  return (
    <div className="flex flex-col items-end gap-1 shrink-0 min-w-[140px]">
      {/* 调度下拉 */}
      <div className="flex items-center gap-1">
        <Clock className="w-3 h-3 text-gray-400" />
        <select
          value={schedule}
          onChange={(e) => onSchedule(e.target.value as MonitorSchedule)}
          className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white hover:border-brand-400 focus:border-brand-500 focus:outline-none"
          title={preset.description}
        >
          {SCHEDULE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.emoji} {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* interval 配置 - 时/分/秒 三字段 + +/- 步进 */}
      {schedule === "interval" && (
        <IntervalStepper
          totalSeconds={intervalSeconds}
          onChange={onIntervalChange}
        />
      )}

      {/* daily 配置 */}
      {schedule === "daily" && (
        <div className="flex flex-col items-end gap-1 w-full">
          {times.map((t, idx) => (
            <div key={`${t}-${idx}`} className="flex items-center gap-1">
              <input
                type="time"
                value={t}
                onChange={(e) => updateTime(idx, e.target.value)}
                className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white"
              />
              <button
                onClick={() => removeTime(t)}
                className="text-gray-300 hover:text-red-500"
                title="删除"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          <button
            onClick={addTime}
            className="text-[10px] text-brand-600 hover:text-brand-700 flex items-center gap-0.5"
            title="加一个时间点"
          >
            <Plus className="w-3 h-3" />
            加一个时间点
          </button>
        </div>
      )}

      {/* 首次拉取范围(只对未轮询过的监控生效) */}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-gray-400">首次:</span>
        <select
          value={backfillHours}
          onChange={(e) => onBackfillHoursChange(parseInt(e.target.value, 10))}
          className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white hover:border-brand-400 focus:border-brand-500 focus:outline-none"
          title="首次启动时往回拉多久的消息(小时)。新监控会用这个时间窗,已轮询过的不会重拉。"
        >
          {BACKFILL_OPTIONS.map((o) => (
            <option key={o.h} value={o.h}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* 提示 */}
      {hint && <span className="text-[10px] text-gray-400">{hint}</span>}
    </div>
  );
}

/**
 * 间隔步进器:时/分/秒 三字段 + +/- 按钮
 *
 * UI 长这样:
 *   [-]  [ 0  ]  [+]   时
 *   [-]  [ 5  ]  [+]   分
 *   [-]  [ 20 ]  [+]   秒
 *
 *   (= 每 5 分 20 秒 = 320 秒)
 *
 * 用户可以:
 * - 直接输入数字(快速)
 * - 点 +/- 按钮步进(微调)
 * - 任意精度组合(支持秒级)
 */
function IntervalStepper({
  totalSeconds,
  onChange,
}: {
  totalSeconds: number;
  onChange: (totalSeconds: number) => void;
}) {
  const { h, m, s } = splitSeconds(totalSeconds);

  function update(field: "h" | "m" | "s", delta: number) {
    const cur = { h, m, s };
    cur[field] = Math.max(0, cur[field] + delta);
    if (field === "m" && cur.m > 59) { cur.h += 1; cur.m -= 60; }
    if (field === "s" && cur.s > 59) { cur.m += 1; cur.s -= 60; }
    if (field === "h" && cur.h < 0) { cur.h = 0; }
    onChange(joinSeconds(cur.h, cur.m, cur.s));
  }

  function setField(field: "h" | "m" | "s", value: string) {
    const n = parseInt(value, 10);
    if (isNaN(n)) return;
    const cur = { h, m, s };
    if (field === "m") cur.m = Math.max(0, Math.min(59, n));
    else if (field === "s") cur.s = Math.max(0, Math.min(59, n));
    else cur.h = Math.max(0, n);
    onChange(joinSeconds(cur.h, cur.m, cur.s));
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <FieldUnit label="时" value={h} onChange={(v) => setField("h", v)} onStep={(d) => update("h", d)} stepSize={1} min={0} max={99} width={36} />
        <span className="text-xs text-gray-400">:</span>
        <FieldUnit label="分" value={m} onChange={(v) => setField("m", v)} onStep={(d) => update("m", d)} stepSize={5} min={0} max={59} width={36} />
        <span className="text-xs text-gray-400">:</span>
        <FieldUnit label="秒" value={s} onChange={(v) => setField("s", v)} onStep={(d) => update("s", d)} stepSize={5} min={0} max={59} width={36} />
      </div>
      <span className="text-[10px] text-gray-400">
        = 每 {totalSeconds} 秒
        {totalSeconds >= 60 && `(${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒)`}
      </span>
    </div>
  );
}

/** 单个数字字段 + +/- 步进按钮 */
function FieldUnit({
  label,
  value,
  onChange,
  onStep,
  stepSize,
  min,
  max,
  width,
}: {
  label: string;
  value: number;
  onChange: (v: string) => void;
  onStep: (delta: number) => void;
  stepSize: number;
  min: number;
  max: number;
  width: number;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center">
        <button
          onClick={() => onStep(-stepSize)}
          disabled={value <= min}
          className="w-4 h-4 text-[10px] text-gray-500 hover:text-brand-600 hover:bg-brand-50 rounded-l border border-r-0 border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title={`-${stepSize}`}
        >
          −
        </button>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={min}
          max={max}
          className="h-4 text-[10px] text-center border border-gray-200 focus:border-brand-500 focus:outline-none [-moz-appearance:_textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          style={{ width: `${width}px` }}
        />
        <button
          onClick={() => onStep(stepSize)}
          disabled={value >= max}
          className="w-4 h-4 text-[10px] text-gray-500 hover:text-brand-600 hover:bg-brand-50 rounded-r border border-l-0 border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          title={`+${stepSize}`}
        >
          +
        </button>
      </div>
      <span className="text-[9px] text-gray-400 mt-0.5">{label}</span>
    </div>
  );
}
