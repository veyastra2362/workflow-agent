import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { z } from 'zod';
import { createDefaultRegistry, ToolRegistry } from '../../src/tools';
import { makeCtx, makeTempDir, nextCallId } from '../helpers';

const registry = createDefaultRegistry();

describe('Tool Registry：参数与错误处理', () => {
  it('拒绝未注册的工具名', async () => {
    const res = await registry.run('not_a_tool', '{}', makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('UNKNOWN_TOOL');
  });

  it('拒绝非法 JSON 参数', async () => {
    const res = await registry.run('read_file', '{broken json', makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_ARGS');
  });

  it('拒绝未通过 Schema 校验的参数（类型错误 / 缺少必填）', async () => {
    const res1 = await registry.run('read_file', JSON.stringify({ path: 123 }), makeCtx('/tmp'));
    expect(res1.ok).toBe(false);
    expect(res1.error?.code).toBe('INVALID_ARGS');
    expect(res1.error?.issues).toBeTruthy();

    const res2 = await registry.run('write_file', JSON.stringify({ path: 'a.txt' }), makeCtx('/tmp'));
    expect(res2.ok).toBe(false);
    expect(res2.error?.code).toBe('INVALID_ARGS');
  });

  it('工具执行超时返回 TIMEOUT', async () => {
    const local = new ToolRegistry();
    local.register({
      name: 'slow_tool',
      description: 'slow',
      riskLevel: 'read',
      timeoutMs: 80,
      schema: z.object({}),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 2000));
        return 'done';
      }
    });
    const res = await local.run('slow_tool', '{}', makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('TIMEOUT');
    expect(res.durationMs).toBeLessThan(1500);
  }, 5000);

  it('任务取消后不再执行工具', async () => {
    let executed = false;
    const local = new ToolRegistry();
    local.register({
      name: 'spy_tool',
      description: 'spy',
      riskLevel: 'read',
      timeoutMs: 5000,
      schema: z.object({}),
      execute: async () => {
        executed = true;
        return 'ok';
      }
    });
    const ctx = makeCtx('/tmp');
    (ctx.cancellationToken as { cancelled: boolean }).cancelled = true;
    const res = await local.run('spy_tool', '{}', ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CANCELLED');
    expect(executed).toBe(false);
  });

  it('超长输出被截断并标记', async () => {
    const local = new ToolRegistry();
    local.register({
      name: 'big_tool',
      description: 'big',
      riskLevel: 'read',
      timeoutMs: 5000,
      schema: z.object({}),
      execute: async () => ({ blob: 'x'.repeat(60_000) })
    });
    const res = await local.run('big_tool', '{}', makeCtx('/tmp'), { maxResultChars: 5000 });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    const data = res.data as { truncated: boolean; preview: string };
    expect(data.truncated).toBe(true);
    expect(data.preview.length).toBeLessThanOrEqual(5000);
  });

  it('toModelTools 生成 OpenAI function calling 声明', () => {
    const tools = registry.toModelTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_files',
        'read_file',
        'search_files',
        'write_file',
        'apply_patch',
        'get_git_diff',
        'run_tests',
        'submit_plan',
        'complete_task'
      ])
    );
    const readFile = tools.find((t) => t.name === 'read_file')!;
    expect(readFile.parametersJsonSchema).toHaveProperty('properties');
    expect(readFile.description.length).toBeGreaterThan(10);
  });

  it('真实 fs 错误被归一化为结构化错误', async () => {
    const ws = makeTempDir('wa-reg-');
    const res = await registry.run('read_file', JSON.stringify({ path: 'missing.txt' }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(['POLICY_VIOLATION', 'EXECUTION_FAILED']).toContain(res.error?.code);
    expect(res.summary).toContain('文件不存在');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('run_tests 拒绝白名单外命令是策略层行为（loop 层面测试见集成测试）', async () => {
    // 直接执行层面不做二次校验（由 PolicyEngine 在 loop 中强制），
    // 这里仅验证工具本身能以数组参数方式运行。
    const ws = makeTempDir('wa-runtests-');
    const res = await registry.run(
      'run_tests',
      JSON.stringify({ command: 'node', args: ['-e', 'process.exit(0)'] }),
      makeCtx(ws)
    );
    expect(res.ok).toBe(true);
    const data = res.data as { exitCode: number };
    expect(data.exitCode).toBe(0);
    fs.rmSync(ws, { recursive: true, force: true });
  }, 20_000);

  it('nextCallId 唯一（工具结果与调用匹配的基础）', () => {
    expect(nextCallId()).not.toBe(nextCallId());
  });
});
