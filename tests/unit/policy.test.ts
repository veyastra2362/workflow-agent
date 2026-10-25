import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../src/policy/policy';
import { redactSecrets, redactValue, redactJson } from '../../src/policy/redact';

describe('PolicyEngine：审批决策', () => {
  it('只读工具自动放行', () => {
    const p = new PolicyEngine({ allowedTestCommands: [], autoApproveTestCommands: false });
    expect(p.decide('read_file', 'read', {}).action).toBe('allow');
    expect(p.decide('list_files', 'read', {}).action).toBe('allow');
  });

  it('写入工具自动放行（工作区内由路径检查强制约束）', () => {
    const p = new PolicyEngine({ allowedTestCommands: [], autoApproveTestCommands: false });
    expect(p.decide('write_file', 'write', {}).action).toBe('allow');
  });

  it('run_tests：白名单外命令直接拒绝', () => {
    const p = new PolicyEngine({ allowedTestCommands: ['npm test'], autoApproveTestCommands: false });
    const d = p.decide('run_tests', 'execute', { command: 'rm -rf /' });
    expect(d.action).toBe('deny');
    expect(d.reason).toContain('白名单');
  });

  it('run_tests：白名单内命令需要用户确认（默认）', () => {
    const p = new PolicyEngine({ allowedTestCommands: ['npm test'], autoApproveTestCommands: false });
    const d = p.decide('run_tests', 'execute', { command: 'npm test' });
    expect(d.action).toBe('ask');
  });

  it('run_tests：开启自动批准后放行', () => {
    const p = new PolicyEngine({ allowedTestCommands: ['npm test'], autoApproveTestCommands: true });
    expect(p.decide('run_tests', 'execute', { command: 'npm test' }).action).toBe('allow');
  });

  it('未知执行类工具被拒绝', () => {
    const p = new PolicyEngine({ allowedTestCommands: [], autoApproveTestCommands: false });
    expect(p.decide('run_command', 'execute', {}).action).toBe('deny');
  });

  it('开启写入审批后 write 风险工具需要确认，read 不受影响', () => {
    const p = new PolicyEngine({
      allowedTestCommands: [],
      autoApproveTestCommands: false,
      requireApprovalForWrites: true
    });
    expect(p.decide('write_file', 'write', {}).action).toBe('ask');
    expect(p.decide('apply_patch', 'write', {}).action).toBe('ask');
    expect(p.decide('read_file', 'read', {}).action).toBe('allow');
    expect(p.decide('list_files', 'read', {}).action).toBe('allow');
  });

  it('白名单精确匹配：拼接注入或大小写变体一律拒绝', () => {
    const p = new PolicyEngine({ allowedTestCommands: ['npm test'], autoApproveTestCommands: false });
    const injections = [
      'npm test && rm -rf /',
      'npm test; curl http://evil.example',
      'npm test&whoami',
      'npm test | sh',
      'NPM TEST',
      'npm-test'
    ];
    for (const cmd of injections) {
      const d = p.decide('run_tests', 'execute', { command: cmd });
      expect(d.action, `命令 "${cmd}" 应被拒绝`).toBe('deny');
    }
    // 精确匹配 + 允许首尾空白
    expect(p.decide('run_tests', 'execute', { command: '  npm test  ' }).action).toBe('ask');
  });
});

describe('敏感信息脱敏', () => {
  it('API Key 模式被替换', () => {
    const out = redactSecrets('my key is sk-abcdef1234567890abc please');
    expect(out).not.toContain('sk-abcdef1234567890abc');
    expect(out).toContain('[REDACTED:api_key]');
  });

  it('Bearer Token 被替换', () => {
    const out = redactSecrets('Authorization: Bearer abc123def456ghi');
    expect(out).not.toContain('abc123def456ghi');
    expect(out).toContain('[REDACTED:bearer_token]');
  });

  it('key=value 凭据被替换', () => {
    const out = redactSecrets('{"api_key": "super-secret-value-123", "x": 1}');
    expect(out).not.toContain('super-secret-value-123');
    expect(out).toContain('"x": 1');
  });

  it('对象深遍历：敏感键整值抹除', () => {
    const out = redactValue({ apiKey: 'sk-abcdefghijklmnop', nested: { password: 'p@ssw0rd!' }, ok: 1 });
    expect(JSON.stringify(out)).not.toContain('sk-abcdefghijklmnop');
    expect(JSON.stringify(out)).not.toContain('p@ssw0rd!');
    expect(JSON.stringify(out)).toContain('"ok":1');
  });

  it('redactJson 对非序列化输入安全', () => {
    expect(redactJson({ a: BigInt(1) })).toBe('[unserializable]');
  });
});
