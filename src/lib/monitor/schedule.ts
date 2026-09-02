/**
 * 监控调度引擎(小白友好版,无 cron)
 *
 * 每个 MonitorGroup 有 schedule 字段:
 * - off: 永不(只能手动)
 * - realtime: 每 5 秒(秒级监控,跟 useMonitorLoop.computeNextDelay 保持一致)
 * - interval: 每 N 分钟(读 intervalMinutes)
 * - daily: 每天 N 个时间点(读 dailyTimes: ["09:00", "18:00"])
 */
import type { MonitorSchedule } from "../store/config";

export interface SchedulePreset {
  id: MonitorSchedule;
  label: string;
  emoji: string;
  description: string;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: "off", label: "关闭", emoji: "⏸️", description: "不自动跑,只能手动触发" },
  { id: "realtime", label: "实时", emoji: "⚡", description: "每 5 秒抓一次(秒级监控)" },
  { id: "interval", label: "每 N 分钟", emoji: "🔄", description: "按固定间隔抓(默认每小时)" },
  { id: "daily", label: "每天定时", emoji: "📅", description: "每天指定时间点抓(可多个)" },
];

/** 默认间隔(秒) */
export const DEFAULT_INTERVAL_SEC = 3600; // 1 小时

/** 默认每日时间点 */
export const DEFAULT_DAILY_TIMES = ["09:00"];
/** 最小间隔(秒):允许秒级监控,适合活跃群 */
export const MIN_INTERVAL_SEC = 2;

/**
 * 默认回补窗口(小时)
 *
 * 场景:用户打开 app 时,如果某监控群从未轮询过(或 lastPolledAt 太老),
 * 就把这个窗口内的消息全部拉回来。
 *
 * - 默认 168 小时 = 7 天:覆盖一般周末/工作日休息的常见缺口
 * - 单群 pull 上限 2000 条(在 useMonitorLoop.ts 里)
 * - 用户改这个值后,新打开 app 时生效
 */
export const DEFAULT_BACKFILL_HOURS = 168;

/**
 * 任意一次轮询最多往前看多少小时(防止 start_ts 被算成远古)
 * 留个硬上限,避免误操作拉到 1w 条消息
 */
export const MAX_BACKFILL_HOURS = 24 * 30; // 30 天
/** 最大间隔(秒):超过 24 小时建议用 dailyTimes 模式 */
export const MAX_INTERVAL_SEC = 86400;

/** 总秒数 → {时, 分, 秒} */
export function splitSeconds(totalSec: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.floor(totalSec));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

/** {时, 分, 秒} → 总秒数 */
export function joinSeconds(h: number, m: number, s: number): number {
  return Math.max(0, h) * 3600 + Math.max(0, m) * 60 + Math.max(0, s);
}

/** 时间点字符串 → 当天 Date(若今天时间点已过则返回 null) */
function todayTimePoint(hhmm: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  const d = new Date(now);
  d.setHours(h, mm, 0, 0);
  const ts = d.getTime();
  return ts > now ? null : ts;
}

/**
 * 判断一个群现在是否该被轮询
 * - off: false
 * - realtime: now - last >= 5 秒
 * - interval: now - last >= intervalMinutes 分钟
 * - daily: 在 [last, now] 窗口内,任何一个 dailyTimes 时间点落在窗口里
 */
export function shouldPollNow(
  schedule: MonitorSchedule,
  lastPolledAt: number | undefined,
  intervalSeconds: number | undefined,
  dailyTimes: string[] | undefined,
  now: number = Date.now(),
): boolean {
  if (schedule === "off") return false;
  const last = lastPolledAt ?? 0;

  if (schedule === "realtime") {
    // v11 起改为秒级:跟 useMonitorLoop.computeNextDelay 的 5_000 对齐
    // (原 15min 是 bug:monitor 每 5s 醒一次,但 shouldPollNow 说要等 15min,永不触发)
    return now - last >= 5_000;
  }

  if (schedule === "interval") {
    const secs = intervalSeconds && intervalSeconds > 0 ? intervalSeconds : DEFAULT_INTERVAL_SEC;
    return now - last >= secs * 1000;
  }

  if (schedule === "daily") {
    const times = dailyTimes && dailyTimes.length > 0 ? dailyTimes : DEFAULT_DAILY_TIMES;
    // 找 [last, now] 窗口内的最早未处理时间点
    for (const t of times) {
      const ts = todayTimePoint(t, now);
      if (ts !== null && ts > last && ts <= now) {
        return true;
      }
    }
    return false;
  }

  return false;
}

/**
 * 给 UI 显示用:该群距下次轮询还差多久
 * - off: null
 * - realtime: "15 分钟后" 之类
 * - interval: 按 intervalMinutes 算
 * - daily: 今天剩余时间点中最近的一个;若都已过,显示明天最早的一个
 */
export function nextPollHint(
  schedule: MonitorSchedule,
  lastPolledAt: number | undefined,
  intervalSeconds: number | undefined,
  dailyTimes: string[] | undefined,
  enabled: boolean,
  now: number = Date.now(),
): string {
  if (!enabled) return "已停用";
  if (schedule === "off") return "仅手动";

  const last = lastPolledAt;

  if (schedule === "realtime") {
    if (!last) return "尚未轮询";
    const remain = 5_000 - (now - last);
    if (remain <= 0) return "即将轮询";
    return `${Math.ceil(remain / 1000)} 秒后`;
  }

  if (schedule === "interval") {
    const secs = intervalSeconds && intervalSeconds > 0 ? intervalSeconds : DEFAULT_INTERVAL_SEC;
    if (!last) return "尚未轮询";
    const remainMs = secs * 1000 - (now - last);
    if (remainMs <= 0) return "即将轮询";
    if (remainMs < 60_000) return `${Math.ceil(remainMs / 1000)} 秒后`;
    if (remainMs < 3600_000) return `${Math.ceil(remainMs / 60_000)} 分钟后`;
    return `约 ${Math.ceil(remainMs / 3600_000)} 小时后`;
  }

  if (schedule === "daily") {
    const times = dailyTimes && dailyTimes.length > 0 ? dailyTimes : DEFAULT_DAILY_TIMES;
    if (times.length === 0) return "未设置时间点";
    // 今天的剩余时间点
    const todayPoints: number[] = [];
    for (const t of times) {
      const ts = todayTimePoint(t, now);
      if (ts !== null) todayPoints.push(ts);
    }
    if (todayPoints.length > 0) {
      const earliest = Math.min(...todayPoints);
      if (earliest > now) {
        const d = new Date(earliest);
        return `今天 ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
      }
      // 今天所有时间点都过了 → 看明天最早的
      const tomorrowTimes: number[] = [];
      for (const t of times) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
        if (!m) continue;
        const h = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const d = new Date(now + 24 * 60 * 60_000);
        d.setHours(h, mm, 0, 0);
        tomorrowTimes.push(d.getTime());
      }
      tomorrowTimes.sort((a, b) => a - b);
      const next = tomorrowTimes[0];
      const d = new Date(next);
      return `明天 ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    }
    return "未设置时间点";
  }

  return "";
}
