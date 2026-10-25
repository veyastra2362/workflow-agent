import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PlanStep } from '../../src/shared/types';
import {
  buildService,
  makeTempDir,
  TEST_MODEL_CONFIG,
  toolCall,
  toolResponse
} from '../helpers';

const cleanup: string[] = [];
function ws(): string {
  const dir = makeTempDir('wa-p2-');
  cleanup.push(dir);
  return dir;
}

function transcriptOf(built: { store: ReturnType<typeof buildService>['store'] }, taskId: string): Array<{ role: string; content: string | null; tool_call_id?: string }> {
  return JSON.parse(built.store.getTask(taskId)!.transcriptJson!) as never;
}

afterEach(() => {
  while (cleanup.length) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('阶段 2：计划步骤跟踪', () => {
  it('submit_plan → update_plan 状态持久化并广播事件', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('submit_plan', { steps: ['创建文件', '验证结果'] })]),
        () => toolResponse('', [toolCall('write_file', { path: 'a.txt', content: 'x' })]),
        () => toolResponse('', [toolCall('update_plan', { step_updates: [{ index: 1, status: 'done' }] })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: '已验证' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '计划测试', workspace, modelConfig: TEST_MODEL_CONFIG });
    const finalReport = await built.service.waitForTask(taskId);
    expect(finalReport.status).toBe('completed');

    const detail = built.store.getTask(taskId)!;
    const plan = JSON.parse(detail.planJson!) as { steps: PlanStep[] };
    expect(plan.steps).toEqual([
      { index: 1, title: '创建文件', status: 'done' },
      { index: 2, title: '验证结果', status: 'pending' }
    ]);
    const types = detail.events.map((e) => e.type);
    expect(types).toContain('plan_submitted');
    expect(types).toContain('plan_updated');
  });

  it('update_plan 索引越界 → 结构化错误回传，计划不变', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('submit_plan', { steps: ['步骤一', '步骤二'] })]),
        () => toolResponse('', [toolCall('update_plan', { step_updates: [{ index: 5, status: 'done' }] })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '越界测试', workspace, modelConfig: TEST_MODEL_CONFIG });
    await built.service.waitForTask(taskId);

    const msgs = transcriptOf(built, taskId);
    const updateMsg = msgs.find((m) => m.role === 'tool' && m.content?.includes('INVALID_PLAN_UPDATE'));
    expect(updateMsg).toBeTruthy();
    expect(updateMsg!.content).toContain('步骤索引 5 不存在');

    const plan = JSON.parse(built.store.getTask(taskId)!.planJson!) as { steps: PlanStep[] };
    expect(plan.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
  });

  it('未提交计划直接 update_plan → NO_PLAN 错误', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('update_plan', { step_updates: [{ index: 1, status: 'done' }] })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '无计划测试', workspace, modelConfig: TEST_MODEL_CONFIG });
    await built.service.waitForTask(taskId);
    const msgs = transcriptOf(built, taskId);
    expect(msgs.some((m) => m.role === 'tool' && m.content?.includes('NO_PLAN'))).toBe(true);
  });
});

describe('阶段 2：测试失败修复闭环', () => {
  it('run_tests 失败 → 注入修复指令 → 修复后重跑通过 → completed', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { autoApproveTestCommands: true },
      steps: [
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(1)'] })]),
        () => toolResponse('', [toolCall('write_file', { path: 'fix.txt', content: '修复内容' })]),
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(0)'] })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '修复并验证', verification: 'run_tests exit=0' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '修复测试', workspace, modelConfig: TEST_MODEL_CONFIG });
    const report = await built.service.waitForTask(taskId);

    expect(report.status).toBe('completed');
    // 修复指令确实注入
    const msgs = transcriptOf(built, taskId);
    expect(msgs.some((m) => m.role === 'user' && m.content?.includes('测试未通过'))).toBe(true);
    // 两次 run_tests 都有记录
    const runTestsCalls = built.store.listToolCalls(taskId).filter((c) => c.name === 'run_tests');
    expect(runTestsCalls).toHaveLength(2);
    expect(fs.existsSync(path.join(workspace, 'fix.txt'))).toBe(true);
  });

  it('测试连续失败达到修复轮次上限 → needs_review 安全停止', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { autoApproveTestCommands: true },
      steps: [
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(1)'] })]),
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(2)'] })]),
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(3)'] })]),
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(4)'] })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '轮次上限', workspace, modelConfig: TEST_MODEL_CONFIG });
    const report = await built.service.waitForTask(taskId);

    expect(report.status).toBe('needs_review');
    expect(report.reasons.join()).toContain('修复轮次已达上限');
    const runTestsCalls = built.store.listToolCalls(taskId).filter((c) => c.name === 'run_tests');
    expect(runTestsCalls).toHaveLength(4);
  });

  it('测试未通过时 complete_task 被程序拒绝（TESTS_NOT_PASSING）', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { autoApproveTestCommands: true },
      steps: [
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(1)'] })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '我完成了', verification: '自认为完成' })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '我完成了', verification: '自认为完成' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '门控测试', workspace, modelConfig: TEST_MODEL_CONFIG });
    const report = await built.service.waitForTask(taskId);

    // 第一次 complete_task 被拒；第二次放行后由 Verifier 裁决为 needs_review（测试未通过）
    const msgs = transcriptOf(built, taskId);
    const gated = msgs.filter((m) => m.role === 'tool' && m.content?.includes('TESTS_NOT_PASSING'));
    expect(gated).toHaveLength(1);
    expect(report.status).toBe('needs_review');
    expect(report.reasons.join()).toContain('run_tests 未通过');
  });

  it('验收标准要求测试但模型未跑测试 → needs_review', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('write_file', { path: 'a.txt', content: 'x' })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: '已写入文件' })])
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: '验收测试',
      acceptance: 'vitest 全部测试通过',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('needs_review');
    expect(report.reasons.join()).toContain('验收标准要求测试通过');
  });
});

describe('阶段 2：连续失败防护', () => {
  it('连续 6 次工具失败（不同参数）→ needs_review 安全停止', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [1, 2, 3, 4, 5, 6, 7].map((i) => () =>
        toolResponse('', [toolCall('read_file', { path: `missing-${i}.txt` })])
      )
    });
    const { taskId } = await built.service.startTask({ goal: '连续失败', workspace, modelConfig: TEST_MODEL_CONFIG });
    const report = await built.service.waitForTask(taskId);

    expect(report.status).toBe('needs_review');
    expect(report.reasons.join()).toContain('连续 6 次');
    // 第 6 次失败即停止，第 7 步未执行
    const reads = built.store.listToolCalls(taskId).filter((c) => c.name === 'read_file');
    expect(reads).toHaveLength(6);
    // 第 4 次失败时注入过警告
    const msgs = transcriptOf(built, taskId);
    expect(msgs.some((m) => m.role === 'user' && m.content?.includes('已连续 4 次工具调用失败'))).toBe(true);
  });

  it('失败后成功会重置连续计数', async () => {
    const workspace = ws();
    fs.writeFileSync(path.join(workspace, 'ok.txt'), '内容');
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('read_file', { path: 'missing-1.txt' })]),
        () => toolResponse('', [toolCall('read_file', { path: 'missing-2.txt' })]),
        () => toolResponse('', [toolCall('read_file', { path: 'ok.txt' })]),
        () => toolResponse('', [toolCall('read_file', { path: 'missing-3.txt' })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: '读过 ok.txt' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '计数重置', workspace, modelConfig: TEST_MODEL_CONFIG });
    const report = await built.service.waitForTask(taskId);
    // 2 次失败 + 1 次成功 + 1 次失败 = 未达停止阈值，任务正常走完
    expect(report.status).toBe('completed');
  });
});
