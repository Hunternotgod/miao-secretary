/**
 * 时间线主页 - v11 重构（会话大卡 + AI 待办 + 可展开原消息）
 *
 * 设计要点：
 * - 一段微信会话（群/单聊）一张大卡，按最近消息时间倒序，可置顶
 * - 群聊 vs 单聊样式差异（群显成员数 + @ 我徽章）
 * - 展开态 4 大分区：📋 待办 / 💬 话题 / 🔴 @我 / ❓ 等我回
 * - AI 自动判定 isTodo → 自动进入 📋 区（带 🤖 AI 角标），用户可确认/忽略
 * - 用户手动标记：todo / done / ignored（覆盖 AI 建议）
 * - 每条待办可点击 → 展开查看原消息全文 + keyInfo（截止/时间/地点/人）
 * - 状态切换有 fade-out 动画 + 乐观更新（无需手动刷新）
 */

import { useEffect, useMemo, useRef, useState, createContext, useContext } from 'react';
import {
  Filter,
  RefreshCw,
  Inbox,
  Trash2,
  Pin,
  PinOff,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Users,
  User,
  Sparkles,
  Clock,
  MapPin,
  UserCheck,
  Calendar,
  Eye,
  CheckCircle2,
  RotateCcw,
  Archive,
  Loader2,
} from 'lucide-react';
import { toast } from '../components/ui/Toast';
import clsx from 'clsx';
import { useApp } from '../lib/store/AppContext';
import {
  aggregateByConversation,
  type NotificationItem,
  type ConversationView,
} from '../lib/store/notifications';
import {
  db,
  loadAllNotifications,
  deleteNotification,
  updateNotification,
  clearAllNotifications,
  loadPinnedConversations,
  pinConversation,
  unpinConversation,
  subscribeDataChange,
  migrateFromLocalStorage,
} from '../lib/store/db';
import { forcePollOne } from "../lib/monitor/useMonitorLoop";
import { DEFAULT_BACKFILL_HOURS } from "../lib/monitor/schedule";

type FilterTab = 'all' | 'todo' | 'unreplied' | 'done' | 'ignored';


/**
 * 把 monitor loop 聚合的 digest 拆成单条消息
 * digest 格式: [time] sender: text (每行一条)
 * 解析失败返回空数组,UI 会兜底显示原文
 */
function parseDigest(content: string): Array<{ time: string; sender: string; text: string }> {
  if (!content) return [];
  const lines = content.split('\n').filter(Boolean);
  const re = /^\[(.+?)\]\s*(.+?):\s*(.*)$/;
  const out: Array<{ time: string; sender: string; text: string }> = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) out.push({ time: m[1], sender: m[2], text: m[3] });
  }
  return out;
}

/**
 * 「重新分析」按钮的 Context —— 避免 4 层 prop drilling
 * (Timeline → ConversationCard → ConversationExpanded → NotificationRow / TopicBlock → MessageDetail)
 */
type RerunAiContextValue = {
  reanalysingIds: Set<string>;
  trigger: (item: NotificationItem) => void;
};
const RerunAiContext = createContext<RerunAiContextValue>({
  reanalysingIds: new Set(),
  trigger: () => {},
});

export default function Timeline() {
  const { config } = useApp();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 待办/忽略时的 fade-out 状态：标记 id → 渲染时加 opacity-0 + scale-95
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());
  // 首次见到的 id(用来 slide-in 高亮)
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [newIds, setNewIds] = useState<Set<string>>(new Set());


  // 首次启动：从 localStorage 迁移到 IndexedDB
  useEffect(() => {
    migrateFromLocalStorage().then(() => refresh());
  }, []);

  // 订阅数据变更（IndexedDB + 跨 tab）
  useEffect(() => {
    const unsubscribe = subscribeDataChange(() => refresh());
    return unsubscribe;
  }, []);

  async function refresh(opts?: { silent?: boolean }) {
    setLoading(true);
    try {
      const [all, pinned] = await Promise.all([
        loadAllNotifications(),
        loadPinnedConversations(),
      ]);

      // 第一次:把现有 id 全记为 seen
      if (seenIdsRef.current.size === 0) {
        all.forEach((n) => seenIdsRef.current.add(n.id));
      } else {
        // 找出新增的 id(只在非 silent 模式下滑入高亮)
        const fresh = all.filter((n) => !seenIdsRef.current.has(n.id));
        if (fresh.length > 0) {
          fresh.forEach((n) => seenIdsRef.current.add(n.id));
          if (!opts?.silent) {
            setNewIds(new Set(fresh.map((n) => n.id)));
            setTimeout(() => {
              setNewIds((prev) => {
                const cleared = new Set(prev);
                fresh.forEach((n) => cleared.delete(n.id));
                return cleared;
              });
            }, 2000);
            // 顶部 toast 反馈(只在手动刷新时)
            if (!opts?.silent) {
              toast.success(`新消息 ${fresh.length} 条`, { duration: 2000 });
            }
          }
        } else if (!opts?.silent) {
          toast.info('已是最新,没有新消息', { duration: 1500 });
        }
      }
      setItems(all);
      setPinnedIds(new Set(pinned));
    } finally {
      setTimeout(() => setLoading(false), 200);
    }
  }

  // 聚合：所有 NotificationItem → ConversationView[]
  const conversations = useMemo(
    () => aggregateByConversation(items, pinnedIds),
    [items, pinnedIds]
  );

  // 用户反馈：即使 IndexedDB 暂无数据，每个已启用监控也要在 Timeline 保留一张「空会话卡」
  // 用 synthetic NotificationItem 占位，只在「全部」筛选下出现
  const emptyMonitorViews = useMemo<ConversationView[]>(() => {
    if (!config?.monitors) return [];
    const existingIds = new Set(conversations.map((c) => c.conversationId));
    const now = Date.now();
    return config.monitors
      .filter((m) => !existingIds.has(m.chatroomId))
      .map(
        (m): ConversationView => ({
          conversationId: m.chatroomId,
          name: m.name,
          isGroup: false,
          memberCount: undefined,
          latestItem: {
            id: `__placeholder__:${m.chatroomId}`,
            source: "wechat",
            groupName: m.name,
            conversationId: m.chatroomId,
            isGroup: false,
            sender: "",
            timestamp: m.lastPolledAt ?? now,
            content: "",
            summary: "⏳ 监控已配置，等待首次拉取",
            importance: "ignore",
            userStatus: null,
          } as unknown as NotificationItem,
          totalCount: 0,
          todoCount: 0,
          unrepliedCount: 0,
          mentionCount: 0,
          topicCount: 0,
          pinned: pinnedIds.has(m.chatroomId),
        }),
      );
  }, [config?.monitors, conversations, pinnedIds]);

  // 按当前筛选过滤
  const filteredConversations = useMemo(() => {
    // 空监控占位只在「全部」下出现（其他筛选按 todo/未回/已处理 过滤）
    const includesEmpty = filter === "all";
    const base = includesEmpty ? [...conversations, ...emptyMonitorViews] : conversations;
    if (filter === "all") return base;
    return base.filter((c) => {
      const cItems = items.filter((n) => (n.conversationId ?? n.groupName) === c.conversationId);
      if (filter === "todo") return c.todoCount > 0;
      if (filter === "unreplied") return c.unrepliedCount > 0;
      if (filter === "done") return cItems.some((n) => n.userStatus === "done");
      if (filter === "ignored") return cItems.some((n) => n.userStatus === "ignored");
      return true;
    });
  }, [conversations, emptyMonitorViews, items, filter]);

  // 统计的是「单条消息数」,不是会话数。
  // 例:todo=3 表示 3 条待办消息(可能在同一个会话或不同会话)
  const counts = {
    all: conversations.length + emptyMonitorViews.length,
    todo: items.filter(
      (n) =>
        (n.userStatus === 'todo' || (n.userStatus == null && n.aiIsTodo === true)) &&
        !n.mentionedMe
    ).length,
    unreplied: items.filter((n) => n.mentionedMe && n.userStatus !== 'done' && n.userStatus !== 'ignored').length,
    done: items.filter((n) => n.userStatus === 'done').length,
    ignored: items.filter((n) => n.userStatus === 'ignored').length,
  };

  // ============ 操作 ============

  async function handleTogglePin(cid: string) {
    if (pinnedIds.has(cid)) {
      await unpinConversation(cid);
    } else {
      await pinConversation(cid);
    }
  }

  async function handleClearAll() {
    if (items.length === 0) return;
    if (!window.confirm(`确定清空全部 ${items.length} 条通知？此操作不可撤销。`)) return;
    await clearAllNotifications();
  }

  // 用户反馈:Timeline 「重新分析」按钮接入 monitor —— v0-4-B 完成
  const [reanalysingIds, setReanalysingIds] = useState<Set<string>>(new Set());

  async function handleRerunAi(item: NotificationItem): Promise<void> {
    const cid = item.conversationId;
    if (!cid) {
      toast.error("重新分析失败:该通知缺少 conversationId");
      return;
    }
    if (reanalysingIds.has(item.id)) return; // 已经在跑

    const name = item.groupName || cid;
    const monitor = config.monitors.find((m) => m.chatroomId === cid);
    const backfillHours = monitor?.backfillHours ?? DEFAULT_BACKFILL_HOURS;
    const startSec = Math.floor(Date.now() / 1000) - backfillHours * 3600;

    setReanalysingIds((prev) => new Set([...prev, item.id]));
    try {
      // 1) 清空这个 conv 的旧通知(让重分析有干净起点)
      const removed = await db.notifications
        .where("conversationId")
        .equals(cid)
        .delete();
      if (removed > 0) {
        console.log(`[timeline] 重新分析:${name} 已清掉 ${removed} 条旧通知`);
      }
      // 2) 触发 force-poll —— 复用 useMonitorLoop 的 poll 路径,重新拉消息 + 重新分簇 + 重新 AI
      forcePollOne(cid, name, { startSec });
      // 3) 立刻反馈(跨页也能看到 —— item 2 的汇总 toast 也会再 fire 一次)
      toast.info(`🔄 重新分析 ${name} · 拉最近 ${backfillHours} 小时消息`, { duration: 3000 });
      // 4) 6s 后清 loading 标记(粗略:poll 完成时 item 2 那边会再 toast 一次)
      window.setTimeout(() => {
        setReanalysingIds((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }, 6000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`重新分析失败:${msg}`);
      setReanalysingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  function handleSetUserStatus(id: string, status: 'todo' | 'done' | 'ignored' | null) {
    // 捕获原始状态,失败时能正确回滚
    const original = items.find((n) => n.id === id);
    const originalStatus = original?.userStatus ?? null;

    // 1) 乐观更新本地状态（立即生效）
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, userStatus: status } : n))
    );

    // 2) 切到 done/ignored 时启动 fade-out 动画，350ms 后才真正"消失"
    if (status === 'done' || status === 'ignored') {
      setFadingIds((prev) => new Set(prev).add(id));
      setTimeout(() => {
        setFadingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 350);
    }

    // 3) 后台异步写 DB（失败再回滚到原始状态）
    updateNotification(id, { userStatus: status }).catch((err) => {
      console.error('[timeline] updateNotification failed:', err);
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, userStatus: originalStatus } : n))
      );
    });
  }

  async function handleDeleteOne(id: string) {
    await deleteNotification(id);
  }

  return (
    <RerunAiContext.Provider value={{ reanalysingIds, trigger: handleRerunAi }}>
    <div className="h-full flex flex-col">
      {/* ===== 顶栏 ===== */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">📬 微信消息</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {items.length > 0
              ? `共 ${items.length} 条通知 · ${conversations.length} 个会话`
              : '暂时还没有通知'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh()}
            disabled={loading}
            className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1 px-3 py-1.5 rounded hover:bg-gray-100"
          >
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
            刷新
          </button>
          {items.length > 0 && (
            <button
              onClick={handleClearAll}
              className="text-sm text-gray-500 hover:text-red-600 flex items-center gap-1 px-3 py-1.5 rounded hover:bg-gray-100"
            >
              <Trash2 className="w-4 h-4" />
              清空
            </button>
          )}
        </div>
      </header>

      {/* ===== 筛选 chips ===== */}
      <div className="bg-white border-b border-gray-200 px-6 py-2 space-y-1.5">
        <div className="flex items-center gap-2 overflow-x-auto">
          <Filter className="w-4 h-4 text-gray-400 shrink-0" />
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`全部 ${counts.all}`} />
          <FilterChip active={filter === 'todo'} onClick={() => setFilter('todo')} label={`📋 待办 ${counts.todo}`} />
          <FilterChip active={filter === 'unreplied'} onClick={() => setFilter('unreplied')} label={`🔴 @我 ${counts.unreplied}`} />
          <FilterChip active={filter === 'done'} onClick={() => setFilter('done')} label={`✅ 已完成 ${counts.done}`} />
          <FilterChip active={filter === 'ignored'} onClick={() => setFilter('ignored')} label={`🗑 已忽略 ${counts.ignored}`} />
        </div>
        {filter !== 'all' && (
          <div className="text-[11px] text-blue-600 flex items-center gap-1">
            <Filter className="w-3 h-3" />
            正在按 <b className="mx-0.5">{filterLabel(filter)}</b> 筛选 — 仅显示该分类的单条消息,其他分区已隐藏
            <button onClick={() => setFilter('all')} className="ml-1 text-blue-500 hover:text-blue-700 underline">
              清除筛选
            </button>
          </div>
        )}
      </div>

      {/* ===== 会话大卡 ===== */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {filteredConversations.length === 0 ? (
          <EmptyState hasMonitors={!!config?.monitors?.length} />
        ) : (
          filteredConversations.map((c) => (
            <ConversationCard
              key={c.conversationId}
              view={c}
              items={items.filter((n) => (n.conversationId ?? n.groupName) === c.conversationId)}
              expanded={expandedId === c.conversationId}
              fadingIds={fadingIds}
              filter={filter}
              isNew={items.some(n => newIds.has(n.id))}
              onToggleExpand={() =>
                setExpandedId(expandedId === c.conversationId ? null : c.conversationId)
              }
              onTogglePin={() => handleTogglePin(c.conversationId)}
              onSetUserStatus={handleSetUserStatus}
              onDelete={handleDeleteOne}
            />
          ))
        )}
      </div>
    </div>

    </RerunAiContext.Provider>  );
}

// =================================================================
// 子组件：会话大卡
// =================================================================

function ConversationCard(props: {
  view: ConversationView;
  items: NotificationItem[];
  expanded: boolean;
  fadingIds: Set<string>;
  filter: FilterTab;
  isNew?: boolean;
  onToggleExpand: () => void;
  onTogglePin: () => void;
  onSetUserStatus: (id: string, status: 'todo' | 'done' | 'ignored' | null) => void;
  onDelete: (id: string) => void;
}) {
  const { view, items, expanded, fadingIds, filter, isNew, onToggleExpand, onTogglePin, onSetUserStatus, onDelete } = props;
  const { latestItem } = view;

  // 用户反馈：空监控也得保留一张会话卡 → items 长度为 0 视为占位状态
  const isEmptyMonitor = items.length === 0;

  // 最新一行原文摘要（截断 50 字）
  const previewText = latestItem.summary || latestItem.content.slice(0, 50);
  const earliestTs = items.length === 0
    ? latestItem.timestamp
    : items.reduce((m, n) => Math.min(m, n.timestamp), latestItem.timestamp);
  const latestTs = items.length === 0
    ? latestItem.timestamp
    : items.reduce((m, n) => Math.max(m, n.timestamp), latestItem.timestamp);
  const timeRange = formatRangeTime(earliestTs, latestTs);
  const timeRangeFull = earliestTs === latestTs
    ? new Date(latestTs).toLocaleString("zh-CN")
    : `${new Date(earliestTs).toLocaleString("zh-CN")} ~ ${new Date(latestTs).toLocaleString("zh-CN")}`;

  return (
    <div
      className={clsx(
        'bg-white rounded-lg border transition-all',
        view.pinned ? 'border-l-4 border-l-amber-400 border-amber-200' : 'border-gray-200',
        expanded && 'shadow-md',
        isNew && 'animate-slide-in-top ring-2 ring-blue-200 animate-highlight-new'
      )}
    >
      {/* ===== 折叠态 ===== */}
      <div className="px-4 py-3 flex items-start gap-3">
        {/* 头像：群 vs 单聊 */}
        <div className="shrink-0">
          {view.isGroup ? (
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
              <Users className="w-5 h-5 text-blue-600" />
            </div>
          ) : (
            <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
              <User className="w-5 h-5 text-gray-600" />
            </div>
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleExpand}>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {/* 置顶标记 */}
            {view.pinned && <Pin className="w-3 h-3 text-amber-500" />}

            {/* 会话名 */}
            <span className="font-medium text-sm text-gray-900 truncate">{view.name}</span>

            {/* 群特征：成员数 */}
            {view.isGroup && view.memberCount && (
              <span className="text-[10px] text-gray-400">{view.memberCount} 人</span>
            )}

            {/* 时间 */}
            <span
              className="text-xs text-gray-700 font-medium ml-auto shrink-0 tabular-nums"
              title={`${timeRangeFull} · 共 ${items.length} 条`}
            >
              📅 {timeRange}
            </span>
          </div>

          {/* 最新一条预览 */}
          <div
            className={clsx(
              "text-sm truncate mb-1",
              isEmptyMonitor ? "text-amber-700 italic" : "text-gray-700"
            )}
          >
            {!isEmptyMonitor && view.isGroup && (
              <span className="text-gray-500">{latestItem.sender}：</span>
            )}
            {previewText}
          </div>

          {/* 状态栏 */}
          {isEmptyMonitor ? (
            <div className="flex items-center gap-3 text-[11px] flex-wrap">
              <span className="text-amber-700 flex items-center gap-1">
                <span>⚠️</span>暂无通知数据
              </span>
              <span className="text-gray-500">监控已启用 · 等待首次拉取 · 拉到数据后这里会显示摘要与原消息</span>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-[11px] text-gray-500 flex-wrap">
              {view.todoCount > 0 && (
                <span className="text-blue-600">📋 {view.todoCount} 待办</span>
              )}
              {view.topicCount > 1 && (
                <span>💬 {view.topicCount} 话题</span>
              )}
              {view.mentionCount > 0 && (
                <span className="text-red-600 font-medium">🔴 {view.mentionCount} @我</span>
              )}
              {view.unrepliedCount > 0 && (
                <span className="text-orange-600">❓ {view.unrepliedCount} 等我回</span>
              )}
              {items.some((n) => n.userStatus === "done") && (
                <span className="text-green-600">✅ {items.filter((n) => n.userStatus === "done").length} 完成</span>
              )}
              {items.some((n) => n.userStatus === "ignored") && (
                <span className="text-gray-400">🗑 {items.filter((n) => n.userStatus === "ignored").length} 忽略</span>
              )}
              {view.todoCount === 0 && view.topicCount <= 1 && view.unrepliedCount === 0 && view.mentionCount === 0 && (
                <span className="text-gray-400">{view.totalCount} 条消息</span>
              )}
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className={clsx(
              'p-1.5 rounded hover:bg-gray-100',
              view.pinned ? 'text-amber-600' : 'text-gray-300 hover:text-amber-500'
            )}
            title={view.pinned ? '取消置顶' : '置顶'}
          >
            {view.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* ===== 展开态 ===== */}
      {expanded && !isEmptyMonitor && (
        <ConversationExpanded
          view={view}
          items={items}
          fadingIds={fadingIds}
          filter={filter}
          onSetUserStatus={onSetUserStatus}
          onDelete={onDelete}
        />
      )}
      {expanded && isEmptyMonitor && (
        <div className="border-t border-gray-100 px-4 py-5 text-sm bg-amber-50/40">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⏳</span>
            <div>
              <div className="font-medium text-amber-800">监控已配置，暂无通知数据</div>
              <div className="text-xs text-gray-600 mt-1.5 leading-relaxed">
                在「Monitors」页对该群点右侧 ↻ 按钮可立刻拉取，或者等下次轮询时间到。
                <br />
                拉到第一条消息后，这里会展开显示原始聊天记录 + AI 摘要。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =================================================================
// 子组件：展开态（4 大分区）
// =================================================================

function ConversationExpanded(props: {
  view: ConversationView;
  items: NotificationItem[];
  fadingIds: Set<string>;
  filter: FilterTab;  // 控制只显示某一类(单条粒度的关键)
  onSetUserStatus: (id: string, status: 'todo' | 'done' | 'ignored' | null) => void;
  onDelete: (id: string) => void;
}) {
  const { view, items, fadingIds, filter, onSetUserStatus } = props;
  // 哪个消息被展开看详情(同一时刻只展开一个)
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 已完成 / 已忽略 子区是否展开(filter 强制展开时覆盖)
  const [showDoneLocal, setShowDoneLocal] = useState(false);
  const [showIgnoredLocal, setShowIgnoredLocal] = useState(false);
  const showDone = filter === 'done' ? true : showDoneLocal;
  const showIgnored = filter === 'ignored' ? true : showIgnoredLocal;
  const toggle = (id: string) => setExpandedId(expandedId === id ? null : id);

  // 过滤控制:每个分区是否显示(单条粒度的核心)
  const showTodo = filter === 'all' || filter === 'todo';
  const showTopic = filter === 'all';
  const showMention = filter === 'all' || filter === 'unreplied';
  const showDoneSection = filter === 'all' || filter === 'done';
  const showIgnoredSection = filter === 'all' || filter === 'ignored';

  // 分桶:每个 item 归到一个类别(每条消息只属于一个,保证"单条粒度")
  const activeItems = items.filter(
    (n) =>
      (n.userStatus === 'todo' || (n.userStatus == null && n.aiIsTodo === true))
      && !n.mentionedMe
  );
  const mentionItems = items.filter(
    (n) => n.mentionedMe && n.userStatus !== 'done' && n.userStatus !== 'ignored'
  );
  const doneItems = items.filter((n) => n.userStatus === 'done');
  const ignoredItems = items.filter((n) => n.userStatus === 'ignored');

  // 话题分组(只看 active 的 mention 之外、非 todo/done/ignored)
  const topicMap = new Map<string, NotificationItem[]>();
  for (const n of items) {
    if (n.userStatus) continue;  // 已分类的(todo/done/ignored)不进话题
    if (n.aiIsTodo === true) continue;
    if (n.mentionedMe) continue;
    const key = n.eventKey ?? `single-${n.id}`;
    const list = topicMap.get(key) ?? [];
    list.push(n);
    topicMap.set(key, list);
  }
  const topics = Array.from(topicMap.entries()).map(([key, list]) => ({
    key,
    items: list.sort((a, b) => a.timestamp - b.timestamp),
    latest: list[list.length - 1],
  }));

  return (
    <div className="border-t border-gray-100 px-4 py-3 space-y-3 bg-gray-50/50">
      {/* 📋 待办区(手动 + AI 建议,排除 @ 我避免重复) */}
      {showTodo && activeItems.length > 0 && (
        <Section title={`📋 待办 (${activeItems.length})`} accent="blue">
          {activeItems.map((n) => (
            <TodoRow
              key={n.id}
              item={n}
              isGroup={view.isGroup}
              isAiSuggested={n.userStatus == null && n.aiIsTodo === true}
              isFading={fadingIds.has(n.id)}
              isExpanded={expandedId === n.id}
              onToggleExpand={() => toggle(n.id)}
              onConfirmTodo={() => onSetUserStatus(n.id, 'todo')}
              onComplete={() => onSetUserStatus(n.id, 'done')}
              onIgnore={() => onSetUserStatus(n.id, 'ignored')}
            />
          ))}
        </Section>
      )}

      {/* 💬 话题区 */}
      {showTopic && topics.length > 0 && (
        <Section title={`💬 话题 (${topics.length})`} accent="gray">
          {topics.map((t) => (
            <TopicBlock
              key={t.key}
              topicKey={t.key}
              items={t.items}
              isGroup={view.isGroup}
              fadingIds={fadingIds}
              expandedId={expandedId}
              onToggleExpand={toggle}
              onSetUserStatus={onSetUserStatus}
            />
          ))}
        </Section>
      )}

      {/* 🔴 @ 我(独立展示,不在话题区里混) */}
      {showMention && view.isGroup && mentionItems.length > 0 && (
        <Section title={`🔴 @我 (${mentionItems.length})`} accent="red">
          {mentionItems.map((n) => (
            <MessageRow
              key={n.id}
              item={n}
              isGroup={true}
              isFading={fadingIds.has(n.id)}
              isExpanded={expandedId === n.id}
              onToggleExpand={() => toggle(n.id)}
              actions={
                <>
                  <SmallBtn onClick={() => onSetUserStatus(n.id, 'todo')} icon={<Check className="w-3 h-3" />} title="加入待办" />
                  <SmallBtn onClick={() => onSetUserStatus(n.id, 'done')} icon={<CheckCircle2 className="w-3 h-3" />} title="完成" />
                  <SmallBtn onClick={() => onSetUserStatus(n.id, 'ignored')} icon={<X className="w-3 h-3" />} title="忽略" />
                </>
              }
            />
          ))}
        </Section>
      )}

      {/* ✅ 已完成(折叠,默认收起;filter 选中时强制展开) */}
      {showDoneSection && doneItems.length > 0 && (
        <CollapsibleSection
          title={`✅ 已完成`}
          count={doneItems.length}
          accent="green"
          open={showDone}
          onToggle={() => setShowDoneLocal(!showDoneLocal)}
        >
          {doneItems.map((n) => (
            <MessageRow
              key={n.id}
              item={n}
              isGroup={view.isGroup}
              isFading={fadingIds.has(n.id)}
              isExpanded={expandedId === n.id}
              onToggleExpand={() => toggle(n.id)}
              stateBadge={<DoneBadge />}
              actions={
                <SmallBtn onClick={() => onSetUserStatus(n.id, null)} icon={<RotateCcw className="w-3 h-3" />} title="撤销完成" />
              }
            />
          ))}
        </CollapsibleSection>
      )}

      {/* 🗑 已忽略(折叠,默认收起;filter 选中时强制展开) */}
      {showIgnoredSection && ignoredItems.length > 0 && (
        <CollapsibleSection
          title={`🗑 已忽略`}
          count={ignoredItems.length}
          accent="gray"
          open={showIgnored}
          onToggle={() => setShowIgnoredLocal(!showIgnoredLocal)}
        >
          {ignoredItems.map((n) => (
            <MessageRow
              key={n.id}
              item={n}
              isGroup={view.isGroup}
              isFading={fadingIds.has(n.id)}
              isExpanded={expandedId === n.id}
              onToggleExpand={() => toggle(n.id)}
              stateBadge={<IgnoredBadge />}
              actions={
                <SmallBtn onClick={() => onSetUserStatus(n.id, null)} icon={<RotateCcw className="w-3 h-3" />} title="撤销忽略" />
              }
            />
          ))}
        </CollapsibleSection>
      )}

      {/* ❓ 等我回 */}
      {activeItems.length === 0 && topics.length === 0 && mentionItems.length === 0 && doneItems.length === 0 && ignoredItems.length === 0 && (
        <div className="text-center text-xs text-gray-400 py-4">该会话暂无待办 / 话题 / @ 我</div>
      )}
    </div>
  );
}

// =================================================================
// 子组件：分区容器
// =================================================================

function Section(props: { title: string; accent: 'blue' | 'red' | 'gray'; children: React.ReactNode }) {
  const { title, accent, children } = props;
  const accentColors = {
    blue: 'text-blue-700',
    red: 'text-red-700',
    gray: 'text-gray-700',
  };
  return (
    <div>
      <div className={clsx('text-xs font-medium mb-2', accentColors[accent])}>{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

// =================================================================
// 子组件：单条消息行
// =================================================================

function MessageRow(props: {
  item: NotificationItem;
  isGroup: boolean;
  isExpanded?: boolean;
  isFading?: boolean;
  onToggleExpand?: () => void;
  stateBadge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const { item, isGroup, isExpanded, isFading, onToggleExpand, stateBadge, actions } = props;
  const time = formatTimeShort(item.timestamp);
  const expandable = !!onToggleExpand;

  return (
    <div
      className={clsx(
        'bg-white rounded border border-gray-100 transition-all duration-300 ease-out',
        isFading && 'opacity-0 -translate-y-1 scale-[0.98] pointer-events-none'
      )}
    >
      <div className="px-3 py-2 flex items-start gap-2">
        {/* 时间 */}
        <span
          className="shrink-0 w-14 pt-0.5 pr-1.5 border-r border-gray-200 text-[11px] font-semibold tabular-nums text-gray-700"
          title={`消息时间：${new Date(item.timestamp).toLocaleString("zh-CN")}`}
        >
          {time}
        </span>

        {/* 发言人(群) */}
        {isGroup && (
          <span className="text-xs text-gray-500 shrink-0 w-24 truncate pt-0.5">{item.sender}</span>
        )}

        {/* 内容区域 —— 可点击展开（不包括操作按钮） */}
        <button
          type="button"
          onClick={onToggleExpand}
          className={clsx(
            "flex-1 min-w-0 text-left flex flex-col justify-start hover:bg-gray-50 rounded transition-colors",
            !expandable && "cursor-default"
          )}
          disabled={!expandable}
          title={isExpanded ? '收起原消息' : '点击看原消息'}
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            {stateBadge}
            <div className="text-sm text-gray-800 line-clamp-2">{item.summary || item.content}</div>
          </div>
          {item.summary && item.summary !== item.content && (
            <div className="text-xs text-gray-500 mt-0.5">📝 {item.summary}</div>
          )}
        </button>

        {/* 展开箭头(保留，视觉提示) */}
        {expandable && (
          <span className={clsx(
            "text-gray-300 hover:text-blue-500 p-0.5 shrink-0 self-center transition-transform",
            isExpanded && "rotate-90"
          )}>
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </span>
        )}

        {/* 操作 */}
        {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
      </div>

      {/* 展开时显示 MessageDetail */}
      {expandable && isExpanded && <MessageDetail item={item} isGroup={isGroup} />}
    </div>
  );
}

// =================================================================
// 子组件：待办行(v11 新增：AI 角标 + 点击展开原消息 + fade-out 动画)
// =================================================================

function TodoRow(props: {
  item: NotificationItem;
  isGroup: boolean;
  isAiSuggested: boolean;
  isFading: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onConfirmTodo: () => void;
  onComplete: () => void;
  onIgnore: () => void;
}) {
  const {
    item,
    isGroup,
    isAiSuggested,
    isFading,
    isExpanded,
    onToggleExpand,
    onConfirmTodo,
    onComplete,
    onIgnore,
  } = props;
  const time = formatTimeShort(item.timestamp);

  return (
    <div
      className={clsx(
        'rounded border transition-all duration-300 ease-out overflow-hidden',
        isAiSuggested
          ? 'border-blue-200 bg-blue-50/30 hover:border-blue-300'
          : 'border-gray-100 bg-white hover:border-gray-200',
        isFading && 'opacity-0 -translate-y-1 scale-[0.98] pointer-events-none'
      )}
    >
      {/* 主行：左侧整块可点击展开 */}
      <div className="flex items-stretch">
        {/* 左侧可点区域：时间 + 发送者 + 内容 + 箭头 */}
        <button
          onClick={onToggleExpand}
          className="flex-1 min-w-0 text-left flex items-start gap-2 px-3 py-2 group hover:bg-blue-50/30 transition-colors"
          title={isExpanded ? '收起原消息' : '点击查看原消息'}
        >
          {/* 时间 */}
          <span
          className="shrink-0 w-14 pt-0.5 pr-1.5 border-r border-gray-200 text-[11px] font-semibold tabular-nums text-gray-700"
          title={`消息时间：${new Date(item.timestamp).toLocaleString("zh-CN")}`}
        >
          {time}
        </span>

          {/* 发言人（群） */}
          {isGroup && (
            <span className="text-xs text-gray-500 shrink-0 w-16 truncate pt-0.5">{item.sender}</span>
          )}

          {/* 内容 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {isAiSuggested && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 shrink-0">
                  <Sparkles className="w-2.5 h-2.5" />
                  AI 建议
                </span>
              )}
              <div className="text-sm text-gray-800 line-clamp-2 group-hover:text-blue-700 transition-colors">
                {item.summary || item.content.slice(0, 100)}
              </div>
            </div>
            {!isExpanded && (
              <div className="text-[10px] text-blue-500 mt-0.5 flex items-center gap-0.5 opacity-70 group-hover:opacity-100">
                <Eye className="w-3 h-3" />
                点击看原消息
              </div>
            )}
          </div>

          {/* 展开箭头 */}
          <span
            className={clsx(
              'shrink-0 text-gray-300 group-hover:text-blue-500 transition-all self-center',
              isExpanded && 'rotate-90 text-blue-500'
            )}
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </span>
        </button>

        {/* 右侧操作按钮(不参与展开) */}
        <div className="flex items-center gap-0.5 px-2 py-2 border-l border-gray-100 bg-gray-50/50">
          {isAiSuggested && (
            <SmallBtn
              onClick={onConfirmTodo}
              icon={<Check className="w-3.5 h-3.5" />}
              title="确认加入待办"
            />
          )}
          <SmallBtn onClick={onComplete} icon={<Check className="w-3.5 h-3.5" />} title="标完成" />
          <SmallBtn onClick={onIgnore} icon={<X className="w-3.5 h-3.5" />} title="忽略" />
        </div>
      </div>

      {/* 展开态：原消息 + AI 提取信息 */}
      {isExpanded && <MessageDetail item={item} isGroup={isGroup} />}
    </div>
  );
}

// =================================================================
// 子组件：待办详情面板(v11 新增：显示完整原消息 + AI 抽取的关键信息)
// =================================================================

function MessageDetail(props: { item: NotificationItem; isGroup: boolean }) {
  const { item, isGroup } = props;
  // v0-4-B:接入「重新分析」按钮(用 Context 避免 4 层 prop drilling)
  const { reanalysingIds, trigger: onRerunAi } = useContext(RerunAiContext);
  const isReanalysing = reanalysingIds.has(item.id);
  const ki = item.keyInfo;
  // 把 digest 拆成单条消息(时间/发送者/原文)
  const messages = parseDigest(item.content);
  const hasStructuredMsgs = messages.length > 1;

  return (
    <div className="mt-3 -mx-1 px-1 space-y-3 animate-fade-in">
      {/* 原始聊天记录(按条展示) */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1.5 flex items-center gap-1">
          💬 原始聊天记录
          {hasStructuredMsgs && (
            <span className="text-gray-300">· 共 {messages.length} 条</span>
          )}
        </div>
        {hasStructuredMsgs ? (
          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {messages.map((m, i) => {
              // 推断消息方向:时间最近/含具体时间点的优先高亮
              const isLast = i === messages.length - 1;
              return (
                <div
                  key={i}
                  className={clsx(
                    'rounded px-2 py-1.5 text-xs flex gap-2 items-start',
                    isLast
                      ? 'bg-blue-50 border border-blue-200'
                      : 'bg-gray-50 border border-gray-100'
                  )}
                >
                  <span className="font-mono text-[10px] text-gray-400 shrink-0 w-[88px] tabular-nums">
                    {m.time}
                  </span>
                  {/* 发送人(单聊也显示,避免「看不出谁说的」;w-24 给中文名够空间) */}
                  <span
                    className={clsx(
                      'shrink-0 w-24 truncate text-[11px]',
                      m.sender === '我' ? 'text-amber-700 font-medium' : isLast ? 'text-blue-700 font-medium' : 'text-gray-500'
                    )}
                    title={m.sender}
                  >
                    {m.sender === '我' ? '🧑 我' : m.sender}
                  </span>
                  <span className={clsx(
                    'flex-1 break-words leading-relaxed',
                    isLast ? 'text-gray-900' : 'text-gray-700'
                  )}>
                    {m.text}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          // 兜底:解析不出多条,直接显示原文(单消息或老格式)
          <div className="text-sm text-gray-700 whitespace-pre-wrap break-words leading-relaxed bg-gray-50 rounded px-3 py-2">
            {item.content}
          </div>
        )}
      </div>

      {/* AI 抽取的关键信息(放在消息列表下面,做摘要) */}
      {(item.summary || (ki && Object.values(ki).some(Boolean)) || (item.keyPoints && item.keyPoints.length > 0)) && (
        <div className="rounded bg-gradient-to-br from-blue-50/50 to-indigo-50/50 border border-blue-100 px-3 py-2 space-y-2">
          {item.summary && (
            <div className="flex gap-1.5 text-xs">
              <span className="text-blue-500 shrink-0">📝</span>
              <span className="text-gray-800 leading-relaxed">{item.summary}</span>
            </div>
          )}
          {ki && Object.values(ki).some(Boolean) && (
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {ki.deadline && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-700 rounded">
                  <Clock className="w-3 h-3" />截止 {ki.deadline}
                </span>
              )}
              {ki.time && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded">
                  <Calendar className="w-3 h-3" />{ki.time}
                </span>
              )}
              {ki.location && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 rounded">
                  <MapPin className="w-3 h-3" />{ki.location}
                </span>
              )}
              {ki.responsiblePerson && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-700 rounded">
                  <UserCheck className="w-3 h-3" />{ki.responsiblePerson}
                </span>
              )}
            </div>
          )}
          {item.keyPoints && item.keyPoints.length > 0 && (
            <ul className="text-[11px] text-gray-700 space-y-0.5 list-disc list-inside marker:text-gray-400">
              {item.keyPoints.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* 话题概要(普通话题的整体语境,非待办聚合) */}
      {(item.topicSummary || item.sentiment || (item.participants && item.participants.length > 0)) ? (
        <div className="rounded bg-gradient-to-br from-emerald-50/40 to-teal-50/40 border border-emerald-100 px-3 py-2 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700/70">💬 话题概要</div>
          {item.topicSummary && (
            <div className="flex gap-1.5 text-xs">
              <span className="text-emerald-500 shrink-0">📝</span>
              <span className="text-gray-800 leading-relaxed">{item.topicSummary}</span>
            </div>
          )}
          {(item.sentiment || (item.participants && item.participants.length > 0)) && (
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {item.sentiment && (
                <span
                  className={clsx(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded border',
                    item.sentiment === 'consensus' && 'bg-green-50 text-green-700 border-green-100',
                    item.sentiment === 'debate' && 'bg-blue-50 text-blue-700 border-blue-100',
                    item.sentiment === 'conflict' && 'bg-red-50 text-red-700 border-red-100',
                    item.sentiment === 'casual' && 'bg-gray-100 text-gray-600 border-gray-200'
                  )}
                >
                  {item.sentiment === 'consensus' ? '🤝 达成共识'
                    : item.sentiment === 'debate' ? '💭 讨论中'
                    : item.sentiment === 'conflict' ? '⚠️ 有分歧'
                    : '💬 闲聊'}
                </span>
              )}
              {item.participants && item.participants.length > 0 && item.participants.map((p, i) => (
                <span
                  key={i}
                  className="inline-flex items-center px-2 py-0.5 bg-white border border-gray-200 text-gray-700 rounded"
                >
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded bg-gray-50/50 border border-dashed border-gray-200 px-3 py-2 flex items-center justify-between">
          <span className="text-[11px] text-gray-400">话题概要未生成(老数据 · 等下次重新分析)</span>
          <button
            type="button"
            onClick={() => onRerunAi(item)}
            disabled={isReanalysing || !item.conversationId}
            className={clsx(
              "text-[11px] shrink-0 inline-flex items-center gap-1 hover:underline",
              isReanalysing
                ? "text-amber-600 cursor-wait"
                : "text-blue-500 hover:text-blue-700"
            )}
            title={item.conversationId
              ? isReanalysing
                ? "正在重新拉取 + 重跑 AI,稍候…"
                : "重新拉取消息并重跑 AI(复用 monitor 的 force-poll 路径)"
              : "该通知缺少 conversationId,无法重跑"}
          >
            {isReanalysing ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                分析中…
              </>
            ) : (
              <>重新分析 →</>
            )}
          </button>
        </div>
      )}

      {/* 元信息 */}
      <div className="text-[10px] text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5">
        {item.category && <span>分类：{item.category}</span>}
        {isGroup && item.sender && <span>聚合：{item.sender}</span>}
        <span>消息时间：{new Date(item.timestamp).toLocaleString('zh-CN')}</span>
        <span className="font-mono">ID：{item.id.slice(0, 8)}</span>
      </div>
    </div>
  );
}

// =================================================================
// 子组件：话题块（折叠/展开 AI eventKey 聚合）
// =================================================================

function TopicBlock(props: {
  topicKey: string;
  items: NotificationItem[];
  isGroup: boolean;
  fadingIds: Set<string>;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetUserStatus: (id: string, status: 'todo' | 'done' | 'ignored' | null) => void;
}) {
  const { items, isGroup, fadingIds, expandedId, onToggleExpand, onSetUserStatus } = props;
  const [threadOpen, setThreadOpen] = useState(false);
  const isThread = items.length > 1;
  const latest = items[items.length - 1];
  const topicTitle = latest.summary || latest.content.slice(0, 30);

  return (
    <div className="bg-white rounded border border-gray-100">
      {/* 话题头 —— 内容区域整块可点，右侧操作按钮独立，避免嵌套 button */}
      <div className="px-3 py-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setThreadOpen(!threadOpen)}
          className={clsx(
            "flex-1 min-w-0 flex items-center gap-2 text-left rounded transition-colors",
            isThread ? "cursor-pointer hover:bg-gray-50" : "cursor-default"
          )}
          disabled={!isThread}
        >
          {isThread ? (
            <span className={clsx(
              "text-gray-400 transition-transform shrink-0",
              threadOpen ? "rotate-180" : ""
            )}>
              {threadOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </span>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-800 truncate">
              {isGroup && <span className="text-gray-500">{latest.sender}：</span>}
              {topicTitle}
            </div>
            {isThread && (
              <div className="text-[10px] text-gray-400 mt-0.5">{items.length} 条变迁</div>
            )}
          </div>
        </button>
        <SmallBtn
          onClick={() => onSetUserStatus(latest.id, 'todo')}
          icon={<Check className="w-3 h-3" />}
          title="标待办"
        />
        <SmallBtn
          onClick={() => onSetUserStatus(latest.id, 'ignored')}
          icon={<X className="w-3 h-3" />}
          title="忽略话题"
        />
      </div>

      {/* 单条:不展开 thread 时,直接给 latest 一个可展开的入口 */}
      {!isThread && (
        <div className="border-t border-gray-100 px-2 py-1">
          <button
            onClick={() => onToggleExpand(latest.id)}
            className="w-full flex items-center justify-center gap-1 text-[10px] text-blue-500 hover:text-blue-700 py-1 hover:bg-blue-50/50 rounded"
            title="查看完整原消息"
          >
            <Eye className="w-3 h-3" />
            {expandedId === latest.id ? '收起原消息' : '点击看原消息'}
          </button>
          {expandedId === latest.id && <MessageDetail item={latest} isGroup={isGroup} />}
        </div>
      )}

      {/* 展开:显示全部变迁,每条都可点展开看原消息 */}
      {isThread && threadOpen && (
        <div className="border-t border-gray-100 px-3 py-2 space-y-1.5 bg-gray-50/50">
          {items.map((n) => {
            const statusIcon =
              n.eventStatus === 'revoked' ? '❌' :
              n.eventStatus === 'changed' ? '⚠️' : '✅';
            const isOpen = expandedId === n.id;
            return (
              <div
                key={n.id}
                className={clsx(
                  'rounded border transition-all duration-300',
                  fadingIds.has(n.id) && 'opacity-0 -translate-y-1 pointer-events-none',
                  isOpen ? 'bg-white border-blue-200' : 'bg-white/70 border-gray-100'
                )}
              >
                <button
                  onClick={() => onToggleExpand(n.id)}
                  className="w-full flex gap-2 text-xs py-1.5 px-1.5 items-center hover:bg-blue-50/40 rounded text-left"
                >
                  <span className="text-gray-400 font-mono shrink-0">{formatTimeShort(n.timestamp)}</span>
                  <span className="shrink-0">{statusIcon}</span>
                  <span className="flex-1 text-gray-700 truncate">
                    {isGroup && <span className="text-gray-500">{n.sender}：</span>}
                    {n.summary || n.content.slice(0, 50)}
                  </span>
                  {isOpen ? <ChevronDown className="w-3 h-3 text-blue-500" /> : <ChevronRight className="w-3 h-3 text-gray-300" />}
                </button>
                {isOpen && <MessageDetail item={n} isGroup={isGroup} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =================================================================
// 子组件：可折叠分区(已完成/已忽略专用,默认收起)
// =================================================================

function CollapsibleSection(props: {
  title: string;
  count: number;
  accent: 'green' | 'gray';
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { title, count, accent, open, onToggle, children } = props;
  const accentColors = {
    green: 'text-green-700 hover:bg-green-50/50',
    gray: 'text-gray-500 hover:bg-gray-100',
  };
  const iconColors = {
    green: 'text-green-600',
    gray: 'text-gray-400',
  };
  return (
    <div>
      <button
        onClick={onToggle}
        className={clsx(
          'w-full flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded transition-colors',
          accentColors[accent]
        )}
      >
        {open ? <ChevronDown className={clsx('w-3.5 h-3.5', iconColors[accent])} /> : <ChevronRight className={clsx('w-3.5 h-3.5', iconColors[accent])} />}
        <span>{title} ({count})</span>
      </button>
      {open && <div className="mt-2 space-y-1.5 animate-fade-in">{children}</div>}
    </div>
  );
}

// =================================================================
// 子组件：状态徽章
// =================================================================

function DoneBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 shrink-0">
      <CheckCircle2 className="w-2.5 h-2.5" />
      已完成
    </span>
  );
}

function IgnoredBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 shrink-0">
      <Archive className="w-2.5 h-2.5" />
      已忽略
    </span>
  );
}

// =================================================================
// 子组件：筛选 chip
// =================================================================

function FilterChip(props: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={props.onClick}
      className={clsx(
        'px-3 py-1 rounded-full text-xs whitespace-nowrap transition-colors',
        props.active
          ? 'bg-blue-500 text-white'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      )}
    >
      {props.label}
    </button>
  );
}

// =================================================================
// 子组件：小按钮
// =================================================================

function SmallBtn(props: { onClick: () => void; icon: React.ReactNode; title: string }) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      className="p-1 text-gray-300 hover:text-blue-600 rounded hover:bg-blue-50"
    >
      {props.icon}
    </button>
  );
}

// =================================================================
// 子组件：空状态
// =================================================================

function EmptyState({ hasMonitors }: { hasMonitors: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-16">
      <div className="text-6xl mb-4">📭</div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">还没有通知</h3>
      <p className="text-sm text-gray-500 mb-6 max-w-md">
        {hasMonitors
          ? '已经添加了监控群，但还没有新消息。点击「刷新」试试，或去添加数据源。'
          : '先去「监控列表」添加要监控的群，或者「数据源」手动导入微信消息。'}
      </p>
      <div className="flex gap-3">
        {!hasMonitors && (
          <a href="/monitors" className="btn-primary">
            添加监控群
          </a>
        )}
        <a href="/data" className="btn-secondary">
          <Inbox className="w-4 h-4 mr-1 inline" />
          导入数据
        </a>
      </div>
    </div>
  );
}

function filterLabel(f: FilterTab): string {
  switch (f) {
    case 'todo': return '待办';
    case 'unreplied': return '@我';
    case 'done': return '已完成';
    case 'ignored': return '已忽略';
    case 'all': default: return '全部';
  }
}

// =================================================================
// 时间格式化
// =================================================================

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return `${d.getMonth() + 1}-${d.getDate()}`;
  }
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function formatRangeTime(earliest: number, latest: number): string {
  if (earliest === latest) return formatTime(latest);
  const ed = new Date(earliest);
  const ld = new Date(latest);
  if (ed.toDateString() === ld.toDateString()) {
    // 同日:左侧 HH:MM ~ 右侧 HH:MM
    const hhmm = (ts: number) =>
      new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `${hhmm(earliest)} ~ ${hhmm(latest)}`;
  }
  return `${formatTime(earliest)} ~ ${formatTime(latest)}`;
}

function formatTimeShort(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
