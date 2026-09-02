/**
 * 消息分簇 + 簇哈希(方案 A 核心)
 *
 * 簇 = 一组在时间窗口内连续出现的消息,中间没有大段静默。
 * 默认 30 分钟无新消息 = 新簇。
 *
 * 为什么这样分:
 * - 时间间隔 > 30 分钟基本就是「换了一个话题/换了一拨人」
 * - 不依赖 AI(避免鸡生蛋)
 * - 简单可靠,边界清晰
 *
 * 簇哈希:
 * - conversationId + 簇内消息(按时间排序后只取 text) + 簇起止
 * - 同会话同一批消息 = 命中缓存
 */

import type { WeChatHistoryMsg } from "../monitor/types";

/** 簇之间的默认静默阈值(秒) */
export const DEFAULT_CLUSTER_GAP_SEC = 30 * 60; // 30 分钟

/**
 * 单簇最大消息数(超过会被二次切分)
 *
 * 背景:某些群某个时段特别活跃,可能出现 100-200 条消息挤在一个 30 分钟窗口里。
 * 这种「一坨」单次 AI 调用会很慢(prompt 大、模型响应慢)。
 * 切到 80 条以内,单次 AI 响应 ~2s,体感顺。
 *
 * 切分策略:简单按消息数等分(保持原顺序),保证:
 * - 同会话同窗口消息拆分结果确定性 → 缓存键稳定
 * - 不依赖 AI,纯规则切分
 */
export const DEFAULT_MAX_CLUSTER_SIZE = 80;

export interface Cluster {
  /** 簇第一条消息时间戳(秒) */
  startTs: number;
  /** 簇最后一条消息时间戳(秒) */
  endTs: number;
  /** 簇内消息(已按 timestamp 升序) */
  messages: WeChatHistoryMsg[];
  /** 簇内消息数 */
  messageCount: number;
}

/**
 * 把一组消息按时间间隔分簇
 * @param messages 必须已按 timestamp 升序
 * @param gapSec 簇间静默阈值(秒)
 */
export function clusterMessages(
  messages: WeChatHistoryMsg[],
  gapSec: number = DEFAULT_CLUSTER_GAP_SEC
): Cluster[] {
  if (messages.length === 0) return [];

  const clusters: Cluster[] = [];
  let current: WeChatHistoryMsg[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const cur = messages[i];
    if (cur.timestamp - prev.timestamp > gapSec) {
      // 超过阈值,封一个簇
      clusters.push(buildCluster(current));
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  // 最后一簇
  if (current.length > 0) {
    clusters.push(buildCluster(current));
  }

  return clusters;
}

function buildCluster(messages: WeChatHistoryMsg[]): Cluster {
  return {
    startTs: messages[0].timestamp,
    endTs: messages[messages.length - 1].timestamp,
    messages,
    messageCount: messages.length,
  };
}

/**
 * 单条消息文本最大长度(超过会被截断 + …)
 * 防止某个用户发个超长文本(粘贴日志/网页/代码)撑爆 digest
 */
const MAX_MSG_TEXT_CHARS = 200;

/**
 * 把一个簇转换成 AI 用的 digest 文本
 * 格式: [time] sender: text\n 每行一条
 *
 * 限制:
 * - 单条 text 截到 MAX_MSG_TEXT_CHARS(防超长文本)
 * - 总字符数截到 maxChars(防整体 prompt 过大导致 reqwest 发送失败)
 *
 * 默认 maxChars = 2500:大多数 AI provider 单请求 < 8K tokens 不会触发限制,
 * 留足 system prompt(~3K 字) + user prompt 2500 字 + response 2K tokens
 */
export function clusterToDigest(
  cluster: Cluster,
  maxChars: number = 2500
): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of cluster.messages) {
    const text = m.text.length > MAX_MSG_TEXT_CHARS
      ? m.text.slice(0, MAX_MSG_TEXT_CHARS) + "…"
      : m.text;
    const line = `[${m.time}] ${m.sender}: ${text}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * 计算一个簇的稳定哈希
 * 用于 AI 缓存键(同会话同一批消息 = 命中)
 *
 * 哈希内容:
 * - conversationId
 * - 簇起止时间戳
 * - 簇内每条消息的 text(按时间排序)
 *
 * 用 SHA-256(浏览器 SubtleCrypto,有 fallback 到简单哈希)
 */
export async function hashCluster(
  conversationId: string,
  cluster: Cluster
): Promise<string> {
  const parts: string[] = [conversationId, String(cluster.startTs), String(cluster.endTs)];
  for (const m of cluster.messages) {
    parts.push(`${m.timestamp}|${m.text}`);
  }
  const input = parts.join("\n");

  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const buf = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return bytesToHex(digest);
    } catch {
      // fallback
    }
  }
  return simpleHash(input);
}

function bytesToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function simpleHash(s: string): string {
  // djb2 + 简单 fold,纯字符串哈希(非加密),仅用于 fallback
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 把超大簇按消息数二次切分(防止「一坨 200 条」单次 AI 调用太慢)
 *
 * 切分是确定性的(按 N 等分),保证缓存键稳定:
 * 同会话同窗口的消息,二次切分结果永远一致 → 缓存命中率不下降。
 *
 * @param clusters 已按时间分好的簇
 * @param maxSize 单簇最大消息数
 */
export function splitLargeClusters(
  clusters: Cluster[],
  maxSize: number = DEFAULT_MAX_CLUSTER_SIZE
): Cluster[] {
  if (maxSize <= 0) return clusters;
  const result: Cluster[] = [];
  for (const c of clusters) {
    if (c.messageCount <= maxSize) {
      result.push(c);
      continue;
    }
    // 按 maxSize 等分
    for (let i = 0; i < c.messages.length; i += maxSize) {
      const chunk = c.messages.slice(i, i + maxSize);
      result.push(buildCluster(chunk));
    }
  }
  return result;
}
