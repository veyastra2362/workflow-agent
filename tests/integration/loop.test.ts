import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildService,
  makeTempDir,
  startAndWait,
  textResponse,
  toolCall,
  toolResponse,
  until,
  TEST_MODEL_CONFIG
} from '../helpers';

const cleanup: string[] = [];
function ws(): string {
  const dir = makeTempDir('wa-int-');
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Agent Loop 集成（真实工具 + 脚本化模型）', () => {
  it('完整流程：计划 → 写文件 → complete_task → 验收通过', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('submit_plan', { steps: ['创建文件', '提交汇报'] })]),
        () => toolResponse('开始创建', [toolCall('write_file', { path: 'hello.txt', content: 'hi from agent' })]),
        () =>
          toolResponse('', [
            toolCall('complete_task', {
              summary: '已创建 hello.txt',
              verification: 'write_file 返回 ok'
            })
          ])
      ]
    });
    const { taskId, report } = await startAndWait(built);

    expect(report.status).toBe('completed');
    expect(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8')).toBe('hi from agent');

    const detail = built.store.getTask(taskId)!;
    const types = detail.events.map((e) => e.type);
    expect(types).toContain('plan_submitted');
    expect(types).toContain('tool_call_started');
    expect(types).toContain('tool_call_finished');
    expect(types).toContain('file_changed');
    expect(types).toContain('task_finished');

    // transcript 与工具调用记录已持久化
    const transcript = JSON.parse(detail.transcriptJson!) as unknown[];
    expect(transcript.length).toBeGreaterThanOrEqual(6);
    expect(detail.toolCalls.map((c) => c.name)).toContain('write_file');
    // transcript 中工具结果与调用一一对应
    const toolMsgs = transcript.filter((m) => (m as { role: string }).role === 'tool');
    expect(toolMsgs.length).toBe(3); // submit_plan + write_file + complete_task
  });

  it('工具失败时结构化错误回传模型，模型可继续完成任务', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('read_file', { path: 'missing.txt' })]),
        (req) => {
          // 第二步验证模型收到了结构化错误
          const toolMsg = req.messages.find((m) => m.role === 'tool');
          expect(toolMsg).toBeTruthy();
          expect(toolMsg!.content).toContain('"ok":false');
          expect(toolMsg!.content).toContain('文件不存在');
          return toolResponse('', [
            toolCall('write_file', { path: 'recovered.txt', content: 'ok' }),
            toolCall('complete_task', { summary: '失败后改用写入', verification: 'write_file ok' })
          ]);
        }
      ]
    });
    const { report } = await startAndWait(built);
    expect(report.status).toBe('completed');
    expect(fs.existsSync(path.join(workspace, 'recovered.txt'))).toBe(true);
    // 报告中包含失败警告
    expect(report.warnings.join()).toContain('工具调用以错误结束');
  });

  it('达到最大决策步数后安全停止（failed）', async () => {
    const workspace = ws();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    const built = buildService({
      workspace,
      settings: { maxSteps: 4 },
      steps: [() => toolResponse('', [toolCall('read_file', { path: 'a.txt' })])]
    });
    const { report } = await startAndWait(built);
    expect(report.status).toBe('failed');
    expect(report.reasons.join()).toContain('最大决策次数');
  });

  it('用户取消后不再启动新的工具执行', async () => {
    const workspace = ws();
    // 第二步阻塞等待测试发出"已取消"信号，确保取消发生在模型调用等待期间
    let release = false;
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('write_file', { path: 'first.txt', content: '1' })]),
        async () => {
          await until(() => release, 5000);
          return toolResponse('', [toolCall('write_file', { path: 'second.txt', content: '2' })]);
        }
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: 'cancel-test',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    // 等第一个工具执行完成，立刻取消，再放行模型第二步
    await until(() => {
      const t = built.store.getTask(taskId)!;
      return t.toolCalls.some((c) => c.name === 'write_file');
    });
    built.service.cancelTask(taskId);
    release = true;
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('cancelled');

    // 第二个文件绝不能被写入
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(path.join(workspace, 'second.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, 'first.txt'), 'utf8')).toBe('1');
  });

  it('审批流程：run_tests 需要用户批准，批准后执行', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(0)'] })]),
        () =>
          toolResponse('', [
            toolCall('complete_task', { summary: '测试通过', verification: 'run_tests exit=0' })
          ])
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: 'approval-test',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    const reqEvent = await until(() =>
      built.events.find((e) => e.type === 'approval_required')
    );
    const actionId = String((reqEvent.data as { actionId: string }).actionId);
    const t1 = built.store.getTask(taskId)!;
    expect(t1.status).toBe('waiting_approval');
    expect(built.service.resolveApproval(actionId, true)).toBe(true);
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('completed');
    expect(built.store.listToolCalls(taskId).some((c) => c.name === 'run_tests' && c.status === 'ok')).toBe(true);
  });

  it('审批被拒绝时模型收到 DENIED_BY_USER，任务进入需复核', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('run_tests', { command: 'node', args: ['-e', 'process.exit(1)'] })]),
        (req) => {
          const toolMsg = req.messages.find((m) => m.role === 'tool');
          expect(toolMsg!.content).toContain('DENIED_BY_USER');
          return toolResponse('', [
            toolCall('complete_task', { summary: '无法验证', verification: '用户拒绝执行测试', blockers: '测试被拒绝' })
          ]);
        }
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: 'deny-test',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    const reqEvent = await until(() => built.events.find((e) => e.type === 'approval_required'));
    built.service.resolveApproval(String((reqEvent.data as { actionId: string }).actionId), false);
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('needs_review');
    expect(report.blockers).toContain('测试被拒绝');
  });

  it('白名单外命令被策略直接拒绝（不产生审批请求）', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('run_tests', { command: 'rm -rf /' })]),
        (req) => {
          const toolMsg = req.messages.find((m) => m.role === 'tool');
          expect(toolMsg!.content).toContain('POLICY_DENIED');
          return toolResponse('', [
            toolCall('complete_task', { summary: '命令被拒绝', verification: 'n/a' })
          ]);
        }
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: 'policy-test',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    await built.service.waitForTask(taskId);
    // 从未出现审批请求
    expect(built.events.some((e) => e.type === 'approval_required')).toBe(false);
    const finished = built.events.find((e) => e.type === 'tool_call_finished')!;
    expect((finished.data as { ok: boolean }).ok).toBe(false);
  });

  it('模型只输出文本不收尾 → 两次提醒后进入 needs_review', async () => {
    const workspace = ws();
    const built = buildService({ workspace, steps: [() => textResponse('让我想想……')] });
    const { report } = await startAndWait(built);
    expect(report.status).toBe('needs_review');
    expect(report.reasons.join()).toContain('未调用 complete_task');
    // 提醒消息确实进入 transcript
    const finishedTask = built.store.listTasks()[0]!;
    const transcript = JSON.parse(built.store.getTask(finishedTask.id)!.transcriptJson!) as Array<{ content: string | null }>;
    expect(transcript.filter((m) => m.content?.includes('complete_task 提交总结')).length).toBe(2);
  });

  it('重复调用相同工具与参数超过上限 → 强制停止', async () => {
    const workspace = ws();
    fs.writeFileSync(path.join(workspace, 'same.txt'), 'x');
    const built = buildService({
      workspace,
      steps: [() => toolResponse('', [toolCall('read_file', { path: 'same.txt' })])]
    });
    const { report } = await startAndWait(built);
    expect(report.status).toBe('needs_review');
    expect(report.reasons.join()).toContain('重复调用');
    // 警告注入过一次
    const task = built.store.listTasks()[0]!;
    const transcript = JSON.parse(built.store.getTask(task.id)!.transcriptJson!) as Array<{ content: string | null }>;
    expect(transcript.some((m) => m.content?.includes('已重复 3 次'))).toBe(true);
  });

  it('模型 API 持续失败 → 任务失败且错误上报', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }
      ]
    });
    // ScriptedGateway 抛出的是普通 Error → gateway 层应包装；此处直接验证 loop 处理
    const { report } = await startAndWait(built);
    expect(report.status).toBe('failed');
    expect(report.reasons.join()).toContain('模型调用失败');
  });

  it('崩溃恢复：interrupted 任务可恢复并继续完成', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () =>
          toolResponse('', [
            toolCall('complete_task', { summary: '恢复后完成', verification: '已验证' })
          ])
      ]
    });
    // 手工构造一个上次中断的任务（带已保存 transcript）
    built.store.createTask({ id: 't-interrupted', goal: '恢复测试', workspace });
    built.store.updateTaskStatus('t-interrupted', 'running');
    built.store.saveTranscript(
      't-interrupted',
      JSON.stringify([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '任务目标：恢复测试' },
        { role: 'assistant', content: '我完成了前半部分' }
      ])
    );
    expect(built.service.recoverOnStartup()).toBe(1);
    expect(built.store.getTask('t-interrupted')!.status).toBe('interrupted');

    await built.service.resumeTask('t-interrupted', TEST_MODEL_CONFIG);
    const report = await built.service.waitForTask('t-interrupted');
    expect(report.status).toBe('completed');
    // 恢复说明注入了 transcript
    const transcript = JSON.parse(built.store.getTask('t-interrupted')!.transcriptJson!) as Array<{ content: string | null }>;
    expect(transcript.some((m) => m.content?.includes('中断'))).toBe(true);
  });
});
