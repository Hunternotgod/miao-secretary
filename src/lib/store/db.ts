/**
 * IndexedDB 存储层(v10 重构 + v12 升级)
 *
 * v10:用 dexie.js 替代 localStorage
 * v12:加 ai_cache 表(方案 B-4 + A 的簇级缓存)
 *
 * 数据迁移:第一次启动时从 localStorage 一次性搬过来,搬完标记 flag
 * 跨 tab 同步:BroadcastChannel + CustomEvent 兜底
 */

import Dexie, { type Table } from 'dexie';
import type { NotificationItem } from './notifications';
import type { SummaryResult } from '../ai/types';

export interface PinnedConversation {
  conversationId: string;
  pinnedAt: number;
}

/**
 * AI 结果缓存(v12 新增)
 * - key: 簇哈希(SHA-256 hex)
 * - value: AI 返回的 SummaryResult
 * - 命中 = 跳过 AI 调用,直接用 result
 *
 * 写入策略:miss → 调 AI → 写入缓存;hit → 直接读
 * 清理策略:目前不主动清理(IndexedDB 容量足够);将来可加 LRU
 */
export interface AICacheEntry {
  /** 簇哈希(SHA-256 hex,主键) */
  hash: string;
  /** 入库时间 */
  createdAt: number;
  /** AI 引擎标识(provider/model),用于排查「缓存错配」问题 */
  engine: string;
  /** AI 返回结果 */
  result: SummaryResult;
}

class MiaoSecretaryDB extends Dexie {
  notifications!: Table<NotificationItem, string>;
  pinnedConversations!: Table<PinnedConversation, string>;
  aiCache!: Table<AICacheEntry, string>;

  constructor() {
    super('miao-secretary');
    // v1: 基础 notifications + pinned
    this.version(1).stores({
      notifications: 'id, conversationId, timestamp, userStatus, eventKey',
      pinnedConversations: 'conversationId, pinnedAt',
    });
    // v2: 加 ai_cache 表(方案 A + B-4)
    //   升级是自动的:dexie 会在第一次 open 时按 schema 创建缺失的表
    this.version(2).stores({
      notifications: 'id, conversationId, timestamp, userStatus, eventKey',
      pinnedConversations: 'conversationId, pinnedAt',
      aiCache: 'hash, createdAt',
    });
  }
}

export const db = new MiaoSecretaryDB();

const LEGACY_STORAGE_KEY = 'miao-secretary-notifications';
const MIGRATION_FLAG = 'miao-secretary-idb-migrated';

/**
 * 从 localStorage 一次性迁移到 IndexedDB
 * 用 flag 防重复,幂等
 */
export async function migrateFromLocalStorage(): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG) === '1') return;

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) {
    localStorage.setItem(MIGRATION_FLAG, '1');
    return;
  }

  try {
    const items: NotificationItem[] = JSON.parse(legacy);
    if (!Array.isArray(items) || items.length === 0) {
      localStorage.setItem(MIGRATION_FLAG, '1');
      return;
    }

    // 补全 v10/v11/v12 新字段(向后兼容老数据)
    const enriched = items.map((n) => ({
      ...n,
      conversationId: n.conversationId ?? n.groupName,
      isGroup: n.isGroup ?? false,
      userStatus: n.userStatus ?? null,
      mentionedMe: n.mentionedMe ?? false,
      aiIsTodo: n.aiIsTodo ?? false,
    }));

    await db.notifications.bulkPut(enriched);
    localStorage.setItem(MIGRATION_FLAG, '1');
    console.log(`[db] 迁移完成:${enriched.length} 条 → IndexedDB`);
  } catch (e) {
    console.error('[db] 迁移失败:', e);
  }
}

/**
 * 跨 tab / 同 tab 同步通道
 *
 * 关键设计:
 * - BroadcastChannel 用于跨 tab 同步
 * - CustomEvent('miao:data-changed') 用于同 tab 同步
 *   (BroadcastChannel.postMessage 不会触发同 tab 的监听者)
 *   这个 bug 导致之前 monitor 写入后,Timeline 不刷新,看起来像「监控没生效」
 */
const channel = new BroadcastChannel('miao-secretary-sync');
const LOCAL_EVENT = 'miao:data-changed';

export function notifyDataChanged(): void {
  channel.postMessage({ type: 'changed', at: Date.now() });
  // 同 tab 兜底:用 CustomEvent 在当前 tab 也触发监听者
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT));
}

export function subscribeDataChange(cb: () => void): () => void {
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'changed') cb();
  };
  // 同 tab CustomEvent
  const localHandler = () => cb();
  channel.addEventListener('message', handler);
  window.addEventListener(LOCAL_EVENT, localHandler);
  // 兜底:也监听 localStorage 事件(双写过渡期有用)
  const legacyHandler = (e: StorageEvent) => {
    if (e.key === LEGACY_STORAGE_KEY) cb();
  };
  window.addEventListener('storage', legacyHandler);
  return () => {
    channel.removeEventListener('message', handler);
    window.removeEventListener(LOCAL_EVENT, localHandler);
    window.removeEventListener('storage', legacyHandler);
  };
}

// ============ Notifications CRUD ============

export async function loadAllNotifications(): Promise<NotificationItem[]> {
  return await db.notifications.orderBy('timestamp').reverse().toArray();
}

export async function addNotifications(
  items: NotificationItem[]
): Promise<NotificationItem[]> {
  const enriched = items.map((n) => ({
    ...n,
    conversationId: n.conversationId ?? n.groupName,
    isGroup: n.isGroup ?? false,
    userStatus: n.userStatus ?? null,
    mentionedMe: n.mentionedMe ?? false,
    aiIsTodo: n.aiIsTodo ?? false,
  }));
  await db.notifications.bulkPut(enriched);
  notifyDataChanged();
  return await loadAllNotifications();
}

/**
 * 单条追加(方案 A 增量反馈用):每簇 AI 完一条立刻写入,不等所有簇完成
 * - 比 addNotifications 轻:不重 load 全表
 * - 仍然走 notifyDataChanged,Timeline 实时刷新
 */
export async function appendNotification(item: NotificationItem): Promise<void> {
  const enriched = {
    ...item,
    conversationId: item.conversationId ?? item.groupName,
    isGroup: item.isGroup ?? false,
    userStatus: item.userStatus ?? null,
    mentionedMe: item.mentionedMe ?? false,
    aiIsTodo: item.aiIsTodo ?? false,
  };
  await db.notifications.put(enriched);
  notifyDataChanged();
}

/**
 * 按 (conversationId, eventKey) 去重(v13):
 * - 找到已存在 → 用新内容覆盖,但保留用户标记的 userStatus(待办/已完成/已忽略)
 *   和 mentionedMe(避免老数据被新数据意外重置)
 * - 没找到 → 当作新通知追加
 * - item.eventKey 为空 → 当作新通知(闲聊类通常没 eventKey)
 *
 * 设计意图:
 * 用户「自动补拉 7 天」后再「立即拉最近 1 天」,重叠时段同 eventKey 的 cluster
 * 会拿到 AI 的更新摘要(更准),未覆盖的老 cluster 完整保留。
 * 用户手动标的「待办」「已完成」不会被新数据覆盖掉。
 */
export async function upsertByEventKey(
  item: NotificationItem
): Promise<{ action: "created" | "updated" }> {
  const enriched = {
    ...item,
    conversationId: item.conversationId ?? item.groupName,
    isGroup: item.isGroup ?? false,
    userStatus: item.userStatus ?? null,
    mentionedMe: item.mentionedMe ?? false,
    aiIsTodo: item.aiIsTodo ?? false,
  };

  if (!enriched.eventKey) {
    // 没 eventKey 直接追加(闲聊类不适合去重)
    await db.notifications.put(enriched);
    notifyDataChanged();
    return { action: "created" };
  }

  const existing = await db.notifications
    .where("conversationId")
    .equals(enriched.conversationId)
    .filter((n) => n.eventKey === enriched.eventKey)
    .first();

  if (existing) {
    // 覆盖:新内容 + 保留 id / userStatus / userTags
    const merged: NotificationItem = {
      ...enriched,
      id: existing.id, // 沿用旧 id,保持引用稳定
      userStatus: existing.userStatus, // 保留用户手动标记
    };
    await db.notifications.put(merged);
    notifyDataChanged();
    return { action: "updated" };
  } else {
    await db.notifications.put(enriched);
    notifyDataChanged();
    return { action: "created" };
  }
}

export async function deleteNotification(id: string): Promise<NotificationItem[]> {
  await db.notifications.delete(id);
  notifyDataChanged();
  return await loadAllNotifications();
}

export async function updateNotification(
  id: string,
  patch: Partial<NotificationItem>
): Promise<NotificationItem[]> {
  await db.notifications.update(id, patch);
  notifyDataChanged();
  return await loadAllNotifications();
}

export async function clearAllNotifications(): Promise<NotificationItem[]> {
  await db.notifications.clear();
  notifyDataChanged();
  return [];
}

// ============ AI 缓存 CRUD(方案 B-4) ============

/**
 * 批量查询缓存(主键 in)
 * @returns 命中的 hash → result 映射
 */
export async function getAICacheBatch(
  hashes: string[]
): Promise<Map<string, SummaryResult>> {
  if (hashes.length === 0) return new Map();
  const entries = await db.aiCache.bulkGet(hashes);
  const out = new Map<string, SummaryResult>();
  entries.forEach((e) => {
    if (e) out.set(e.hash, e.result);
  });
  return out;
}

/**
 * 写入单条缓存(覆盖)
 */
export async function putAICache(
  hash: string,
  result: SummaryResult,
  engine: string
): Promise<void> {
  await db.aiCache.put({
    hash,
    createdAt: Date.now(),
    engine,
    result,
  });
}

/**
 * 清空缓存(调试 / 用户主动清)
 */
export async function clearAICache(): Promise<void> {
  await db.aiCache.clear();
}

// ============ 置顶会话 ============

export async function loadPinnedConversations(): Promise<string[]> {
  const list = await db.pinnedConversations.orderBy('pinnedAt').reverse().toArray();
  return list.map((p) => p.conversationId);
}

export async function pinConversation(conversationId: string): Promise<void> {
  await db.pinnedConversations.put({ conversationId, pinnedAt: Date.now() });
  notifyDataChanged();
}

export async function unpinConversation(conversationId: string): Promise<void> {
  await db.pinnedConversations.delete(conversationId);
  notifyDataChanged();
}
