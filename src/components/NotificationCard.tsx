/**
 * 通知卡片
 */
import { Clock, User, MapPin, Calendar, Check, Trash2, ListChecks, Link2 } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import type { NotificationItem } from "../lib/store/notifications";

export type { NotificationItem };

const importanceConfig = {
  urgent: { label: "紧急", color: "urgent", icon: "🔴" },
  important: { label: "重要", color: "important", icon: "🟡" },
  normal: { label: "一般", color: "normal", icon: "🟢" },
  ignore: { label: "可忽略", color: "ignore", icon: "⚪" },
};

export default function NotificationCard({
  notification: n,
  onDelete,
}: {
  notification: NotificationItem;
  onDelete?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [read, setRead] = useState(false);
  const config = importanceConfig[n.importance];

  const time = new Date(n.timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className={clsx(
        "card cursor-pointer transition-all",
        read && "opacity-60",
        n.importance === "urgent" && "border-l-4 border-l-red-500",
        n.importance === "important" && "border-l-4 border-l-amber-500"
      )}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-3">
        {/* 重要度图标 */}
        <div className="text-2xl flex-shrink-0">{config.icon}</div>

        <div className="flex-1 min-w-0">
          {/* 头部 */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className={clsx(
                "text-xs px-2 py-0.5 rounded-full border",
                config.color === "urgent" && "badge-urgent",
                config.color === "important" && "badge-important",
                config.color === "normal" && "badge-normal",
                config.color === "ignore" && "badge-ignore"
              )}
            >
              {config.label}
            </span>
            {n.category && (
              <span className="text-xs text-gray-500">· {n.category}</span>
            )}
            {n.eventStatus === "revoked" && (
              <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded">
                ❌ 已撤销
              </span>
            )}
            {n.eventStatus === "changed" && (
              <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">
                ⚠️ 已变更
              </span>
            )}
            {n.eventKey && (
              <span className="text-xs text-blue-600" title={`事件 ID: ${n.eventKey}`}>
                <Link2 className="w-3 h-3 inline" />
              </span>
            )}
            <span className="text-xs text-gray-400 ml-auto flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {time}
            </span>
          </div>

          {/* 群组 + 发送者 */}
          <div className="text-xs text-gray-500 mb-2 flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-700">{n.groupName}</span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" />
              {n.sender}
            </span>
          </div>

          {/* 摘要（如果有） */}
          {n.summary && (
            <div className="text-sm text-gray-900 mb-2 leading-relaxed">
              📝 {n.summary}
            </div>
          )}

          {/* 重点要点清单（AI 提取的核心，优先展示） */}
          {n.keyPoints && n.keyPoints.length > 0 && (
            <div className="mb-2 bg-brand-50/60 border border-brand-100 rounded-md px-3 py-2">
              <div className="flex items-center gap-1 text-xs font-medium text-brand-700 mb-1">
                <ListChecks className="w-3.5 h-3.5" />
                重点
              </div>
              <ul className="space-y-1">
                {n.keyPoints.map((point, i) => (
                  <li
                    key={i}
                    className="text-sm text-gray-800 leading-relaxed flex gap-1.5"
                  >
                    <span className="text-brand-500 flex-shrink-0 font-medium">{i + 1}.</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 原始内容（折叠时只显示一行） */}
          <div
            className={clsx(
              "text-sm text-gray-600 leading-relaxed",
              !expanded && "line-clamp-1"
            )}
          >
            {n.content}
          </div>

          {/* 关键信息（展开时显示） */}
          {expanded && n.keyInfo && (
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-1 text-xs">
              {n.keyInfo.deadline && (
                <div className="flex items-center gap-1 text-amber-700">
                  <Calendar className="w-3 h-3" />
                  <span className="font-medium">截止:</span> {n.keyInfo.deadline}
                </div>
              )}
              {n.keyInfo.location && (
                <div className="flex items-center gap-1 text-blue-700">
                  <MapPin className="w-3 h-3" />
                  <span className="font-medium">地点:</span> {n.keyInfo.location}
                </div>
              )}
              {n.keyInfo.responsiblePerson && (
                <div className="flex items-center gap-1 text-gray-700">
                  <User className="w-3 h-3" />
                  <span className="font-medium">负责:</span> {n.keyInfo.responsiblePerson}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-col gap-1 flex-shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRead(true);
            }}
            className="text-gray-300 hover:text-brand-500"
            title="标记已读"
          >
            <Check className="w-4 h-4" />
          </button>
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(n.id);
              }}
              className="text-gray-300 hover:text-red-500"
              title="删除"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
