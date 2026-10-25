import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../src/policy/policy';

describe('Policy：network 风险（联网工具）', () => {
  it('默认自动放行（GET-only 联网）', () => {
    const p = new PolicyEngine({ allowedTestCommands: [], autoApproveTestCommands: false });
    expect(p.decide('web_fetch', 'network', {}).action).toBe('allow');
    expect(p.decide('web_search', 'network', {}).action).toBe('allow');
  });

  it('开启 requireApprovalForWeb 后需要审批', () => {
    const p = new PolicyEngine({
      allowedTestCommands: [],
      autoApproveTestCommands: false,
      requireApprovalForWeb: true
    });
    const d = p.decide('web_fetch', 'network', {});
    expect(d.action).toBe('ask');
    expect(d.reason).toContain('联网');
  });

  it('联网审批开关不影响 read/write/execute 的既有决策', () => {
    const p = new PolicyEngine({
      allowedTestCommands: ['npm test'],
      autoApproveTestCommands: false,
      requireApprovalForWeb: true
    });
    expect(p.decide('read_file', 'read', {}).action).toBe('allow');
    expect(p.decide('write_file', 'write', {}).action).toBe('allow');
    expect(p.decide('run_tests', 'execute', { command: 'npm test' }).action).toBe('ask');
  });
});
