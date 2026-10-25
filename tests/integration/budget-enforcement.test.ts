import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ModelError } from '../../src/gateway/types';
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
  const dir = makeTempDir('wa-budget-');
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanup.length) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('阶段 4.1：预算程序强制执行', () => {
  it('taskTimeoutMs 实际中止挂起的模型调用（timer + abort，而非仅记录状态）', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { taskTimeoutMs: 1200 },
      steps: [
        // 模拟真实网关：挂起直到 abort 信号触发，然后抛 MODEL_ABORTED
        async (_req, signal) => {
          if (!signal) throw new Error('测试需要 signal');
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          throw new ModelError('MODEL_ABORTED', '请求已被取消');
        }
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: '挂起任务',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    const startedAt = Date.now();
    const report = await built.service.waitForTask(taskId);
    const elapsed = Date.now() - startedAt;

    expect(report.status).toBe('failed');
    expect(report.reasons.join()).toContain('已强制中止');
    // 若 timer 未实际中止，任务会永久挂起或等到测试超时
    expect(elapsed).toBeLessThan(8000);
  }, 15_000);

  it('taskTimeoutMs 实际终止执行中的长测试进程（进程树被杀）', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { taskTimeoutMs: 2000, autoApproveTestCommands: true },
      steps: [
        () =>
          toolResponse('', [
            toolCall('run_tests', { command: 'node', args: ['-e', 'setTimeout(() => {}, 20000)'] })
          ]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: '长测试任务',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    const startedAt = Date.now();
    const report = await built.service.waitForTask(taskId);
    const elapsed = Date.now() - startedAt;

    expect(report.status).toBe('failed');
    expect(report.reasons.join()).toContain('已强制中止');
    // 子进程 sleep 20s；若未被杀掉，任务会阻塞到工具超时（数百秒）。
    // 在数秒内结束即证明进程树被实际终止。
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it('模板约束与全局预算取更严格值：模板 30 / 全局 3 → 实际 3 步停止', async () => {
    const workspace = ws();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    const built = buildService({
      workspace,
      settings: { maxSteps: 3 },
      steps: [() => toolResponse('', [toolCall('read_file', { path: 'a.txt' })])]
    });
    const { taskId } = await built.service.startTask({
      goal: '收紧预算',
      workspace,
      modelConfig: TEST_MODEL_CONFIG,
      constraints: { maxSteps: 30 } // 模板试图放宽 → 必须被全局 3 收紧
    });
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('failed');
    expect(report.reasons.join()).toContain('最大决策次数（3）');
    expect(built.store.listToolCalls(taskId)).toHaveLength(3);
  });

  it('模板约束收紧生效：模板 2 / 全局 25 → 实际 2 步停止', async () => {
    const workspace = ws();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    const built = buildService({
      workspace,
      steps: [() => toolResponse('', [toolCall('read_file', { path: 'a.txt' })])]
    });
    const { taskId } = await built.service.startTask({
      goal: '模板收紧',
      workspace,
      modelConfig: TEST_MODEL_CONFIG,
      constraints: { maxSteps: 2 }
    });
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('failed');
    expect(report.reasons.join()).toContain('最大决策次数（2）');
    expect(built.store.listToolCalls(taskId)).toHaveLength(2);
  });

  it('超时等待审批的任务也会被解除等待并终止', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { taskTimeoutMs: 1200 },
      steps: [
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: [] })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: '审批挂起',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    await until(() => built.events.find((e) => e.type === 'approval_required'));
    // 不做任何审批：等待任务超时把审批等待一并解除
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('failed');
    expect(report.reasons.join()).toContain('已强制中止');
    // 审批横幅被清除（approval_resolved 已发出）
    expect(built.events.some((e) => e.type === 'approval_resolved')).toBe(true);
  }, 15_000);
});
