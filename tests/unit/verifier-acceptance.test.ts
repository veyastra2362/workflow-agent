import { describe, expect, it } from 'vitest';
import { DefaultVerifier } from '../../src/core/verifier';

const v = new DefaultVerifier();

describe('Verifier v2：验收条件程序化判定', () => {
  it('验收标准含"测试"关键词且无成功 run_tests → 不得 completed', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: '检查过代码' },
      toolRecords: [{ name: 'write_file', ok: true }],
      fileChanges: ['a.txt'],
      deniedApprovals: 0,
      acceptance: '所有测试通过且目录结构清晰'
    });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.reasons.join()).toContain('验收标准要求测试通过');
  });

  it('验收标准含 vitest/jest 关键词同样生效', () => {
    for (const acceptance of ['vitest 全部通过', 'jest 测试绿', 'pytest 无失败']) {
      const verdict = v.verify({
        finish: { summary: '完成', verification: 'v' },
        toolRecords: [],
        fileChanges: [],
        deniedApprovals: 0,
        acceptance
      });
      expect(verdict.status).toBe('needs_review');
    }
  });

  it('验收标准要求测试且 run_tests 成功 → completed', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: 'run_tests exit=0' },
      toolRecords: [
        { name: 'write_file', ok: true },
        { name: 'run_tests', ok: true }
      ],
      fileChanges: ['a.txt'],
      deniedApprovals: 0,
      acceptance: 'vitest 全部通过'
    });
    expect(verdict.status).toBe('completed');
  });

  it('验收标准不含测试关键词且未跑测试 → 仍可 completed（保留原行为）', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: '已核对文件内容' },
      toolRecords: [],
      fileChanges: [],
      deniedApprovals: 0,
      acceptance: '把笔记整理成 Markdown'
    });
    expect(verdict.status).toBe('completed');
  });

  it('testsFailed=true（最近一次测试退出码非 0）→ 不得 completed', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: 'v' },
      toolRecords: [{ name: 'run_tests', ok: true }],
      fileChanges: [],
      deniedApprovals: 0,
      testsFailed: true
    });
    expect(verdict.status).toBe('needs_review');
    expect(verdict.reasons.join()).toContain('run_tests 未通过');
  });

  it('未提供验收标准 → 不触发测试要求规则', () => {
    const verdict = v.verify({
      finish: { summary: '完成', verification: 'v' },
      toolRecords: [],
      fileChanges: [],
      deniedApprovals: 0
    });
    expect(verdict.status).toBe('completed');
  });
});
