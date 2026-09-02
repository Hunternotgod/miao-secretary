/**
 * 通知数据模型 + 类型定义
 *
 * v10 重构：
 * - 存储后端从 localStorage 迁到 IndexedDB（见 db.ts）
 * - 新增 conversationId / isGroup / userStatus / mentionedMe 字段
 * - API 全异步
 *
 * 所有 CRUD 操作请直接 import db.ts：
 *   import { addNotifications, loadAllNotifications } from './db';
 */

// ============ 类型定义 ============

export type NotificationSource = 'wechat' | 'manual';

/**
 * AI 自动判定的「事实标签」
 * - urgent: 紧急（截止时间临近 / 被 @）
 * - important: 重要（非紧急但需要关注）
 * - normal: 一般信息
 * - ignore: 可忽略
 *
 * 注意：v10 不再用 importance 做 UI 强筛选，只作为参考标签
 */
export type NotificationImportance = 'urgent' | 'important' | 'normal' | 'ignore';

/**
 * 事件状态（用于事件链变迁）
 * - active: 进行中（最新有效状态）
 * - changed: 信息有变更
 * - revoked: 已撤销/作废
 */
export type NotificationEventStatus = 'active' | 'changed' | 'revoked';

/**
 * 用户手动标记的状态（v10 新增，取代 AI 自动判定作为 UI 主筛选维度）
 * - todo: 待办（用户标记为「需要做」）
 * - done: 已完成（用户标记为「已完成」）
 * - ignored: 已忽略（移到已忽略抽屉）
 * - null: 未标记（默认，仅在话题区显示）
 */
export type NotificationUserStatus = 'todo' | 'done' | 'ignored' | null;

export interface NotificationItem {
  id: string;
  source: NotificationSource;
  /** 所属群名（兼容老字段） */
  groupName: string;
  /** 发送者 */
  sender: string;
  /** Unix 时间戳（ms） */
  timestamp: number;
  /** 原始消息内容 */
  content: string;
  /** AI 一句话行动摘要 */
  summary?: string;
  /** AI 自动判定的重要级（事实标签，不作为 UI 主筛选） */
  importance: NotificationImportance;
  category?: string;
  /** AI 提取的重点 */
  keyPoints?: string[];
  keyInfo?: {
    deadline?: string;
    time?: string;
    location?: string;
    responsiblePerson?: string;
  };
  /** 事件 ID：同事件的多条通知共享 */
  eventKey?: string;
  /** 本条相对事件的状态 */
  eventStatus?: NotificationEventStatus;

  // ============ v10 新增字段 ============

  /**
   * 会话 ID
   * - 群聊：群 ID
   * - 单聊：好友 ID
   * - 兜底：groupName
   */
  conversationId?: string;
  /** 是否群聊 */
  isGroup?: boolean;
  /** 群成员数（仅群聊） */
  memberCount?: number;
  /** 用户手动标记的状态（取代 importance 作为 UI 主筛选） */
  userStatus?: NotificationUserStatus;
  /** AI 自动判定的待办候选(v11 新增):true 表示这条消息看起来「我需要做点什么」 */
  aiIsTodo?: boolean;
  /** 是否 @ 我(仅群聊) */
  mentionedMe?: boolean;
  // ============ v13 话题分析(不只是待办,普通对话也输出)============
  /** 话题概要:1-3 句话描述对话整体在讨论什么 */
  topicSummary?: string;
  /** 对话情绪:consensus/debate/conflict/casual */
  sentiment?: "consensus" | "debate" | "conflict" | "casual";
  /** 核心参与者(发言多/推动话题的人),最多 5 个 */
  participants?: string[];
}

/**
 * 聚合后的会话视图（UI 层使用，不持久化）
 */
export interface ConversationView {
  conversationId: string;
  name: string;
  isGroup: boolean;
  memberCount?: number;
  /** 该会话的最新一条消息（用于预览） */
  latestItem: NotificationItem;
  /** 该会话所有消息数 */
  totalCount: number;
  /** 该会话待办数（userStatus === 'todo'） */
  todoCount: number;
  /** 该会话等我回数（对方发了，我没回） */
  unrepliedCount: number;
  /** 该会话 @ 我数 */
  mentionCount: number;
  /** 话题数（去重 eventKey） */
  topicCount: number;
  /** 是否置顶 */
  pinned: boolean;
}

// ============ 工具函数 ============

/** 生成唯一 id */
export function createNotificationId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把一组 NotificationItem 按 conversationId 聚合成 ConversationView
 * 纯计算函数，无副作用
 */
export function aggregateByConversation(
  items: NotificationItem[],
  pinnedIds: Set<string>
): ConversationView[] {
  const map = new Map<string, NotificationItem[]>();
  for (const n of items) {
    const cid = n.conversationId ?? n.groupName;
    const list = map.get(cid) ?? [];
    list.push(n);
    map.set(cid, list);
  }

  const views: ConversationView[] = [];
  for (const [cid, list] of map.entries()) {
    list.sort((a, b) => b.timestamp - a.timestamp);
    const latest = list[0];
    const isGroup = latest.isGroup ?? false;
    const memberCount = latest.memberCount;
    const topics = new Set(list.map((n) => n.eventKey ?? n.id));

    views.push({
      conversationId: cid,
      name: latest.groupName,
      isGroup,
      memberCount,
      latestItem: latest,
      totalCount: list.length,
      todoCount: list.filter((n) =>
        n.userStatus === 'todo' ||
        (n.userStatus == null && n.aiIsTodo === true)
      ).length,
      unrepliedCount: list.filter((n) => n.mentionedMe).length, // 简化：@我 视为等我回
      mentionCount: list.filter((n) => n.mentionedMe).length,
      topicCount: topics.size,
      pinned: pinnedIds.has(cid),
    });
  }

  // 排序：置顶在前，然后按最新消息时间倒序
  views.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.latestItem.timestamp - a.latestItem.timestamp;
  });

  return views;
}

// ============ 桥接：旧的同步 API 已经被 async 取代，这里 re-export 新 API ============
// 旧 import 仍然能编译通过，但调用者需要 await
export {
  loadAllNotifications as loadNotifications,
  addNotifications,
  deleteNotification,
  updateNotification,
  clearAllNotifications as clearNotifications,
  loadPinnedConversations,
  pinConversation,
  unpinConversation,
  subscribeDataChange as subscribeNotifications,
  migrateFromLocalStorage,
} from './db';
