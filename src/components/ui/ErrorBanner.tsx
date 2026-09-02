/**
 * 通用错误条
 *
 * 行为：
 *   - 黄色（warn）= 瞬时故障，可自动重试
 *   - 红色（error）= 用户操作错，不自动重试
 *   - retryable=true 时显示倒计时，到 0 自动调 onRetry
 *   - 倒计时期间用户可点「立即重试」跳过等待
 *   - 任何时候可点 X 关闭（onDismiss）
 *
 * 用法：
 *   <ErrorBanner
 *     message={error}
 *     retryable
 *     retryIn={5}
 *     onRetry={loadStatus}
 *     onDismiss={() => setError(null)}
 *     severity="warn"
 *   />
 */
import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, RefreshCw, X } from "lucide-react";
import clsx from "clsx";
import type { ErrorSeverity } from "../../lib/errors";

interface ErrorBannerProps {
  message: string;
  retryable?: boolean;
  retryIn?: number;
  onRetry?: () => void;
  onDismiss?: () => void;
  severity?: ErrorSeverity;
}

export default function ErrorBanner({
  message,
  retryable = false,
  retryIn = 5,
  onRetry,
  onDismiss,
  severity = "error",
}: ErrorBannerProps) {
  const [countdown, setCountdown] = useState(retryIn);
  const [running, setRunning] = useState(retryable && !!onRetry);

  // 当 message 变化时重置倒计时（新一次错误，重新开始 5 秒等待）
  useEffect(() => {
    setCountdown(retryIn);
    setRunning(retryable && !!onRetry);
  }, [message, retryIn, retryable, onRetry]);

  // 倒计时逻辑
  useEffect(() => {
    if (!running) return;
    if (countdown <= 0) {
      setRunning(false);
      onRetry?.();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown, running, onRetry]);

  const Icon = severity === "warn" ? AlertTriangle : AlertCircle;
  const palette =
    severity === "warn"
      ? "bg-amber-50 border-amber-200 text-amber-800"
      : "bg-red-50 border-red-200 text-red-700";

  return (
    <div
      role="alert"
      className={clsx(
        "text-xs rounded-lg px-3 py-2 flex items-start gap-2 border whitespace-pre-line",
        palette,
      )}
    >
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div>{message}</div>
        {retryable && onRetry && (
          <div className="mt-1 flex items-center gap-2 text-[11px] opacity-80">
            {running && countdown > 0 ? (
              <>
                <span>{countdown} 秒后自动重试…</span>
                <button
                  type="button"
                  onClick={() => {
                    setRunning(false);
                    onRetry();
                  }}
                  className="underline hover:no-underline font-medium"
                >
                  立即重试
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRunning(false);
                  onRetry();
                }}
                className="underline hover:no-underline font-medium inline-flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                重试
              </button>
            )}
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭"
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
