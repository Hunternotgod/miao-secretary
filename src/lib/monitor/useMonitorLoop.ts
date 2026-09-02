/**
 * 后台监控轮询 hook(v12:方案 A + B-4)
 *
 * 改动:
 * - 拉到的消息按时间间隔分簇(默认 30 分钟静默 = 新簇)
 * - 每簇先查 AI 缓存(命中免调用),miss 的并行 AI
 * - 每簇入一条通知(不再是大聚合 digest 一条)
 *
 * 单群失败不影响其他群(try/catch 隔离)
 * 后端没起来 / AI 没配置 → 静默跳过,不报错
 */
import { useEffect, useRef } from "react";
import { useApp } from "../store/AppContext";
import { createAIEngine } from "../ai/factory";
import { sidecarRequest } from "../tauri/commands";
import {
  getAICacheBatch,
  putAICache,
  upsertByEventKey,
} from "../store/db";
import { createNotificationId, loadNotifications } from "../store/notifications";
import type { NotificationItem, NotificationImportance } from "../store/notifications";
import { shouldPollNow, DEFAULT_INTERVAL_SEC, DEFAULT_BACKFILL_HOURS, MAX_BACKFILL_HOURS } from "./schedule";
import type { ExistingEventHint, SummaryResult } from "../ai/types";
import type { WeChatHistoryMsg, WeChatHistoryResp } from "./types";
import { clusterMessages, hashCluster, clusterToDigest, splitLargeClusters, type Cluster } from "../cluster/cluster";
import { toast } from "../../components/ui/Toast";

/** 单群一次轮询的汇总(用于后台 tick 后给用户 toast 汇总) */
type PollSummary = {
  displayName: string;
  rawMessages: number;   // 后端拉到的消息数
  clusters: number;      // 分出的簇数
  cacheHits: number;     // 命中缓存的簇数
  failed: boolean;       // 本次轮询是否抛错
};

/** 从 now 到下一个 dailyTimes 时间点的毫秒数(若今天都过了,算明天最早) */
function nextDailyDelayMs(dailyTimes: string[] | undefined, now: number): number {
  const times = dailyTimes && dailyTimes.length > 0 ? dailyTimes : ["09:00"];
  if (times.length === 0) return Infinity;
  let earliestToday = Infinity;
  for (const t of times) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) continue;
    const d = new Date(now);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    const ts = d.getTime();
    if (ts > now && ts - now < earliestToday) earliestToday = ts - now;
  }
  if (earliestToday !== Infinity) return earliestToday;
  // 今天都过了,算明天最早
  let earliestTomorrow = Infinity;
  for (const t of times) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) continue;
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    const ts = d.getTime();
    if (ts - now < earliestTomorrow) earliestTomorrow = ts - now;
  }
  return earliestTomorrow;
}
import { toErrorMessage } from "../errors";

interface PollingStatus {
  /** 是否在轮询中 */
  active: boolean;
  /** 上次跑的时间 */
  lastTick?: number;
  /** 正在跑的群(username 列表) */
  inFlight: Set<string>;
  /** 正在回补历史的群(username 列表,UI 显示「正在补 X 天的消息」) */
  backfilling: Set<string>;
  /** 正在分簇的群 */
  clustering: Set<string>;
  /** 正在 AI 分析的群(其中多少个簇已完成) */
  aiAnalyzing: Set<string>;
  /** 上次错误的群 + 错误(用于 UI 显示) */
  lastErrors: Record<string, string>;
}

/** 全局单例 - 避免多组件挂载时启动多个循环 */
let globalInstance: PollingStatus | null = null;
const subscribers = new Set<(s: PollingStatus) => void>();

function getStatus(): PollingStatus {
  if (!globalInstance) {
    globalInstance = {
      active: false,
      inFlight: new Set(),
      backfilling: new Set(),
      clustering: new Set(),
      aiAnalyzing: new Set(),
      lastErrors: {},
    };
  }
  return globalInstance;
}

function notifySubs() {
  const s = getStatus();
  subscribers.forEach((cb) => cb(s));
}

/**
 * 手动立即触发某个群的轮询(用于 UI「立即拉一次」按钮)
 * 通过 CustomEvent 让 useMonitorLoop 内部的 listener 处理
 */
/**
 * 手动立即触发某个群的轮询(用于 UI「立即拉一次」按钮)
 * 通过 CustomEvent 让 useMonitorLoop 内部的 listener 处理
 *
 * @param options.startSec 覆盖 start_sec(秒)。未传 = 用 lastPolledAt(增量)。
 *                        传了 = 从指定时间起拉(用户主动选「最近 X」)。
 */
export function forcePollOne(
  chatroomId: string,
  name: string,
  options?: { startSec?: number }
): void {
  window.dispatchEvent(new CustomEvent('miao:force-poll', {
    detail: { chatroomId, name, startSec: options?.startSec },
  }));
}

export function usePollingStatus(): PollingStatus {
  // 简单实现:每次重新创建引用;实际项目可以用 useSyncExternalStore
  const ref = useRef(getStatus());
  useEffect(() => {
    const cb = (s: PollingStatus) => {
      ref.current = s;
    };
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  return ref.current;
}

export function useMonitorLoop() {
  const { config, update } = useApp();
  const intervalRef = useRef<number | null>(null);
  const nextTickRef = useRef<number | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const status = getStatus();
    status.active = true;
    notifySubs();

    const tick = async () => {
      const cfg = configRef.current;
      if (!cfg.ai) return; // 没配 AI,跳过
      if (cfg.monitors.length === 0) return;

      const now = Date.now();
      // 每个群判断是否该跑
      const duePromises: Promise<PollSummary>[] = [];

      for (const m of cfg.monitors) {
        if (!m.enabled) continue;
        const schedule = m.schedule ?? "interval";
        if (
          !shouldPollNow(schedule, m.lastPolledAt, m.intervalSeconds, m.dailyTimes, now)
        )
          continue;

        duePromises.push(pollOne(m.chatroomId, m.name, m.lastPolledAt));
      }

      if (duePromises.length > 0) {
        const settled = await Promise.allSettled(duePromises);
        // 汇总 toast:用户在非 Monitors 页时给一个可见的同步进度反馈(避免「以为卡了」)
        emitTickSummary(settled);
      }

      status.lastTick = now;
      notifySubs();
    };

    /**
     * 把一次 tick 内所有 pollOne 的结果聚合成 0~2 条 toast:
     * - 失败 → toast.error(数量 + 名称)
     * - 成功且有新消息 → toast.info(条数 / 簇数 / 缓存命中)
     * - 用户在 Monitors 页:跳过(已经在页内看见状态)
     * - 其余(0 消息 + 0 失败):跳过
     */
    function emitTickSummary(
      settled: PromiseSettledResult<PollSummary>[],
    ): void {
      if (typeof window === "undefined") return;
      if (window.location.pathname.startsWith("/monitors")) return;

      const ok = settled
        .filter((r): r is PromiseFulfilledResult<PollSummary> => r.status === "fulfilled")
        .map((r) => r.value);
      const rejectedCount = settled.length - ok.length;
      const failedWithin = ok.filter((s) => s.failed).length;
      const failedTotal = rejectedCount + failedWithin;

      const totals = ok.reduce(
        (a, s) => ({
          raw: a.raw + s.rawMessages,
          clusters: a.clusters + s.clusters,
          cacheHits: a.cacheHits + s.cacheHits,
        }),
        { raw: 0, clusters: 0, cacheHits: 0 },
      );

      if (failedTotal > 0) {
        const names = ok
          .filter((s) => s.failed)
          .map((s) => s.displayName)
          .slice(0, 3)
          .join("、");
        const more = ok.filter((s) => s.failed).length > 3 ? "…" : "";
        toast.error(
          `❌ 后台同步失败 ${failedTotal}/${ok.length + rejectedCount} 群(${names}${more})`,
          { duration: 5000 },
        );
        return;
      }

      if (totals.raw === 0) return; // 没有任何群有数据 → 静默

      // 只在用户不在 Monitors 时 toast
      toast.info(
        `✅ 后台同步 ${ok.length} 群 · ${totals.raw} 条 · ${totals.clusters} 簇 · ${totals.cacheHits} 缓存命中`,
        { duration: 4000 },
      );
    }

    /** 计算所有 enabled 监控群中「最早到期」需要等多久 */
    function computeNextDelay(): number {
      const cfg = configRef.current;
      if (cfg.monitors.length === 0) return 60_000;
      const now = Date.now();
      let minDelay = Infinity;
      for (const m of cfg.monitors) {
        if (!m.enabled) continue;
        const sched = m.schedule ?? "interval";
        if (sched === "off") continue;
        if (sched === "realtime") {
          minDelay = Math.min(minDelay, 5_000);
          continue;
        }
        if (sched === "daily") {
          minDelay = Math.min(minDelay, nextDailyDelayMs(m.dailyTimes, now));
          continue;
        }
        // interval
        const secs = m.intervalSeconds && m.intervalSeconds > 0 ? m.intervalSeconds : DEFAULT_INTERVAL_SEC;
        const last = m.lastPolledAt ?? 0;
        const remain = secs * 1000 - (now - last);
        minDelay = Math.min(minDelay, Math.max(remain, 1_000));
      }
      return minDelay === Infinity ? 60_000 : Math.max(minDelay, 1_000);
    }

    function scheduleNext() {
      if (nextTickRef.current != null) {
        clearTimeout(nextTickRef.current);
        nextTickRef.current = null;
      }
      const delay = computeNextDelay();
      nextTickRef.current = window.setTimeout(async () => {
        await tick();
        scheduleNext();
      }, delay);
    }

    // 启动时:等后端起来再立即 tick 一次(最多等 30s)
    (async () => {
      const startWait = Date.now();
      while (Date.now() - startWait < 30_000) {
        try {
          await sidecarRequest("GET", "/health", undefined);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      await tick();
      scheduleNext();
    })();

    // 监听「手动立即拉一次」事件
    const onForcePoll = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        chatroomId: string;
        name: string;
        startSec?: number;
      };
      if (!detail) return;
      pollOne(detail.chatroomId, detail.name, undefined, detail.startSec).catch((err) =>
        console.warn("[monitor] 手动拉取失败:", err),
      );
    };
    window.addEventListener("miao:force-poll", onForcePoll);

    return () => {
      if (intervalRef.current != null) clearInterval(intervalRef.current);
      if (nextTickRef.current != null) clearTimeout(nextTickRef.current);
      window.removeEventListener("miao:force-poll", onForcePoll);
      status.active = false;
      notifySubs();
    };
  }, [update]);

  /**
   * 拉一次某个群(方案 A + B-4 核心):
   * 1. 拉消息(分页)
   * 2. 按时间间隔分簇
   * 3. 批量查缓存
   * 4. 缓存 miss 的簇并行 AI
   * 5. 写缓存 + 每簇入一条通知
   */
  async function pollOne(
    username: string,
    displayName: string,
    lastPolledAt: number | undefined,
    startSecOverride?: number,
  ): Promise<PollSummary> {
    const status = getStatus();
    // summary 在 try 外声明,各 return 都返回它
    const summary: PollSummary = {
      displayName,
      rawMessages: 0,
      clusters: 0,
      cacheHits: 0,
      failed: false,
    };
    if (status.inFlight.has(username)) return summary; // 已经在跑了
    status.inFlight.add(username);
    notifySubs();

    try {
      const cfg = configRef.current;
      if (!cfg.ai) return summary;

      // 智能 startSec 计算
      // 优先用用户配置的 backfillHours,未配置时回退到全局 DEFAULT_BACKFILL_HOURS
      const monitorConfig = cfg.monitors.find((m) => m.chatroomId === username);
      const backfillHours = monitorConfig?.backfillHours ?? DEFAULT_BACKFILL_HOURS;
      const nowSec = Math.floor(Date.now() / 1000);
      const backfillSec = nowSec - backfillHours * 3600;
      const maxBackfillSec = nowSec - MAX_BACKFILL_HOURS * 3600;
      let startSec: number;
      let isBackfill = false;
      if (!lastPolledAt) {
        startSec = backfillSec;
        isBackfill = true;
        console.log(`[monitor] ${displayName} 首次轮询,回补 ${backfillHours} 小时(${backfillHours / 24} 天)前的消息`);
      } else if (lastPolledAt / 1000 < maxBackfillSec) {
        startSec = maxBackfillSec;
        isBackfill = true;
        console.log(`[monitor] ${displayName} 上次轮询过久,回补到 ${MAX_BACKFILL_HOURS / 24} 天`);
      } else {
        startSec = Math.floor(lastPolledAt / 1000);
      }
      // 用户主动指定时间范围(force-poll 选项):从 startSecOverride 起,不走「增量」
      if (startSecOverride !== undefined) {
        startSec = startSecOverride;
        isBackfill = true; // 当作 backfill 走多条 pages 路径
        console.log(`[monitor] ${displayName} 主动拉取,起点 ${new Date(startSec * 1000).toISOString()}`);
      }
      // 后端硬上限 _QUERY_LIMIT_MAX = 500,改成「分页拉取」
      const PAGE_SIZE = 500;
      const MAX_PAGES = isBackfill ? 8 : 2;
      const allTexts: WeChatHistoryMsg[] = [];

      if (isBackfill) {
        status.backfilling.add(username);
        notifySubs();
      }

      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_SIZE;
        const r = await sidecarRequest<WeChatHistoryResp>(
          "POST",
          "/wechat/history",
          { chat: username, limit: PAGE_SIZE, offset, start_ts: startSec },
        );
        const texts = (r.messages ?? []).filter(
          (m) => m.msg_type === "文本" && m.text && m.text.trim(),
        );
        allTexts.push(...texts);
        if (texts.length < PAGE_SIZE) break;
      }

      // 按 timestamp 升序(后端通常已升序,保险起见再排一次)
      allTexts.sort((a, b) => a.timestamp - b.timestamp);

      summary.rawMessages = allTexts.length;
      if (allTexts.length === 0) {
        const now = Date.now();
        update({
          monitors: cfg.monitors.map((m) =>
            m.chatroomId === username
              ? { ...m, lastPolledAt: now, lastPolledMessageCount: 0, lastPolledClusterCount: 0, lastPolledCacheHits: 0 }
              : m,
          ),
        });
        return summary;
      }

      // ============ 方案 A:分簇 ============
      status.clustering.add(username);
      notifySubs();
      const clusters = splitLargeClusters(clusterMessages(allTexts));
      status.clustering.delete(username);
      notifySubs();

      summary.clusters = clusters.length;
      if (clusters.length === 0) {
        const now = Date.now();
        update({
          monitors: cfg.monitors.map((m) =>
            m.chatroomId === username
              ? { ...m, lastPolledAt: now, lastPolledMessageCount: allTexts.length, lastPolledClusterCount: 0, lastPolledCacheHits: 0 }
              : m,
          ),
        });
        return summary;
      }

      console.log(`[monitor] ${displayName} 拆出 ${clusters.length} 个簇`);

      // ============ B-4:批量查缓存 ============
      const clusterHashes = await Promise.all(
        clusters.map((c) => hashCluster(username, c)),
      );
      const cached = await getAICacheBatch(clusterHashes);
      const hitCount = clusterHashes.filter((h) => cached.has(h)).length;
      summary.cacheHits = hitCount;
      console.log(`[monitor] ${displayName} 缓存命中 ${hitCount}/${clusters.length}`);

      // 推断是否群聊
      const isGroup = username.includes('@chatroom');

      // 读同群最近 5 条通知,作为 AI 推断 eventKey 的上下文
      const existing: NotificationItem[] = await loadNotifications();
      const existingEvents: ExistingEventHint[] = existing
        .filter((n) => n.groupName === displayName && n.eventKey)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5)
        .map((n) => ({
          eventKey: n.eventKey!,
          summary: n.summary ?? n.content.slice(0, 60),
          status: n.eventStatus,
        }));

      // ============ 方案 A + B-4:每簇并行(缓存优先) ============
      status.aiAnalyzing.add(username);
      notifySubs();
      const ai = createAIEngine(cfg.ai);
      const engineTag = `${cfg.ai.provider}/${cfg.ai.model}`;

      const results: Array<{ cluster: Cluster; result: SummaryResult }> = await Promise.all(
        clusters.map(async (cluster, i) => {
          const hash = clusterHashes[i];
          // 缓存命中
          const cachedResult = cached.get(hash);
          if (cachedResult) {
            return { cluster, result: cachedResult };
          }
          // 缓存 miss → 调 AI
          const digest = clusterToDigest(cluster);
          const result = await ai.analyzeNotification(
            digest,
            `所在群:${displayName}`,
            existingEvents,
          );
          // 写缓存(失败不影响主流程)
          putAICache(hash, result, engineTag).catch((err) =>
            console.warn(`[monitor] 缓存写入失败:`, err),
          );
          return { cluster, result };
        }),
      );
      status.aiAnalyzing.delete(username);
      notifySubs();

      // ============ 入通知:每簇一条,完成后立刻追加(不等所有簇)============
      // 效果:第一个簇通知 ~1s 就出现,体感比「等所有 AI 完」快得多
      await Promise.all(
        results.map(async ({ cluster, result }) => {
          const newItem: NotificationItem = {
            id: createNotificationId(),
            source: "wechat",
            groupName: displayName,
            conversationId: username,
            isGroup,
            sender: `${cluster.messageCount} 条消息`,
            timestamp: cluster.endTs * 1000,
            content: clusterToDigest(cluster),
            summary: result.summary,
            importance: (result.importance as NotificationImportance) ?? "normal",
            category: result.category,
            keyPoints: result.keyPoints,
            keyInfo: result.keyInfo,
            eventKey: result.eventKey,
            eventStatus: result.eventStatus,
            aiIsTodo: result.isTodo === true,
            // v13 话题分析字段
            topicSummary: result.topicSummary,
            sentiment: result.sentiment,
            participants: result.participants,
          };
          await upsertByEventKey(newItem);
        }),
      );

      const now = Date.now();
      update({
        monitors: cfg.monitors.map((m) =>
          m.chatroomId === username
            ? {
                ...m,
                lastPolledAt: now,
                lastPolledMessageCount: allTexts.length,
                lastPolledClusterCount: clusters.length,
                lastPolledCacheHits: hitCount,
              }
            : m,
        ),
      });

      delete status.lastErrors[username];
      return summary;
    } catch (e) {
      const msg = toErrorMessage(e);
      status.lastErrors[username] = msg;
      console.warn(`[monitor] 轮询 ${displayName} 失败:`, msg);
      summary.failed = true;
      return summary;
    } finally {
      status.inFlight.delete(username);
      status.backfilling.delete(username);
      status.clustering.delete(username);
      status.aiAnalyzing.delete(username);
      notifySubs();
    }
  }
}
