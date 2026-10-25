import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../../src/tools';
import { makeCtx, makeTempDir } from '../helpers';

const registry = createDefaultRegistry();

function setupFile(content: string): { ws: string; ctx: ReturnType<typeof makeCtx> } {
  const ws = makeTempDir('wa-patch-');
  fs.writeFileSync(path.join(ws, 'code.txt'), content);
  return { ws, ctx: makeCtx(ws) };
}

describe('apply_patch：可审查的局部修改', () => {
  it('first 模式只替换第一处', async () => {
    const { ws, ctx } = setupFile('alpha beta alpha');
    const res = await registry.run(
      'apply_patch',
      JSON.stringify({ path: 'code.txt', edits: [{ find: 'alpha', replace: 'X' }] }),
      ctx
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'code.txt'), 'utf8')).toBe('X beta alpha');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('all 模式替换全部', async () => {
    const { ws, ctx } = setupFile('alpha beta alpha');
    const res = await registry.run(
      'apply_patch',
      JSON.stringify({ path: 'code.txt', edits: [{ find: 'alpha', replace: 'X', mode: 'all' }] }),
      ctx
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'code.txt'), 'utf8')).toBe('X beta X');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('expectedCount 断言失败时文件保持不变', async () => {
    const original = 'alpha beta alpha';
    const { ws, ctx } = setupFile(original);
    const res = await registry.run(
      'apply_patch',
      JSON.stringify({
        path: 'code.txt',
        edits: [{ find: 'alpha', replace: 'X', expectedCount: 3 }]
      }),
      ctx
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('EXECUTION_FAILED');
    expect(res.error?.message).toContain('expectedCount=3');
    expect(fs.readFileSync(path.join(ws, 'code.txt'), 'utf8')).toBe(original);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('find 未找到时报错且文件不变', async () => {
    const original = 'hello world';
    const { ws, ctx } = setupFile(original);
    const res = await registry.run(
      'apply_patch',
      JSON.stringify({ path: 'code.txt', edits: [{ find: 'not-exist', replace: 'X' }] }),
      ctx
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain('未在文件中找到');
    expect(fs.readFileSync(path.join(ws, 'code.txt'), 'utf8')).toBe(original);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('多编辑整体应用：后续编辑失败则前面的也不生效', async () => {
    const original = 'aaa\nbbb';
    const { ws, ctx } = setupFile(original);
    const res = await registry.run(
      'apply_patch',
      JSON.stringify({
        path: 'code.txt',
        edits: [
          { find: 'aaa', replace: 'AAA' },
          { find: 'zzz', replace: 'Z' }
        ]
      }),
      ctx
    );
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(path.join(ws, 'code.txt'), 'utf8')).toBe(original);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('返回统一 diff 且登记备份', async () => {
    const { ws, ctx } = setupFile('old line\nkeep\n');
    const res = await registry.run(
      'apply_patch',
      JSON.stringify({ path: 'code.txt', edits: [{ find: 'old line', replace: 'new line' }] }),
      ctx
    );
    expect(res.ok).toBe(true);
    const data = res.data as { diff: string };
    expect(data.diff).toContain('-old line');
    expect(data.diff).toContain('+new line');
    expect(ctx.readBackup('code.txt')).toBe('old line\nkeep\n');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('拒绝修改二进制文件', async () => {
    const ws = makeTempDir('wa-patch-bin-');
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0, 1, 2]));
    const res = await registry.run(
      'apply_patch',
      JSON.stringify({ path: 'bin.dat', edits: [{ find: 'a', replace: 'b' }] }),
      makeCtx(ws)
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('POLICY_VIOLATION');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
