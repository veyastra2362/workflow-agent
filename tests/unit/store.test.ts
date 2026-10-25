import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/db';
import { Store } from '../../src/persistence/store';

describe('Store（SQLite 持久化）', () => {
  it('任务 CRUD 与事件/工具调用/文件变更往返', () => {
    const store = new Store(openDatabase(':memory:'));

    store.createTask({ id: 't1', goal: 'goal-1', acceptance: 'accept-1', workspace: '/tmp/ws' });
    store.updateTaskStatus('t1', 'running');

    const ev1 = store.addEvent('t1', 'task_started', { goal: 'goal-1' });
    const ev2 = store.addEvent('t1', 'tool_call_finished', { ok: true });
    expect(ev1.id).toBeLessThan(ev2.id);
    expect(store.listEvents('t1')).toHaveLength(2);
    expect(store.listEvents('t1')[1]!.data).toEqual({ ok: true });

    store.addToolCall({
      id: 'c1',
      taskId: 't1',
      name: 'write_file',
      argsSummary: '{"path":"a.txt"}',
      status: 'ok',
      durationMs: 12,
      resultSummary: '创建 a.txt'
    });
    expect(store.listToolCalls('t1')[0]!.name).toBe('write_file');

    store.addPendingAction({ id: 'p1', taskId: 't1', toolName: 'run_tests', argsSummary: 'npm test', reason: '需要确认' });
    expect(store.getPendingAction('p1')?.status).toBe('pending');
    store.resolvePendingAction('p1', 'approved');
    expect(store.getPendingAction('p1')?.status).toBe('approved');

    const fc = store.addFileChange({ taskId: 't1', path: 'a.txt', kind: 'modify', backupContent: 'old' });
    expect(fc.backupAvailable).toBe(true);
    expect(store.listFileChanges('t1')).toHaveLength(1);
    expect(store.getFileChangeBackup(fc.id)?.backupContent).toBe('old');

    store.saveTranscript('t1', JSON.stringify([{ role: 'system', content: 's' }]));
    store.finishTask('t1', { status: 'completed', summary: 'done', report: { status: 'completed', reasons: [], warnings: [] } });

    const task = store.getTask('t1')!;
    expect(task.status).toBe('completed');
    expect(task.summary).toBe('done');
    expect(task.report).toEqual({ status: 'completed', reasons: [], warnings: [] });
    expect(JSON.parse(task.transcriptJson!)).toHaveLength(1);
    expect(task.events).toHaveLength(2);
    expect(task.toolCalls).toHaveLength(1);
    expect(task.fileChanges).toHaveLength(1);
    expect(task.pendingActions).toHaveLength(1);

    expect(store.listTasks()[0]!.goal).toBe('goal-1');
    expect(store.findUnfinishedTasks()).toHaveLength(0);
  });

  it('未完成任务可被 findUnfinishedTasks 找到（崩溃恢复依据）', () => {
    const store = new Store(openDatabase(':memory:'));
    store.createTask({ id: 't2', goal: 'g', workspace: '/tmp' });
    store.updateTaskStatus('t2', 'waiting_approval');
    store.createTask({ id: 't3', goal: 'g2', workspace: '/tmp' });
    store.updateTaskStatus('t3', 'completed');
    const unfinished = store.findUnfinishedTasks();
    expect(unfinished.map((t) => t.id)).toContain('t2');
    expect(unfinished.map((t) => t.id)).not.toContain('t3');
  });

  it('getTask 对不存在的 id 返回 null', () => {
    const store = new Store(openDatabase(':memory:'));
    expect(store.getTask('nope')).toBeNull();
  });
});
