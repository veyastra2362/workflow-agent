import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDefaultRegistry } from '../../src/tools';
import { makeCtx, makeTempDir } from '../helpers';

/**
 * 安全边界测试：所有越界访问都必须在程序层面（而非提示词）被拒绝。
 */
const registry = createDefaultRegistry();

async function expectPolicyViolation(tool: string, args: unknown, ws: string): Promise<void> {
  const res = await registry.run(tool, JSON.stringify(args), makeCtx(ws));
  expect(res.ok).toBe(false);
  expect(res.error?.code).toBe('POLICY_VIOLATION');
}

describe('安全：路径穿越防御（通过真实工具执行）', () => {
  it('read_file 拒绝 ../ 穿越', async () => {
    const ws = makeTempDir('wa-sec-');
    const secret = path.join(path.dirname(ws), 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    await expectPolicyViolation('read_file', { path: '../secret.txt' }, ws);
    await expectPolicyViolation('read_file', { path: 'sub/../../secret.txt' }, ws);
    await expectPolicyViolation('read_file', { path: secret }, ws);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(secret, { force: true });
  });

  it('write_file 拒绝穿越并在区外创建文件', async () => {
    const ws = makeTempDir('wa-sec-w-');
    const outsideTarget = path.join(path.dirname(ws), 'evil.txt');
    await expectPolicyViolation('write_file', { path: '../evil.txt', content: 'x' }, ws);
    await expectPolicyViolation('write_file', { path: 'a/../../../evil.txt', content: 'x' }, ws);
    expect(fs.existsSync(outsideTarget)).toBe(false);
    // 深层不存在目录的穿越变体
    await expectPolicyViolation('write_file', { path: 'a/b/../../../../evil2.txt', content: 'x' }, ws);
    expect(fs.existsSync(path.join(path.dirname(ws), 'evil2.txt'))).toBe(false);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('search_files/list_files 拒绝越界路径', async () => {
    const ws = makeTempDir('wa-sec-s-');
    fs.writeFileSync(path.join(ws, 'f.txt'), 'x needle');
    // 对照：区内搜索合法
    const okRes = await registry.run('search_files', JSON.stringify({ query: 'needle' }), makeCtx(ws));
    expect(okRes.ok).toBe(true);
    // 越界：相对与绝对路径
    await expectPolicyViolation('list_files', { path: '..' }, ws);
    const outside = path.join(path.dirname(ws), 'subdir');
    fs.mkdirSync(outside, { recursive: true });
    await expectPolicyViolation('list_files', { path: outside }, ws);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('read_file 拒绝经由目录 junction 访问区外文件', async () => {
    const ws = makeTempDir('wa-sec-j-');
    const outside = path.join(os.tmpdir(), `wa-sec-j-out-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    let made = false;
    try {
      fs.symlinkSync(outside, path.join(ws, 'innocent'), 'junction');
      made = true;
    } catch {
      // 无权限创建链接时跳过
    }
    if (made) {
      await expectPolicyViolation('read_file', { path: 'innocent/secret.txt' }, ws);
      await expectPolicyViolation('write_file', { path: 'innocent/evil.txt', content: 'x' }, ws);
    }
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('write_file 拒绝经由文件符号链接覆盖区外文件', async () => {
    const ws = makeTempDir('wa-sec-fl-');
    const outside = path.join(os.tmpdir(), `wa-sec-fl-out-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'original');
    let made = false;
    try {
      fs.symlinkSync(outside, path.join(ws, 'looks-local.txt'), 'file');
      made = true;
    } catch {
      // Windows 无管理员/开发者模式时跳过
    }
    if (made) {
      await expectPolicyViolation('write_file', { path: 'looks-local.txt', content: 'hacked' }, ws);
      expect(fs.readFileSync(outside, 'utf8')).toBe('original');
    }
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  it('合法区内操作正常工作（对照）', async () => {
    const ws = makeTempDir('wa-sec-ok-');
    const res = await registry.run(
      'write_file',
      JSON.stringify({ path: 'ok/inner.txt', content: 'fine' }),
      makeCtx(ws)
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'ok', 'inner.txt'), 'utf8')).toBe('fine');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
