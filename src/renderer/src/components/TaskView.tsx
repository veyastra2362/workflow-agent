import { useMemo, useState, type ReactNode } from 'react';
import type { FinalReport, PlanStep, TaskDetail, TaskEvent, TaskStatus } from '../../../shared/types';
import { Timeline } from './Timeline';
import { Btn, Card, DiffBlock, JsonBlock, StatusBadge } from './ui';

type TabKey = 'timeline' | 'files' | 'approvals' | 'result';

const RESTORABLE_STATUSES: TaskStatus[] = ['completed', 'needs_review', 'failed', 'cancelled', 'interrupted'];

export function TaskView({
  detail,
  events,
  workspace,
  busy,
  onStart,
  onCancel,
  onPause,
  onResume,
  onApprove,
  onRestoreChange,
  onRestoreAll
}: {
  detail: TaskDetail | null;
  events: TaskEvent[];
  workspace: string | null;
  busy: boolean;
  onStart: (goal: string, acceptance: string) => void;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  onApprove: (actionId: string, approved: boolean) => void;
  onRestoreChange: (changeId: number) => void;
  onRestoreAll: () => void;
}): ReactNode {
  const [goal, setGoal] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [tab, setTab] = useState<TabKey>('timeline');

  const status = detail?.status;
  const active = status === 'running' || status === 'waiting_approval' || status === 'queued';
  const canRestore = !!detail && RESTORABLE_STATUSES.includes(detail.status);
  const fileChanges = detail?.fileChanges ?? [];

  const pendingApprovals = useMemo(() => {
    const resolved = new Set<string>();
    const required: TaskEvent[] = [];
    for (const ev of events) {
      if (ev.type === 'approval_required') required.push(ev);
      if (ev.type === 'approval_resolved') resolved.add(String((ev.data as { actionId?: string }).actionId));
    }
    return required.filter((ev) => !resolved.has(String((ev.data as { actionId?: string }).actionId)));
  }, [events]);

  const pendingIds = useMemo(() => new Set(pendingApprovals.map((e) => String((e.data as { actionId?: string }).actionId))), [pendingApprovals]);
  const fileChangeEvents = useMemo(() => events.filter((e) => e.type === 'file_changed'), [events]);
  const report: FinalReport | undefined = detail?.report;
  const plan = useMemo<{ steps: PlanStep[] } | null>(() => {
    if (!detail?.planJson) return null;
    try {
      const parsed = JSON.parse(detail.planJson) as { steps?: PlanStep[] };
      return parsed.steps ? { steps: parsed.steps } : null;
    } catch {
      return null;
    }
  }, [detail?.planJson]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* 任务输入区 */}
      <div className="border-b border-zinc-800 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span>工作区</span>
            <span className="mono rounded bg-zinc-800/70 px-1.5 py-0.5 text-zinc-400">{workspace ?? '未选择'}</span>
            {detail?.templateName && (
              <span
                className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-300"
                title={`来自模板：${detail.templateName}`}
              >
                模板：{detail.templateName}
              </span>
            )}
            {detail && <StatusBadge status={detail.status} />}
          </div>
          <div className="flex gap-2">
            {active && (
              <>
                <Btn variant="warn" onClick={onPause} disabled={busy} title="当前步骤结束后暂停">
                  ⏸ 暂停
                </Btn>
                <Btn variant="danger" onClick={onCancel} disabled={busy}>
                  ■ 取消
                </Btn>
              </>
            )}
            {status === 'paused' && (
              <Btn variant="primary" onClick={onResume} disabled={busy}>
                ▶ 恢复
              </Btn>
            )}
            {status === 'interrupted' && (
              <Btn variant="primary" onClick={onResume} disabled={busy}>
                ▶ 从中断处恢复
              </Btn>
            )}
          </div>
        </div>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="描述任务目标，例如：整理 src 目录下的工具函数，把重复的日期格式化代码合并到 utils/date.ts，并保证测试通过"
          rows={3}
          disabled={active}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-sky-600 disabled:opacity-60"
        />
        <div className="mt-2 flex items-end gap-2">
          <textarea
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            placeholder="验收标准（可选）：例如 vitest 全部通过、目录中不再有重复实现"
            rows={1}
            disabled={active}
            className="flex-1 resize-y rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-300 placeholder-zinc-600 focus:border-sky-600 disabled:opacity-60"
          />
          <Btn variant="primary" disabled={active || busy || !workspace || goal.trim().length === 0} onClick={() => onStart(goal, acceptance)}>
            ▶ 运行任务
          </Btn>
        </div>
        {!workspace && <div className="mt-1.5 text-xs text-amber-400/80">请先在左侧选择工作区目录</div>}
      </div>

      {/* 计划进度条 */}
      {plan && plan.steps.length > 0 && (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
          <span className="shrink-0 text-xs text-zinc-500">计划</span>
          <span className="shrink-0 text-xs text-zinc-300">
            {plan.steps.filter((s) => s.status === 'done').length}/{plan.steps.length} 完成
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {plan.steps.map((s) => (
              <span
                key={s.index}
                title={s.title}
                className={`max-w-48 truncate rounded-full border px-2 py-0.5 text-[11px] ${
                  s.status === 'done'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : s.status === 'skipped'
                      ? 'border-zinc-700 bg-zinc-800/40 text-zinc-500 line-through'
                      : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'
                }`}
              >
                {s.index}. {s.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 待审批横幅 */}
      {pendingApprovals.length > 0 && (
        <div className="space-y-2 border-b border-amber-500/20 bg-amber-500/5 p-3">
          {pendingApprovals.map((ev) => {
            const d = ev.data as { actionId: string; toolName: string; argsSummary: string; reason: string };
            return (
              <Card key={d.actionId} className="border-amber-500/30 bg-amber-500/5 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm text-amber-200">
                  <span>⏸ 等待审批：{d.toolName}</span>
                </div>
                <div className="mono mb-1 break-all text-xs text-zinc-400">{d.argsSummary}</div>
                <div className="mb-2.5 text-xs text-zinc-500">{d.reason}</div>
                <div className="flex gap-2">
                  <Btn variant="success" onClick={() => onApprove(d.actionId, true)}>
                    批准执行
                  </Btn>
                  <Btn variant="danger" onClick={() => onApprove(d.actionId, false)}>
                    拒绝
                  </Btn>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* 标签页 */}
      <div className="flex gap-1 border-b border-zinc-800 px-4 pt-2">
        <TabBtn k="timeline" tab={tab} setTab={setTab} label="执行时间线" count={events.length} />
        <TabBtn k="files" tab={tab} setTab={setTab} label="文件变更" count={fileChanges.length || fileChangeEvents.length} />
        <TabBtn k="approvals" tab={tab} setTab={setTab} label="权限审批" count={pendingApprovals.length} />
        <TabBtn k="result" tab={tab} setTab={setTab} label="任务结果" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'timeline' && <Timeline events={events} pendingActionIds={pendingIds} />}
        {tab === 'files' && (
          <div className="space-y-2">
            {fileChanges.length > 0 && (
              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                <span className="text-xs text-zinc-500">
                  共 {fileChanges.length} 处文件变更
                  {canRestore ? ' · 回滚将把文件恢复为任务执行前状态（创建的文件会被删除）' : ' · 任务结束后可回滚'}
                </span>
                {canRestore && fileChanges.some((c) => c.restoredAt === null) && (
                  <Btn variant="danger" onClick={onRestoreAll}>
                    ⟲ 回滚全部
                  </Btn>
                )}
              </div>
            )}
            {fileChanges.map((c) => (
              <Card key={c.id} className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="mono truncate text-sm text-zinc-200">{c.path}</div>
                  <div className="text-xs text-zinc-500">
                    {c.kind === 'create'
                      ? '新建文件（回滚将删除）'
                      : c.backupAvailable
                        ? '修改文件（回滚还原原内容）'
                        : '修改文件'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.restoredAt !== null ? (
                    <span className="text-xs text-emerald-300">已回滚</span>
                  ) : canRestore ? (
                    <Btn onClick={() => onRestoreChange(c.id)}>恢复</Btn>
                  ) : null}
                  <span className={`text-xs ${c.kind === 'create' ? 'text-emerald-300' : 'text-sky-300'}`}>
                    {c.kind === 'create' ? 'CREATE' : 'MODIFY'}
                  </span>
                </div>
              </Card>
            ))}
            {fileChanges.length === 0 && (
              <div className="py-10 text-center text-sm text-zinc-600">
                {detail ? '本任务尚未修改任何文件' : '选择任务后查看文件变更'}
              </div>
            )}
          </div>
        )}
        {tab === 'approvals' && (
          <div className="space-y-3">
            {detail?.pendingActions.length ? (
              detail.pendingActions.map((pa) => (
                <Card key={pa.id} className="p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-200">{pa.toolName}</span>
                    <span className="text-xs text-zinc-500">{pa.status}</span>
                  </div>
                  <div className="mono mt-1 break-all text-xs text-zinc-400">{pa.argsSummary}</div>
                  <div className="mt-1 text-xs text-zinc-500">{pa.reason}</div>
                </Card>
              ))
            ) : (
              <div className="py-10 text-center text-sm text-zinc-600">暂无审批记录（默认只有白名单内的测试命令需要审批）</div>
            )}
          </div>
        )}
        {tab === 'result' && (
          <div className="space-y-3">
            {!report && (
              <div className="py-10 text-center text-sm text-zinc-600">
                {detail ? '任务尚未结束' : '选择任务后查看结果'}
              </div>
            )}
            {report && (
              <>
                <Card className="p-4">
                  <StatusBadge status={report.status} />
                  {report.summary && (
                    <div className="mt-3 whitespace-pre-wrap text-sm text-zinc-200">{report.summary}</div>
                  )}
                </Card>
                {report.verification && (
                  <Card className="p-4">
                    <div className="mb-1 text-xs font-medium text-zinc-500">验证说明</div>
                    <div className="whitespace-pre-wrap text-sm text-zinc-300">{report.verification}</div>
                  </Card>
                )}
                {report.blockers && (
                  <Card className="border-amber-500/30 p-4">
                    <div className="mb-1 text-xs font-medium text-amber-400">未完成 / 阻塞</div>
                    <div className="whitespace-pre-wrap text-sm text-amber-200">{report.blockers}</div>
                  </Card>
                )}
                {report.reasons.length > 0 && (
                  <Card className="border-red-500/30 p-4">
                    <div className="mb-1 text-xs font-medium text-red-400">原因</div>
                    {report.reasons.map((r, i) => (
                      <div key={i} className="text-sm text-red-200">• {r}</div>
                    ))}
                  </Card>
                )}
                {report.warnings.length > 0 && (
                  <Card className="border-yellow-500/30 p-4">
                    <div className="mb-1 text-xs font-medium text-yellow-400">复核提示</div>
                    {report.warnings.map((w, i) => (
                      <div key={i} className="text-sm text-yellow-200">• {w}</div>
                    ))}
                  </Card>
                )}
                {detail?.toolCalls.length ? (
                  <Card className="p-4">
                    <div className="mb-2 text-xs font-medium text-zinc-500">工具调用记录</div>
                    <JsonBlock
                      text={JSON.stringify(
                        detail.toolCalls.map((tc) => ({
                          tool: tc.name,
                          status: tc.status,
                          durationMs: tc.durationMs,
                          args: tc.argsSummary,
                          result: tc.resultSummary
                        })),
                        null,
                        2
                      )}
                    />
                  </Card>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TabBtn({
  k,
  tab,
  setTab,
  label,
  count
}: {
  k: TabKey;
  tab: TabKey;
  setTab: (t: TabKey) => void;
  label: string;
  count?: number;
}): ReactNode {
  const activeTab = tab === k;
  return (
    <button
      type="button"
      onClick={() => setTab(k)}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
        activeTab ? 'border-sky-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {label}
      {count != null && count > 0 && (
        <span className="ml-1.5 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{count}</span>
      )}
    </button>
  );
}

export { DiffBlock };
