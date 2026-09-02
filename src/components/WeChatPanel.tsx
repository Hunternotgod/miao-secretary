/**
 * PC 微信数据通道面板
 *
 * 流程：连接本地数据通道 → 检查状态 → 初始化 → 加载会话列表
 *      → 勾选群 → 选时间范围(24h/3d/7d/30d/全部) → AI 分析 → 入时间线
 *
 * 所有微信数据操作都在本机完成（经由本地数据通道）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Play,
  RefreshCw,
  KeyRound,
  MessageSquare,
  Loader2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader,
  Sparkles,
} from "lucide-react";
import { devStartSidecar, sidecarRequest } from "../lib/tauri/commands";
import { classifyError, type ErrorSeverity } from "../lib/errors";
import { useAnalyzer } from "../lib/ai/useAnalyzer";
import ErrorBanner from "./ui/ErrorBanner";
import clsx from "clsx";
import { toast } from "./ui/Toast";
import {
  addNotifications,
  createNotificationId,
  type NotificationImportance,
  type NotificationItem,
} from "../lib/store/notifications";

interface WeChatStatus {
  platform: string;
  supported: boolean;
  wechat_process: string;
  db_dir: string;
  initialized: boolean;
  keys_count: number;
  state_dir: string;
}

interface SessionItem {
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

interface HistoryMessage {
  timestamp: number;
  time: string;
  chat: string;
  sender: string;
  msg_type: string;
  text: string;
}

type Phase = "checking" | "needBackend" | "ready";

export default function WeChatPanel() {
  const navigate = useNavigate();
  const { analyze } = useAnalyzer();

  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorMeta, setErrorMeta] = useState<{ retryable: boolean; severity: ErrorSeverity } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reportError = useCallback((e: unknown) => {
    const c = classifyError(e);
    setError(c.userMessage);
    setErrorMeta({ retryable: c.retryable, severity: c.severity });
  }, []);

  const reportErrorString = useCallback(
    (msg: string, retryable: boolean, severity: ErrorSeverity) => {
      setError(msg);
      setErrorMeta({ retryable, severity });
    },
    [],
  );

  const dismissError = useCallback(() => {
    setError(null);
    setErrorMeta(null);
  }, []);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyGroups, setOnlyGroups] = useState(true);
  // 每 5 秒拉一次 status，sidecar 起来后自动跟进
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // 阶段化进度
  const [progressStage, setProgressStage] = useState<null | {
    phase: 'fetching' | 'analyzing' | 'saving';
    currentGroup: number;
    totalGroups: number;
    currentPage: number;
    totalPages: number;
    messageCount: number;
    groupName?: string;
  }>(null);
  // 时间范围(小时):24 = 一天,72 = 三天,168 = 一周,720 = 一个月,0 = 全部
  const [timeRangeHours, setTimeRangeHours] = useState<number>(24);

  const checkBackend = useCallback(async (): Promise<boolean> => {
    try {
      await sidecarRequest("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await sidecarRequest<WeChatStatus>("GET", "/wechat/status");
      setStatus(s);
      setPhase("ready");
      dismissError();
    } catch (e) {
      setPhase("needBackend");
    }
  }, []);

  // 自动检查后端 + 周期性刷新 status，直到确认 supported 为止
  // 解决 handoff 第 7 节提到的问题：首屏 React 缓存了 stale status,
  // 等用户启了 Python 后端才会刷新。
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      const up = await checkBackend();
      if (cancelled) return;
      if (up) {
        await loadStatus();
      }
    }

    void tick(); // 第一次立刻拉
    // 每 3 秒重试，直到看到 supported=true 才停。手动点刷新图标也算一次。
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [checkBackend, loadStatus]);

  const handleStartBackend = async () => {
    setBusy("backend");
    dismissError();
    try {
      if (import.meta.env.DEV) {
        await devStartSidecar();
      } else {
        const { startSidecar } = await import("../lib/tauri/commands");
        await startSidecar("binaries/miao-backend");
      }
      // 等 uvicon 起来
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await checkBackend()) {
          await loadStatus();
          setNotice("后端已启动");
          setBusy(null);
          return;
        }
      }
      reportErrorString("后端启动超时：等了 10 秒还没就绪，请确认本地数据通道可用或改用官方发布版", false, "error");
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const handleInit = async () => {
    setBusy("init");
    dismissError();
    setNotice(null);
    try {
      await sidecarRequest<{ db_dir: string; keys_count: number }>(
        "POST",
        "/wechat/init",
        {},
      );
      setNotice(`✅ 通道初始化成功`);
      await loadStatus();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const handleLoadSessions = async () => {
    setBusy("sessions");
    dismissError();
    try {
      const list = await sidecarRequest<SessionItem[]>("GET", "/wechat/sessions?limit=100");
      setSessions(list);
      // 默认选中所有未读群
      setSelected(new Set(list.filter((s) => s.is_group && s.unread > 0).map((s) => s.username)));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const visibleSessions = useMemo(
    () => (onlyGroups ? sessions.filter((s) => s.is_group) : sessions),
    [sessions, onlyGroups],
  );

  const toggle = (username: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const formatHours = (h: number): string => {
    if (h === 0) return '全部时间的';
    if (h < 24) return `${h} 小时的`;
    if (h < 168) return `${h / 24} 天的`;
    return `${Math.round(h / 24)} 天的`;
  };

  const handleImport = async () => {
    if (selected.size === 0) return;
    setBusy("import");
    dismissError();
    setNotice(null);

    const targets = sessions.filter((s) => selected.has(s.username));
    // 时间范围 → start_ts + 分页拉取(后端 limit 上限 500)
    const sinceTs = timeRangeHours > 0
      ? Math.floor(Date.now() / 1000) - timeRangeHours * 3600
      : 0;
    // 根据时间范围决定最大页数(24h 内一般 1 页够;30 天可能要 5+ 页)
    const PAGE_SIZE = 500;
    const maxPages = timeRangeHours === 0 ? 10
      : timeRangeHours <= 24 ? 1
      : timeRangeHours <= 72 ? 3
      : timeRangeHours <= 168 ? 6
      : timeRangeHours <= 720 ? 10
      : 12;
    const saved: NotificationItem[] = [];
    let done = 0;
    setProgress({ done: 0, total: targets.length });

    // 群间间隔:避免连续 AI 调用触发 provider 速率限制(429)
    // 选 1s:大多数 provider 限流是按秒算;DeepSeek 等通常 60/min,1s 间隔安全
    const GROUP_INTERVAL_MS = 1000;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      // 第一个群也睡一下,让 UI 有时间进入「拉取中」状态
      if (i > 0) await sleep(GROUP_INTERVAL_MS);
      try {
        // 分页拉取
        const allTexts: HistoryMessage[] = [];
        for (let page = 0; page < maxPages; page++) {
          setProgressStage({
            phase: 'fetching',
            currentGroup: i + 1,
            totalGroups: targets.length,
            currentPage: page + 1,
            totalPages: maxPages,
            messageCount: allTexts.length,
            groupName: target.chat,
          });
          const r = await sidecarRequest<{ count: number; messages: HistoryMessage[] }>(
            "POST",
            "/wechat/history",
            { chat: target.username, limit: PAGE_SIZE, offset: page * PAGE_SIZE, start_ts: sinceTs },
          );
          allTexts.push(...r.messages);
          if (r.messages.length < PAGE_SIZE) break; // 不到一页就停
        }
        const texts = allTexts.filter((m) => m.msg_type === "文本" && m.text.trim());
        if (texts.length === 0) {
          done++;
          setProgress({ done, total: targets.length });
          continue;
        }
        // AI 分析阶段
        setProgressStage({
          phase: 'analyzing',
          currentGroup: i + 1,
          totalGroups: targets.length,
          currentPage: 1,
          totalPages: 1,
          messageCount: texts.length,
          groupName: target.chat,
        });
        // 一个群合成一份"群消息合集"做一次 AI 分析（= 产品愿景里的群日报）
        const digest = texts
          .slice(-200)
          .map((m) => `[${m.time}] ${m.sender}: ${m.text}`)
          .join("\n");
        const result = await analyze(digest, target.chat);
        saved.push({
          id: createNotificationId(),
          source: "wechat",
          groupName: target.chat,
          conversationId: target.username, // ← 用 username 作为稳定 ID,与 monitor 对齐
          isGroup: target.is_group,
          sender: `${texts.length} 条消息`,
          timestamp: texts[texts.length - 1].timestamp * 1000,
          content: digest.slice(0, 4000),
          summary: result.summary,
          importance: result.importance as NotificationImportance,
          category: result.category,
          keyPoints: result.keyPoints,
          keyInfo: result.keyInfo,
        });
      } catch (e) {
        const _c = classifyError(e);
        setError(`「${target.chat}」处理失败：${_c.userMessage}`);
        setErrorMeta({ retryable: _c.retryable, severity: _c.severity });
        break;
      }
      done++;
      setProgress({ done, total: targets.length });
    }

    // 入库阶段
    setProgressStage({
      phase: 'saving',
      currentGroup: targets.length,
      totalGroups: targets.length,
      currentPage: 1,
      totalPages: 1,
      messageCount: saved.length,
    });
    if (saved.length > 0) {
      addNotifications(saved);
      setNotice(`✅ 已生成 ${saved.length} 份群消息日报,存入时间线`);
      toast.success(`已生成 ${saved.length} 份日报${saved.length > 1 ? `,共处理 ${done} 个群` : ''}`, {
        duration: 4000,
        action: { label: '去看时间线 →', onClick: () => navigate('/') },
      });
    } else if (done === targets.length) {
      setNotice(`所选群${timeRangeHours > 0 ? `最近 ${formatHours(timeRangeHours)}` : '全部时间'}都没有新文本消息`);
      toast.info('所选群这段时间没有新文本消息', { duration: 3000 });
    }
    setBusy(null);
    setProgress(null);
    setProgressStage(null);
  };


  return (
    <div className="border border-brand-200 bg-brand-50/40 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-brand-800 hover:bg-brand-100/50 transition"
      >
        <span className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4" />
          微信通道控制台
          {status?.initialized && <span className="text-xs text-green-600">● 已初始化</span>}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 text-sm">
          {/* 步骤 0: 后端 */}
          {phase === "needBackend" && (
            <div className="flex items-center justify-between bg-white rounded-lg border border-gray-200 px-3 py-2.5">
              <span className="text-gray-600">① Python 后端未运行</span>
              <button onClick={handleStartBackend} disabled={busy !== null} className="btn-primary !py-1.5">
                {busy === "backend" ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : <Play className="w-4 h-4 inline mr-1" />}
                启动后端
              </button>
            </div>
          )}

          {phase === "checking" && (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> 正在检查后端状态...
            </div>
          )}

          {/* 步骤 1: 状态 / 初始化 */}
          {phase === "ready" && status && (
            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">
                  ① 后端运行中 · {status.supported ? "平台支持" : "当前平台暂不支持"}
                </span>
                <button onClick={loadStatus} className="text-gray-400 hover:text-gray-600" title="刷新状态">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              {!status.supported && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  💡 PC 微信数据通道目前只支持 <b>Windows + 微信 4.x</b>。
                  请在此平台使用本应用以获得完整功能。
                </div>
              )}

              {status.supported && !status.initialized && (
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">② 通道未初始化</span>
                  <button onClick={handleInit} disabled={busy !== null} className="btn-primary !py-1.5">
                    {busy === "init" ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : <KeyRound className="w-4 h-4 inline mr-1" />}
                    初始化微信通道
                  </button>
                </div>
              )}

              {status.supported && !status.initialized && (
                <p className="text-xs text-gray-400">
                  前提：PC 微信已登录；如报权限错误请用管理员身份运行本应用。数据只存在你自己的电脑上。
                </p>
              )}

              {status.supported && status.initialized && (
                <div className="flex items-center justify-between">
                  <span className="text-green-700 flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" /> ② 已初始化
                  </span>
                  <button onClick={handleLoadSessions} disabled={busy !== null} className="btn-primary !py-1.5">
                    {busy === "sessions" ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}
                    加载会话列表
                  </button>
                </div>
              )}

              {status.db_dir && (
                <p className="text-xs text-gray-400 truncate">数据目录：{status.db_dir}</p>
              )}
            </div>
          )}

          {/* 步骤 3: 会话选择 */}
          {sessions.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">③ 选择要整理成日报的群（{selected.size} 选中）</span>
                <label className="text-xs text-gray-500 flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={onlyGroups}
                    onChange={(e) => setOnlyGroups(e.target.checked)}
                    className="rounded"
                  />
                  只看群聊
                </label>
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                {visibleSessions.map((s) => (
                  <label
                    key={s.username}
                    className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-gray-50 -mx-1 px-1 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(s.username)}
                      onChange={() => toggle(s.username)}
                      className="rounded shrink-0"
                    />
                    <span className="flex-1 truncate font-medium text-gray-800">{s.chat}</span>
                    {s.unread > 0 && (
                      <span className="text-xs bg-red-100 text-red-600 rounded-full px-1.5">{s.unread}</span>
                    )}
                    <span className="text-xs text-gray-400 shrink-0 max-w-[40%] truncate">
                      {s.sender ? `${s.sender}: ` : ""}
                      {s.last_message.slice(0, 30)}
                    </span>
                  </label>
                ))}
              </div>
              {/* 时间范围选择器 */}
              <div className="flex items-center gap-2 text-xs">
                <Clock className="w-3.5 h-3.5 text-gray-400" />
                <span className="text-gray-500">时间范围:</span>
                <div className="flex flex-wrap gap-1">
                  {[
                    { h: 24, label: '24 小时' },
                    { h: 72, label: '3 天' },
                    { h: 168, label: '7 天' },
                    { h: 720, label: '30 天' },
                    { h: 0, label: '全部' },
                  ].map(opt => (
                    <button
                      key={opt.h}
                      onClick={() => setTimeRangeHours(opt.h)}
                      className={clsx(
                        'px-2 py-0.5 rounded text-xs transition-colors',
                        timeRangeHours === opt.h
                          ? 'bg-brand-500 text-white'
                          : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleImport}
                disabled={busy !== null || selected.size === 0}
                className="btn-primary w-full"
              >
                {busy === "import" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin inline mr-1" />
                    正在分析 {progress ? `${progress.done}/${progress.total}` : "..."}
                  </>
                ) : (
                  `拉取最近 ${formatHours(timeRangeHours)}消息并生成日报（${selected.size} 个群）`
                )}
              </button>
              {/* 阶段化进度条 */}
              {progressStage && (
                <div className="bg-blue-50/50 border border-blue-100 rounded-md px-3 py-2 space-y-1.5">
                  {progressStage.phase === 'fetching' && (
                    <>
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-blue-700 flex items-center gap-1">
                          <Loader className="w-3 h-3 animate-spin" />
                          拉取消息
                        </span>
                        <span className="text-blue-600 tabular-nums">
                          群 {progressStage.currentGroup}/{progressStage.totalGroups}
                          {progressStage.totalPages > 1 && ` · 第 ${progressStage.currentPage}/${progressStage.totalPages} 页`}
                          {progressStage.messageCount > 0 && ` · ${progressStage.messageCount} 条`}
                        </span>
                      </div>
                      {progressStage.groupName && (
                        <div className="text-[10px] text-gray-500 truncate">「{progressStage.groupName}」</div>
                      )}
                    </>
                  )}
                  {progressStage.phase === 'analyzing' && (
                    <>
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-amber-700 flex items-center gap-1">
                          <Sparkles className="w-3 h-3 animate-pulse" />
                          AI 分析中
                        </span>
                        <span className="text-amber-600 tabular-nums">
                          群 {progressStage.currentGroup}/{progressStage.totalGroups} · {progressStage.messageCount} 条
                        </span>
                      </div>
                      {progressStage.groupName && (
                        <div className="text-[10px] text-gray-500 truncate">「{progressStage.groupName}」</div>
                      )}
                    </>
                  )}
                  {progressStage.phase === 'saving' && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-green-700 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        存入时间线
                      </span>
                      <span className="text-green-600 tabular-nums">{progressStage.messageCount} 份日报</span>
                    </div>
                  )}
                  <div className="w-full bg-gray-200 rounded-full h-1 overflow-hidden">
                    <div
                      className={clsx(
                        'h-1 rounded-full transition-all duration-300',
                        progressStage.phase === 'analyzing' ? 'bg-amber-500' :
                        progressStage.phase === 'saving' ? 'bg-green-500' : 'bg-blue-500'
                      )}
                      style={{ width: `${Math.round((progressStage.currentGroup / Math.max(1, progressStage.totalGroups)) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 结果 / 错误 */}
          {notice && (
            <div className="text-xs bg-green-50 border border-green-200 text-green-700 rounded-lg px-3 py-2 flex items-start gap-1.5">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {notice}
                {notice.includes("时间线") && (
                  <button onClick={() => navigate("/")} className="ml-2 underline font-medium">
                    去看时间线 →
                  </button>
                )}
              </span>
            </div>
          )}
          {error && (
            <ErrorBanner
              message={error}
              retryable={errorMeta?.retryable ?? false}
              severity={errorMeta?.severity ?? "error"}
              onRetry={errorMeta?.retryable ? loadStatus : undefined}
              onDismiss={dismissError}
            />
          )}
        </div>
      )}
    </div>
  );
}
