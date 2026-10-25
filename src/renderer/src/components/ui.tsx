import type { ReactNode } from 'react';
import type { TaskStatus } from '../../../shared/types';
import { STATUS_LABELS } from '../../../shared/types';

const STATUS_STYLES: Record<TaskStatus, string> = {
  queued: 'border-zinc-600/40 bg-zinc-700/20 text-zinc-300',
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  waiting_approval: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  paused: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  needs_review: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-300',
  cancelled: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
  interrupted: 'border-orange-500/30 bg-orange-500/10 text-orange-300'
};

export function StatusBadge({ status }: { status: TaskStatus }): ReactNode {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[status]}`}
    >
      {status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

type BtnVariant = 'primary' | 'danger' | 'ghost' | 'success' | 'warn';

const BTN_STYLES: Record<BtnVariant, string> = {
  primary: 'bg-sky-600 hover:bg-sky-500 text-white border-transparent',
  success: 'bg-emerald-600 hover:bg-emerald-500 text-white border-transparent',
  warn: 'bg-amber-600 hover:bg-amber-500 text-white border-transparent',
  danger: 'bg-red-600/90 hover:bg-red-500 text-white border-transparent',
  ghost: 'bg-zinc-800/60 hover:bg-zinc-700/70 text-zinc-200 border-zinc-700'
};

export function Btn({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  className = '',
  title
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: BtnVariant;
  disabled?: boolean;
  className?: string;
  title?: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BTN_STYLES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900/60 ${className}`}>{children}</div>
  );
}

export function Field({
  label,
  children,
  hint
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}): ReactNode {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-600">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-sky-600';

export function JsonBlock({ text }: { text: string }): ReactNode {
  return (
    <pre className="mono mt-1 max-h-64 overflow-auto rounded-md bg-zinc-950/80 p-2 text-xs leading-relaxed text-zinc-400">
      {text}
    </pre>
  );
}

export function DiffBlock({ diff }: { diff: string }): ReactNode {
  const lines = diff.split('\n');
  return (
    <pre className="mono mt-1 max-h-72 overflow-auto rounded-md bg-zinc-950/80 p-2 text-xs leading-relaxed">
      {lines.map((line, i) => {
        let cls = 'text-zinc-400';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400';
        else if (line.startsWith('@@')) cls = 'text-sky-400';
        else if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-zinc-500';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
