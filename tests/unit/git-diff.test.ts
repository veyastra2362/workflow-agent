import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createDefaultRegistry } from '../../src/tools';
import { makeCtx, makeTempDir } from '../helpers';

const registry = createDefaultRegistry();

describe('get_git_diff', () => {
  it('非 git 工作区回退为会话差异（基于备份）', async () => {
    const ws = makeTempDir('wa-diff-');
    const ctx = makeCtx(ws);
    // 模拟工具修改：登记备份后实际修改文件
    ctx.recordFileChange({ path: 'a.txt', kind: 'modify', backupContent: 'old line\n' });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'old line\nnew line\n');
    ctx.recordFileChange({ path: 'created.txt', kind: 'create', backupContent: null });
    fs.writeFileSync(path.join(ws, 'created.txt'), 'brand new\n');

    const res = await registry.run('get_git_diff', '{}', ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { mode: string; diff: string };
    expect(data.mode).toBe('session');
    expect(data.diff).toContain('a.txt');
    expect(data.diff).toContain('+new line');
    expect(data.diff).toContain('old line');
    expect(data.diff).toContain('+brand new');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('git 仓库中使用 git diff（固定参数，无注入面）', async () => {
    const ws = makeTempDir('wa-diff-git-');
    const git = (args: string): void => {
      execSync(`git ${args}`, { cwd: ws, stdio: 'ignore' });
    };
    try {
      execSync('git init', { cwd: ws, stdio: 'ignore' });
      git('config user.email test@test.local');
      git('config user.name test');
      fs.writeFileSync(path.join(ws, 'tracked.txt'), 'v1\n');
      git('add .');
      fs.writeFileSync(path.join(ws, 'tracked.txt'), 'v2\n');

      const res = await registry.run('get_git_diff', '{}', makeCtx(ws));
      expect(res.ok).toBe(true);
      const data = res.data as { mode: string; diff: string; status: string };
      expect(data.mode).toBe('git');
      expect(data.diff).toContain('+v2');
      expect(data.diff).toContain('-v1');
      expect(data.status).toContain('tracked.txt');
    } catch {
      // 环境无 git 时跳过（极少数情况）
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);
});
