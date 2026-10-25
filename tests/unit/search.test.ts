import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../../src/tools';
import { makeCtx, makeTempDir } from '../helpers';

const registry = createDefaultRegistry();

function setupWorkspace(): string {
  const ws = makeTempDir('wa-search-');
  fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'app.ts'), 'const alpha = 1;\nconst Beta = 2;\n');
  fs.writeFileSync(path.join(ws, 'lib', 'util.ts'), 'export function gamma() {}\n');
  fs.writeFileSync(path.join(ws, 'notes.md'), '# Alpha 笔记\n正文\n');
  return ws;
}

describe('search_files', () => {
  it('内容搜索（默认大小写不敏感）', async () => {
    const ws = setupWorkspace();
    const res = await registry.run(
      'search_files',
      JSON.stringify({ query: 'alpha', mode: 'content' }),
      makeCtx(ws)
    );
    expect(res.ok).toBe(true);
    const data = res.data as { matches: Array<{ path: string; line: number; snippet: string }>; filesScanned: number };
    expect(data.matches.length).toBe(2);
    expect(data.matches[0].path).toBe('app.ts');
    expect(data.matches[0].line).toBe(1);
    expect(data.filesScanned).toBeGreaterThanOrEqual(3);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('正则搜索', async () => {
    const ws = setupWorkspace();
    const res = await registry.run(
      'search_files',
      JSON.stringify({ query: 'const \\w+ =', isRegex: true }),
      makeCtx(ws)
    );
    const data = res.data as { matches: unknown[] };
    expect(data.matches.length).toBe(2);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('文件名搜索 + glob 过滤', async () => {
    const ws = setupWorkspace();
    const res = await registry.run(
      'search_files',
      JSON.stringify({ query: '*.ts', mode: 'filename' }),
      makeCtx(ws)
    );
    const data = res.data as { matches: Array<{ path: string }> };
    const paths = data.matches.map((m) => m.path).sort();
    expect(paths).toEqual(['app.ts', 'lib/util.ts']);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('内容搜索受 maxResults 限制并标记截断', async () => {
    const ws = makeTempDir('wa-search-cap-');
    fs.writeFileSync(path.join(ws, 'big.txt'), 'hit\n'.repeat(100));
    const res = await registry.run(
      'search_files',
      JSON.stringify({ query: 'hit', maxResults: 10 }),
      makeCtx(ws)
    );
    const data = res.data as { matches: unknown[]; truncated: boolean };
    expect(data.matches.length).toBe(10);
    expect(data.truncated).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('跳过二进制文件', async () => {
    const ws = makeTempDir('wa-search-bin-');
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(ws, 'text.txt'), 'needle');
    const res = await registry.run(
      'search_files',
      JSON.stringify({ query: 'needle' }),
      makeCtx(ws)
    );
    const data = res.data as { matches: Array<{ path: string }> };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0].path).toBe('text.txt');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
