import { describe, expect, it } from 'vitest';
import { buildContextView } from '../../src/core/context';
import { DefaultVerifier } from '../../src/core/verifier';
import type { ChatMessage } from '../../src/gateway/types';

describe('buildContextView：上下文窗口控制', () => {
  it('小上下文全部保留', () => {
    const transcript: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'a' }
    ];
    const view = buildContextView(transcript, 10_000);
    expect(view.messages).toHaveLength(3);
    expect(view.droppedCount).toBe(0);
  });

  it('超预算时丢弃最旧的中间消息并插入摘要占位', () => {
    const transcript: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task-message-that-must-stay' },
      { role: 'assistant', content: 'x'.repeat(500) },
      { role: 'tool', tool_call_id: 'c1', content: 'y'.repeat(500) },
      { role: 'assistant', content: 'z'.repeat(500) },
      { role: 'assistant', content: '最新消息' }
    ];
    const view = buildContextView(transcript, 1100);
    expect(view.droppedCount).toBeGreaterThan(0);
    const contents = view.messages.map((m) => m.content ?? '');
    expect(contents[0]).toBe('sys');
    expect(contents[1]).toBe('task-message-that-must-stay');
    expect(contents[2]).toContain('已折叠');
    expect(contents[contents.length - 1]).toBe('最新消息');
  });

  it('始终保留最新一条消息', () => {
    const transcript: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 't' },
      { role: 'assistant', content: 'x'.repeat(900) },
      { role: 'assistant', content: 'y'.repeat(900) }
    ];
    const view = buildContextView(transcript, 950);
    expect(view.messages[view.messages.length - 1]!.content).toContain('yyy');
  });
});

describe('DefaultVerifier：验收裁决', () => {
  const v = new DefaultVerifier();

  it('未提交完成汇报 → failed', () => {
    const verdict = v.verify({ finish: null, toolRecords: [], fileChanges: [], deniedApprovals: 0, endReason: '超时' });
    expect(verdict.status).toBe('failed');
    expect(verdict.reasons.join()).toContain('未调用 complete_task');
  });

  it('正常提交且无问题 → completed', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: '运行了测试并通过' },
      toolRecords: [{ name: 'write_file', ok: true }],
      fileChanges: ['a.txt'],
      deniedApprovals: 0
    });
    expect(verdict.status).toBe('completed');
    expect(verdict.warnings.join()).toContain('未执行 run_tests');
  });

  it('报告阻塞 → needs_review', () => {
    const verdict = v.verify({
      finish: { summary: '部分完成', verification: '检查过', blockers: '缺少依赖' },
      toolRecords: [],
      fileChanges: [],
      deniedApprovals: 0
    });
    expect(verdict.status).toBe('needs_review');
  });

  it('测试失败 → 不得判为 completed', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: '已验证' },
      toolRecords: [
        { name: 'write_file', ok: true },
        { name: 'run_tests', ok: false }
      ],
      fileChanges: ['a.txt'],
      deniedApprovals: 0
    });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.reasons.join()).toContain('run_tests');
  });

  it('缺少验证说明 → 警告', () => {
    const verdict = v.verify({
      finish: { summary: '完成' },
      toolRecords: [],
      fileChanges: [],
      deniedApprovals: 0
    });
    expect(verdict.status).toBe('completed');
    expect(verdict.warnings.join()).toContain('验证说明');
  });

  it('用户拒绝操作 → 警告', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: 'v' },
      toolRecords: [],
      fileChanges: [],
      deniedApprovals: 2
    });
    expect(verdict.warnings.join()).toContain('2 项操作被用户拒绝');
  });
});
