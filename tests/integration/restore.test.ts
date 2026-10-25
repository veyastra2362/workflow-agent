import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildService,
  makeTempDir,
  TEST_MODEL_CONFIG,
  toolCall,
  toolResponse,
  until
} from '../helpers';

const cleanup: string[] = [];
function ws(): string {
  const dir = makeTempDir('wa-restore-');
  cleanup.push(dir);
  return dir;
}

/** 运行一个产生「新建 c.txt + 修改 b.txt」的任务并结束 */
async function runTaskWithChanges(workspace: string): Promise<ReturnType<typeof buildService>> {
  fs.writeFileSync(path.join(workspace, 'b.txt'), 'original');
  const built = buildService({
    workspace,
    steps: [
      () => toolResponse('', [toolCall('write_file', { path: 'c.txt', content: 'created-by-agent' })]),
      () => toolResponse('', [toolCall('write_file', { path: 'b.txt', content: 'modified-by-agent' })]),
      () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: '已写入' })])
    ]
  });
  const { taskId } = await built.service.startTask({ goal: '产生变更', workspace, modelConfig: TEST_MODEL_CONFIG });
  const report = await built.service.waitForTask(taskId);
  expect(report.status).toBe('completed');
  return built;
}

afterEach(() => {
  while (cleanup.length) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('阶段 3：文件变更回滚', () => {
  it('恢复单条 modify 变更：文件回到修改前内容，其余不受影响', async () => {
    const workspace = ws();
    const built = await runTaskWithChanges(workspace);
    const taskId = built.store.listTasks()[0]!.id;
    const change = built.store.getTask(taskId)!.fileChanges.find((c) => c.path === 'b.txt')!;

    const r = built.service.restoreFileChange(taskId, change.id);
    expect(r).toMatchObject({ restored: true, path: 'b.txt', action: 'reverted' });
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(workspace, 'c.txt'), 'utf8')).toBe('created-by-agent');

    const detail = built.store.getTask(taskId)!;
    expect(detail.fileChanges.find((c) => c.path === 'b.txt')!.restoredAt).not.toBeNull();
    expect(detail.fileChanges.find((c) => c.path === 'c.txt')!.restoredAt).toBeNull();
    expect(detail.events.some((e) => e.type === 'file_restored')).toBe(true);
  });

  it('恢复单条 create 变更：任务创建的文件被删除', async () => {
    const workspace = ws();
    const built = await runTaskWithChanges(workspace);
    const taskId = built.store.listTasks()[0]!.id;
    const change = built.store.getTask(taskId)!.fileChanges.find((c) => c.path === 'c.txt')!;

    const r = built.service.restoreFileChange(taskId, change.id);
    expect(r).toMatchObject({ restored: true, path: 'c.txt', action: 'deleted' });
    expect(fs.existsSync(path.join(workspace, 'c.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('modified-by-agent');
  });

  it('重复恢复同一变更 → noop，不重复写盘', async () => {
    const workspace = ws();
    const built = await runTaskWithChanges(workspace);
    const taskId = built.store.listTasks()[0]!.id;
    const change = built.store.getTask(taskId)!.fileChanges.find((c) => c.path === 'b.txt')!;

    expect(built.service.restoreFileChange(taskId, change.id).restored).toBe(true);
    const again = built.service.restoreFileChange(taskId, change.id);
    expect(again).toMatchObject({ restored: false, action: 'noop' });
  });

  it('回滚全部：每个路径恢复到任务前状态（修改还原、创建删除）', async () => {
    const workspace = ws();
    const built = await runTaskWithChanges(workspace);
    const taskId = built.store.listTasks()[0]!.id;

    const r = built.service.restoreTaskFiles(taskId);
    expect(r.paths.sort()).toEqual(['b.txt', 'c.txt']);
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('original');
    expect(fs.existsSync(path.join(workspace, 'c.txt'))).toBe(false);

    const detail = built.store.getTask(taskId)!;
    expect(detail.fileChanges.every((c) => c.restoredAt !== null)).toBe(true);
    // 再次回滚：没有可处理项
    expect(built.service.restoreTaskFiles(taskId)).toEqual({ paths: [] });
  });

  it('多轮修改同一文件：回滚全部恢复到任务前内容（最早备份优先）', async () => {
    const workspace = ws();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'v0');
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('write_file', { path: 'a.txt', content: 'v1' })]),
        () => toolResponse('', [toolCall('write_file', { path: 'a.txt', content: 'v2' })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '多次修改', workspace, modelConfig: TEST_MODEL_CONFIG });
    await built.service.waitForTask(taskId);
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('v2');

    built.service.restoreTaskFiles(taskId);
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('v0');
  });

  it('任务运行中拒绝回滚（防止与 Agent 写入竞争）', async () => {
    const workspace = ws();
    let release = false;
    const built = buildService({
      workspace,
      steps: [
        async () => {
          await until(() => release, 5000);
          return toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })]);
        }
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '阻塞任务', workspace, modelConfig: TEST_MODEL_CONFIG });
    await until(() => built.store.getTask(taskId)!.status === 'running');

    expect(() => built.service.restoreFileChange(taskId, 1)).toThrow(/不能回滚/);
    expect(() => built.service.restoreTaskFiles(taskId)).toThrow(/不能回滚/);

    built.service.cancelTask(taskId);
    release = true;
    await built.service.waitForTask(taskId);
  });

  it('变更记录不存在的任务/ID → 明确报错', async () => {
    const workspace = ws();
    const built = await runTaskWithChanges(workspace);
    const taskId = built.store.listTasks()[0]!.id;
    expect(() => built.service.restoreFileChange('no-such-task', 1)).toThrow('任务不存在');
    expect(() => built.service.restoreFileChange(taskId, 99999)).toThrow('变更记录不存在');
  });
});
