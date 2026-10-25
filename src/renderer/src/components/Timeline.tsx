import type { ReactNode } from 'react';
import type { TaskEvent, FinalReport } from '../../../shared/types';
import { JsonBlock, StatusBadge } from './ui';

export function Timeline({ events, pendingActionIds }: { events: TaskEvent[]; pendingActionIds: Set<string> }): ReactNode {
  if (events.length === 0) {
    return <div className="py-10 text-center text-sm text-zinc-600">尚无执行记录</div>;
  }
  return (
    <div className="space-y-2">
      {events.map((ev) => (
        <EventRow key={`${ev.id}-${ev.ts}`} ev={ev} pending={pendingActionIds.has(String((ev.data as { actionId?: string }).actionId ?? ''))} />
      ))}
    </div>
  );
}

function EventRow({ ev, pending }: { ev: TaskEvent; pending: boolean }): ReactNode {
  const data = ev.data as Record<string, unknown>;
  switch (ev.type) {
    case 'task_started':
      return (
        <Row icon="▶" tone="text-sky-300" title={`任务开始${data.resume ? '（恢复执行）' : ''}`} sub={String(data.workspace ?? '')} />
      );
    case 'plan_submitted': {
      const steps = (data.steps as string[]) ?? [];
      return (
        <Row icon="🗺" tone="text-violet-300" title="执行计划">
          <ol className="mt-1 list-inside list-decimal space-y-0.5 text-sm text-zinc-300">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </Row>
      );
    }
    case 'plan_updated': {
      const steps = (data.steps as Array<{ index: number; title: string; status: string }>) ?? [];
      return (
        <Row icon="🧭" tone="text-violet-300" title="计划进度更新">
          <ul className="mt-1 space-y-0.5 text-sm">
            {steps.map((s) => (
              <li
                key={s.index}
                className={
                  s.status === 'done'
                    ? 'text-emerald-300'
                    : s.status === 'skipped'
                      ? 'text-zinc-500 line-through'
                      : 'text-zinc-400'
                }
              >
                {s.status === 'done' ? '✓' : s.status === 'skipped' ? '⊘' : '·'} {s.index}. {s.title}
              </li>
            ))}
          </ul>
        </Row>
      );
    }
    case 'model_message':
      return (
        <Row icon="💬" tone="text-zinc-300" title="模型回复">
          <div className="mt-1 whitespace-pre-wrap text-sm text-zinc-300">{String(data.text ?? '')}</div>
        </Row>
      );
    case 'tool_call_started':
      return (
        <Row icon="🔧" tone="text-zinc-400" title={`调用 ${data.name}`} sub={String(data.argsSummary ?? '')} />
      );
    case 'tool_call_finished': {
      const ok = Boolean(data.ok);
      return (
        <Row
          icon={ok ? '✓' : '✕'}
          tone={ok ? 'text-emerald-300' : 'text-red-300'}
          title={`${data.name} ${ok ? '完成' : '失败'} · ${String(data.summary ?? '')}`}
          sub={data.durationMs != null ? `${Number(data.durationMs)}ms` : undefined}
        >
          {!ok && data.error != null && <JsonBlock text={JSON.stringify(data.error, null, 2)} />}
        </Row>
      );
    }
    case 'approval_required':
      return (
        <Row
          icon="⏸"
          tone={pending ? 'text-amber-300' : 'text-zinc-500'}
          title={`${pending ? '等待审批' : '审批请求'}：${data.toolName}`}
          sub={`${String(data.argsSummary ?? '')} — ${String(data.reason ?? '')}`}
        />
      );
    case 'approval_resolved':
      return (
        <Row
          icon="⏷"
          tone={data.approved ? 'text-emerald-300' : 'text-red-300'}
          title={data.approved ? '已批准' : '已拒绝'}
        />
      );
    case 'file_changed':
      return (
        <Row
          icon={data.kind === 'create' ? '＋' : '✎'}
          tone="text-emerald-300"
          title={`${data.kind === 'create' ? '新建' : '修改'} ${data.path}`}
          sub={data.backupAvailable ? '（已备份原内容）' : ''}
        />
      );
    case 'file_restored': {
      const action = String(data.action);
      const label =
        action === 'deleted'
          ? '删除了任务创建的文件'
          : action === 'missing'
            ? '文件已不存在，无需处理'
            : '已还原为修改前内容';
      return <Row icon="⟲" tone="text-emerald-300" title={`回滚 ${data.path}`} sub={label} />;
    }
    case 'error':
      return (
        <Row icon="⚠" tone="text-red-300" title={`错误：${String(data.scope ?? '')}（第 ${Number(data.attempt ?? 1)} 次）`}>
          <div className="mt-1 whitespace-pre-wrap text-sm text-red-200/90">{String(data.message ?? '')}</div>
        </Row>
      );
    case 'status_changed':
      return (
        <div className="flex items-center gap-2 pl-2 text-xs text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          <StatusBadge status={String(data.status) as never} />
          <span className="h-px flex-1 bg-zinc-800" />
        </div>
      );
    case 'task_finished': {
      const report = data as unknown as FinalReport;
      return (
        <Row icon="■" tone="text-zinc-200" title="任务结束">
          <div className="mt-1.5 space-y-1.5 text-sm">
            <div>
              <StatusBadge status={report.status} />
            </div>
            {report.summary && (
              <div className="whitespace-pre-wrap text-zinc-300">
                <span className="text-zinc-500">总结：</span>
                {report.summary}
              </div>
            )}
            {report.verification && (
              <div className="whitespace-pre-wrap text-zinc-300">
                <span className="text-zinc-500">验证：</span>
                {report.verification}
              </div>
            )}
            {report.blockers && (
              <div className="whitespace-pre-wrap text-amber-300">
                <span className="text-zinc-500">阻塞/未完成：</span>
                {report.blockers}
              </div>
            )}
            {report.reasons?.map((r, i) => (
              <div key={i} className="text-red-300">• {r}</div>
            ))}
            {report.warnings?.map((w, i) => (
              <div key={i} className="text-amber-300">• {w}</div>
            ))}
          </div>
        </Row>
      );
    }
    default:
      return <Row icon="·" tone="text-zinc-500" title={ev.type} />;
  }
}

function Row({
  icon,
  tone,
  title,
  sub,
  children
}: {
  icon: string;
  tone: string;
  title: string;
  sub?: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 text-sm ${tone}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-zinc-200">{title}</div>
          {sub && <div className="mono mt-0.5 break-all text-xs text-zinc-500">{sub}</div>}
          {children}
        </div>
      </div>
    </div>
  );
}
