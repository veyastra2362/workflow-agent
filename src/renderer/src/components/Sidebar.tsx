import type { ReactNode } from 'react';
import type { TaskSummary } from '../../../shared/types';
import { Btn } from './ui';

export function Sidebar({
  workspace,
  tasks,
  activeTaskId,
  onSelectTask,
  onSelectWorkspace,
  onOpenSettings,
  onOpenTemplates
}: {
  workspace: string | null;
  tasks: TaskSummary[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onSelectWorkspace: () => void;
  onOpenSettings: () => void;
  onOpenTemplates: () => void;
}): ReactNode {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-sky-600/20 text-sm font-bold text-sky-400">
            W
          </div>
          <div>
            <div className="text-sm font-semibold text-zinc-100">Workflow Agent</div>
            <div className="text-xs text-zinc-500">本地工作流 Agent · MVP</div>
          </div>
        </div>
      </div>

      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="mb-1.5 text-xs font-medium text-zinc-500">工作区</div>
        <div className="mono mb-2 truncate rounded-md bg-zinc-900 px-2 py-1.5 text-xs text-zinc-400" title={workspace ?? ''}>
          {workspace ?? '未选择工作区'}
        </div>
        <Btn onClick={onSelectWorkspace} className="w-full justify-center">
          选择目录
        </Btn>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-2 text-xs font-medium text-zinc-500">
          <span>任务历史</span>
          <span>{tasks.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {tasks.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-zinc-600">暂无任务</div>
          )}
          {tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTask(t.id)}
              className={`mb-1 block w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                activeTaskId === t.id ? 'bg-sky-600/10 ring-1 ring-sky-600/40' : 'hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <StatusDot status={t.status} />
                <span className="truncate text-xs text-zinc-300">{t.goal}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 pl-4 text-[10px] text-zinc-600">
                <span>{new Date(t.createdAt).toLocaleString()}</span>
                {t.templateName && <span className="rounded bg-violet-500/10 px-1 text-violet-300">模板</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-zinc-800 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Btn onClick={onOpenTemplates} className="justify-center">
            ▤ 任务模板
          </Btn>
          <Btn onClick={onOpenSettings} className="justify-center">
            ⚙ 设置
          </Btn>
        </div>
      </div>
    </aside>
  );
}

function StatusDot({ status }: { status: TaskSummary['status'] }): ReactNode {
  const color =
    status === 'running'
      ? 'bg-sky-400 animate-pulse'
      : status === 'waiting_approval'
        ? 'bg-amber-400'
        : status === 'completed'
          ? 'bg-emerald-400'
          : status === 'needs_review'
            ? 'bg-yellow-400'
            : status === 'failed'
              ? 'bg-red-400'
              : status === 'paused'
                ? 'bg-violet-400'
                : status === 'interrupted'
                  ? 'bg-orange-400'
                  : 'bg-zinc-500';
  return <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${color}`} />;
}
