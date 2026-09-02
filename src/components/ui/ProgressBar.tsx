/**
 * 通用进度条组件
 *
 * 用法:
  - <ProgressBar value={60} label="拉取第 2 页" sublabel="共 5 页 · 250 条" />
  - <ProgressBar value={done} total={total} label="分析消息" />
  - <ProgressBar indeterminate label="AI 分析中..." />  // 不定进度
 */
import { Loader2, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';

type Variant = 'primary' | 'success' | 'warning' | 'danger';

interface Props {
  /** 0-100。如果给了 total,value 是 done 数量,内部算百分比 */
  value?: number;
  total?: number;
  /** 不定进度模式(脉动条) */
  indeterminate?: boolean;
  /** 主标签 */
  label?: string;
  /** 副标签(进度细节) */
  sublabel?: string;
  /** 颜色变体 */
  variant?: Variant;
  /** 显示完成状态(绿勾) */
  done?: boolean;
  className?: string;
}

const VARIANT_BG: Record<Variant, string> = {
  primary: 'bg-brand-500',
  success: 'bg-green-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
};

export function ProgressBar(props: Props) {
  const { value, total, indeterminate, label, sublabel, variant = 'primary', done, className } = props;
  const pct = indeterminate ? undefined : Math.max(0, Math.min(100,
    total != null && value != null ? (value / total) * 100 : value ?? 0
  ));

  return (
    <div className={clsx('space-y-1', className)}>
      {(label || sublabel) && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-gray-700">
            {done ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-500" />
            )}
            {label}
          </span>
          {sublabel && (
            <span className="text-gray-500 tabular-nums">{sublabel}</span>
          )}
        </div>
      )}
      <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
        {indeterminate ? (
          <div className={clsx('h-1.5 rounded-full animate-progress-indeterminate', VARIANT_BG[variant])} />
        ) : (
          <div
            className={clsx('h-1.5 rounded-full transition-all duration-300 ease-out', VARIANT_BG[variant])}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
