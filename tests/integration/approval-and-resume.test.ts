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
  const dir = makeTempDir('wa-appr-');
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanup.length) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('阶段 3：写入审批开关', () => {
  it('开启后 write_file 需要用户批准，批准后执行', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { requireApprovalForWrites: true },
      steps: [
        () => toolResponse('', [toolCall('write_file', { path: 'a.txt', content: 'approved' })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: '写入成功' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '写入审批', workspace, modelConfig: TEST_MODEL_CONFIG });

    const req = await until(() => built.events.find((e) => e.type === 'approval_required'));
    expect(String((req.data as { toolName: string }).toolName)).toBe('write_file');
    expect(built.store.getTask(taskId)!.status).toBe('waiting_approval');
    expect(built.service.resolveApproval(String((req.data as { actionId: string }).actionId), true)).toBe(true);

    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('completed');
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('approved');
    // 审批记录留痕
    expect(built.store.getTask(taskId)!.pendingActions[0]!.status).toBe('approved');
  });

  it('拒绝后模型收到 DENIED_BY_USER，文件未被写入', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      settings: { requireApprovalForWrites: true },
      steps: [
        () => toolResponse('', [toolCall('write_file', { path: 'a.txt', content: 'x' })]),
        (req) => {
          const toolMsg = req.messages.find((m) => m.role === 'tool');
          expect(toolMsg!.content).toContain('DENIED_BY_USER');
          return toolResponse('', [toolCall('complete_task', { summary: '写入被拒', verification: '改用汇报' })]);
        }
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '拒绝写入', workspace, modelConfig: TEST_MODEL_CONFIG });

    const req = await until(() => built.events.find((e) => e.type === 'approval_required'));
    built.service.resolveApproval(String((req.data as { actionId: string }).actionId), false);

    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('completed');
    expect(report.warnings.join()).toContain('被用户拒绝');
    expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(false);
  });

  it('默认关闭：写入自动放行（对照）', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('write_file', { path: 'a.txt', content: 'free' })]),
        () => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])
      ]
    });
    const { taskId } = await built.service.startTask({ goal: '默认写入', workspace, modelConfig: TEST_MODEL_CONFIG });
    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('completed');
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('free');
    expect(built.events.some((e) => e.type === 'approval_required')).toBe(false);
  });
});

describe('阶段 3：恢复任务的副作用防护', () => {
  it('恢复时注入此前已修改文件清单，避免盲目重复写入', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [
        () => toolResponse('', [toolCall('complete_task', { summary: '恢复完成', verification: 'v' })])
      ]
    });
    // 构造一个中断任务：已有 transcript 与已写入磁盘的文件变更
    built.store.createTask({ id: 't-resume', goal: '恢复测试', workspace });
    built.store.updateTaskStatus('t-resume', 'running');
    built.store.saveTranscript(
      't-resume',
      JSON.stringify([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '任务目标：恢复测试' },
        { role: 'assistant', content: '已修改 a.txt' }
      ])
    );
    built.store.addFileChange({ taskId: 't-resume', path: 'a.txt', kind: 'modify', backupContent: 'old' });
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'modified-before-crash');
    built.service.recoverOnStartup();

    await built.service.resumeTask('t-resume', TEST_MODEL_CONFIG);
    const report = await built.service.waitForTask('t-resume');
    expect(report.status).toBe('completed');

    const transcript = JSON.parse(built.store.getTask('t-resume')!.transcriptJson!) as Array<{
      role: string;
      content: string | null;
    }>;
    const note = transcript.find((m) => m.content?.includes('此前已实际修改以下文件'));
    expect(note).toBeTruthy();
    expect(note!.content).toContain('a.txt');
  });

  it('无文件变更的恢复任务不注入清单（对照）', async () => {
    const workspace = ws();
    const built = buildService({
      workspace,
      steps: [() => toolResponse('', [toolCall('complete_task', { summary: '完成', verification: 'v' })])]
    });
    built.store.createTask({ id: 't-clean', goal: '干净恢复', workspace });
    built.store.updateTaskStatus('t-clean', 'running');
    built.store.saveTranscript(
      't-clean',
      JSON.stringify([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '任务目标：干净恢复' }
      ])
    );
    built.service.recoverOnStartup();
    await built.service.resumeTask('t-clean', TEST_MODEL_CONFIG);
    await built.service.waitForTask('t-clean');
    const transcript = JSON.parse(built.store.getTask('t-clean')!.transcriptJson!) as Array<{
      content: string | null;
    }>;
    expect(transcript.some((m) => m.content?.includes('此前已实际修改以下文件'))).toBe(false);
  });
});
