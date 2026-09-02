/**
 * 全局 Toast 系统
 *
 * 用法:
 *   import { toast } from '@/components/ui/Toast';
 *   toast.success('已保存');
 *   toast.error('保存失败', { action: { label: '重试', onClick: handleRetry } });
 *
 * 设计:
 *   - Portal 渲染到 body,避免被父元素 overflow:hidden 截断
 *   - 右上角堆叠,最多 5 条
 *   - 自动消失(success/info 3s,warning 4s,error 手动关)
 *   - slide-in from right 动画
 */
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import clsx from 'clsx';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: ToastAction;
}

interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

interface ToastAPI {
  success: (msg: string, opts?: ToastOptions) => void;
  error: (msg: string, opts?: ToastOptions) => void;
  warning: (msg: string, opts?: ToastOptions) => void;
  info: (msg: string, opts?: ToastOptions) => void;
}

const MAX_VISIBLE = 5;

const listeners = new Set<(toast: ToastItem) => void>();

function emit(item: ToastItem) {
  // 超过上限:丢弃最旧的(简单起,这里直接限制加入队列)
  listeners.forEach((cb) => cb(item));
}

export const toast: ToastAPI = {
  success: (msg, opts) => emit({ id: crypto.randomUUID(), type: 'success', message: msg, duration: opts?.duration ?? 3000, action: opts?.action }),
  error: (msg, opts) => emit({ id: crypto.randomUUID(), type: 'error', message: msg, duration: opts?.duration, action: opts?.action }),
  warning: (msg, opts) => emit({ id: crypto.randomUUID(), type: 'warning', message: msg, duration: opts?.duration ?? 4000, action: opts?.action }),
  info: (msg, opts) => emit({ id: crypto.randomUUID(), type: 'info', message: msg, duration: opts?.duration ?? 3000, action: opts?.action }),
};

// ============ Provider + 渲染 ============

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const handler = (item: ToastItem) => {
      setItems((prev) => {
        const filtered = prev.filter((t) => t.id !== item.id);
        // 限制堆叠数(丢最旧的)
        const next = [...filtered, item];
        return next.length > MAX_VISIBLE ? next.slice(-MAX_VISIBLE) : next;
      });
      // 自动消失
      if (item.duration && item.duration > 0) {
        setTimeout(() => remove(item.id), item.duration);
      }
    };
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, [remove]);

  return (
    <>
      {children}
      {createPortal(<ToastViewport items={items} onRemove={remove} />, document.body)}
    </>
  );
}

function ToastViewport({ items, onRemove }: { items: ToastItem[]; onRemove: (id: string) => void }) {
  return (
    <div className="fixed top-4 right-4 flex flex-col gap-2 pointer-events-none" style={{ zIndex: 9999 }}>
      {items.map((t) => (
        <ToastCard key={t.id} item={t} onClose={() => onRemove(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const config = {
    success: { icon: CheckCircle2, color: 'bg-green-50 border-green-300 text-green-800', iconColor: 'text-green-500' },
    error:   { icon: AlertCircle,  color: 'bg-red-50 border-red-300 text-red-800',     iconColor: 'text-red-500' },
    warning: { icon: AlertTriangle,color: 'bg-amber-50 border-amber-300 text-amber-800', iconColor: 'text-amber-500' },
    info:    { icon: Info,         color: 'bg-blue-50 border-blue-300 text-blue-800',   iconColor: 'text-blue-500' },
  }[item.type];

  const Icon = config.icon;

  return (
    <div
      role="alert"
      className={clsx(
        'pointer-events-auto min-w-[280px] max-w-md rounded-lg border shadow-lg px-3.5 py-3 flex items-start gap-2.5',
        'animate-slide-in-right backdrop-blur-sm',
        config.color
      )}
    >
      <Icon className={clsx('w-5 h-5 shrink-0 mt-0.5', config.iconColor)} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium leading-relaxed break-words">{item.message}</div>
        {item.action && (
          <button
            onClick={() => { item.action!.onClick(); onClose(); }}
            className="mt-1.5 text-xs font-medium underline hover:no-underline opacity-80 hover:opacity-100"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        onClick={onClose}
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
        aria-label="关闭"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
