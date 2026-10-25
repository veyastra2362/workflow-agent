import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../../src/tools';
import { makeCtx, makeTempDir } from '../helpers';

const registry = createDefaultRegistry();

describe('文件工具：list_files / read_file / write_file', () => {
  it('list_files 列出文件与目录并忽略 node_modules', async () => {
    const ws = makeTempDir('wa-ls-');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a');
    fs.mkdirSync(path.join(ws, 'sub'));
    fs.writeFileSync(path.join(ws, 'sub', 'b.txt'), 'b');
    fs.mkdirSync(path.join(ws, 'node_modules'));
    fs.writeFileSync(path.join(ws, 'node_modules', 'c.js'), 'c');

    const res = await registry.run('list_files', '{}', makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { count: number; entries: Array<{ path: string; type: string }> };
    const paths = data.entries.map((e) => e.path);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('sub');
    expect(paths).toContain('sub/b.txt');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);

    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('list_files 支持子目录与 maxEntries 截断', async () => {
    const ws = makeTempDir('wa-ls2-');
    fs.mkdirSync(path.join(ws, 'sub'));
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(ws, 'sub', `f${i}.txt`), 'x');
    const res = await registry.run(
      'list_files',
      JSON.stringify({ path: 'sub', maxEntries: 5 }),
      makeCtx(ws)
    );
    const data = res.data as { count: number; truncated: boolean };
    expect(data.count).toBe(5);
    expect(data.truncated).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('read_file 读取文本并报告截断', async () => {
    const ws = makeTempDir('wa-read-');
    const content = 'line1\nline2\nline3';
    fs.writeFileSync(path.join(ws, 'a.txt'), content);
    const res = await registry.run('read_file', JSON.stringify({ path: 'a.txt' }), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { content: string; truncated: boolean; sizeBytes: number };
    expect(data.content).toBe(content);
    expect(data.truncated).toBe(false);

    const res2 = await registry.run(
      'read_file',
      JSON.stringify({ path: 'a.txt', maxBytes: 5 }),
      makeCtx(ws)
    );
    const data2 = res2.data as { content: string; truncated: boolean };
    expect(data2.content).toBe('line1');
    expect(data2.truncated).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('read_file 拒绝返回二进制内容', async () => {
    const ws = makeTempDir('wa-bin-');
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const res = await registry.run('read_file', JSON.stringify({ path: 'bin.dat' }), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { binary: boolean };
    expect(data.binary).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('write_file 创建嵌套新文件并登记 create 变更', async () => {
    const ws = makeTempDir('wa-write-');
    const ctx = makeCtx(ws);
    const res = await registry.run(
      'write_file',
      JSON.stringify({ path: 'deep/nested/new.txt', content: 'hello' }),
      ctx
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'deep', 'nested', 'new.txt'), 'utf8')).toBe('hello');
    const changes = ctx.getRecordedChanges();
    expect(changes).toEqual([{ path: 'deep/nested/new.txt', kind: 'create' }]);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('write_file 覆盖已有文件时登记修改前备份', async () => {
    const ws = makeTempDir('wa-write2-');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'original-content');
    const ctx = makeCtx(ws);
    const res = await registry.run(
      'write_file',
      JSON.stringify({ path: 'a.txt', content: 'new-content' }),
      ctx
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('new-content');
    const changes = ctx.getRecordedChanges();
    expect(changes).toEqual([{ path: 'a.txt', kind: 'modify' }]);
    expect(ctx.readBackup('a.txt')).toBe('original-content');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('write_file 拒绝覆盖二进制文件', async () => {
    const ws = makeTempDir('wa-write3-');
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
    const res = await registry.run(
      'write_file',
      JSON.stringify({ path: 'bin.dat', content: 'text' }),
      makeCtx(ws)
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('POLICY_VIOLATION');
    expect(fs.readFileSync(path.join(ws, 'bin.dat'))).toEqual(Buffer.from([1, 0, 2, 0]));
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
