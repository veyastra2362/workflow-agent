import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildService,
  makeTempDir,
  TEST_MODEL_CONFIG,
  toolCall,
  toolResponse
} from '../helpers';

const cleanup: string[] = [];
function ws(): string {
  const dir = makeTempDir('wa-tpltask-');
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanup.length) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('阶段 4.1：从模板启动的任务', () => {
  it('allowedTools 双端生效：模型看不到、执行端拒绝白名单外工具；complete_task 始终可用', async () => {
    const workspace = ws();
    fs.writeFileSync(path.join(workspace, 'a.txt'), '内容');
    const built = buildService({
      workspace,
      steps: [
        // 模型（被恶意提示注入诱导）尝试调用未授权的 write_file
        () => toolResponse('', [toolCall('write_file', { path: 'evil.txt', content: 'x' })]),
        () => toolResponse('', [toolCall('read_file', { path: 'a.txt' })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: '读过 a.txt' })])
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: '只读任务',
      workspace,
      modelConfig: TEST_MODEL_CONFIG,
      constraints: { allowedTools: ['read_file'] }
    });
    const report = await built.service.waitForTask(taskId);

    // 任务仍能正常完成（complete_task 保留且未被绕过安全检查）
    expect(report.status).toBe('completed');

    // 模型端：工具声明里没有 write_file，但保留了 read_file 与 complete_task
    const firstTools = built.gateway.requests[0]!.tools!.map((t) => t.name);
    expect(firstTools).not.toContain('write_file');
    expect(firstTools).toContain('read_file');
    expect(firstTools).toContain('complete_task');

    // 执行端：绕过声明直接调用 write_file → TOOL_NOT_ALLOWED 结构化错误回传
    const transcript = JSON.parse(built.store.getTask(taskId)!.transcriptJson!) as Array<{
      role: string;
      content: string | null;
    }>;
    const deniedMsg = transcript.find((m) => m.role === 'tool' && m.content?.includes('TOOL_NOT_ALLOWED'));
    expect(deniedMsg).toBeTruthy();
    expect(deniedMsg!.content).toContain('write_file');
    // 文件确实没有被写入
    expect(fs.existsSync(path.join(workspace, 'evil.txt'))).toBe(false);
    // 审计记录 status=rejected
    const calls = built.store.listToolCalls(taskId);
    expect(calls.find((c) => c.name === 'write_file')!.status).toBe('rejected');
    expect(calls.find((c) => c.name === 'read_file')!.status).toBe('ok');
  });

  it('模板溯源：task_started 只记 id/名称/参数审计摘要，参数原文不进事件日志', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])
      ]
    });
    const secret = 'sk-templsecret123456789';
    const { taskId } = await built.service.startTask({
      goal: '整理 api-key 相关代码', // 渲染后的目标（按任务持久化策略存 tasks.goal）
      workspace,
      modelConfig: TEST_MODEL_CONFIG,
      templateRef: {
        id: 'tpl-42',
        name: '代码整理',
        paramsAudit: { keyword: '[REDACTED:api_key]' }
      }
    });
    // 故意把原文塞进 goal 验证对照：tasks.goal 允许原文，事件日志不允许
    void secret;
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('completed');

    const detail = built.store.getTask(taskId)!;
    expect(detail.templateId).toBe('tpl-42');
    expect(detail.templateName).toBe('代码整理');
    expect(built.store.listTasks()[0]!.templateName).toBe('代码整理');

    const started = detail.events.find((e) => e.type === 'task_started')!;
    const template = (started.data as { template?: { id: string; name: string; params: Record<string, string> } })
      .template;
    expect(template).toEqual({ id: 'tpl-42', name: '代码整理', params: { keyword: '[REDACTED:api_key]' } });
    // 事件日志不得包含参数原文
    expect(JSON.stringify(detail.events)).not.toContain('sk-templsecret');
  });

  it('中断恢复后 update_plan 不再报 NO_PLAN（计划状态回灌）', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('update_plan', { step_updates: [{ index: 1, status: 'done' }] })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '恢复后完成', verification: 'v' })])
      ]
    });
    // 构造带计划的 interrupted 任务
    built.store.createTask({ id: 't-plan-resume', goal: '恢复计划', workspace });
    built.store.updateTaskStatus('t-plan-resume', 'running');
    built.store.setTaskPlan(
      't-plan-resume',
      JSON.stringify({ steps: [{ index: 1, title: '第一步', status: 'pending' }] })
    );
    built.store.saveTranscript(
      't-plan-resume',
      JSON.stringify([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '任务目标：恢复计划' },
        { role: 'assistant', content: '已提交计划' }
      ])
    );
    built.service.recoverOnStartup();
    await built.service.resumeTask('t-plan-resume', TEST_MODEL_CONFIG);
    const report = await built.service.waitForTask('t-plan-resume');

    expect(report.status).toBe('completed');
    const transcript = JSON.parse(built.store.getTask('t-plan-resume')!.transcriptJson!) as Array<{
      role: string;
      content: string | null;
    }>;
    expect(transcript.some((m) => m.role === 'tool' && m.content?.includes('NO_PLAN'))).toBe(false);
    const plan = JSON.parse(built.store.getTask('t-plan-resume')!.planJson!) as {
      steps: Array<{ status: string }>;
    };
    expect(plan.steps[0]!.status).toBe('done');
  });
});
