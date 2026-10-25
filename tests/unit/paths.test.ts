import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertWritableInsideWorkspace,
  PolicyViolationError,
  requireReadableInsideWorkspace,
  resolveInsideWorkspace
} from '../../src/policy/paths';
import { makeTempDir } from '../helpers';

describe('resolveInsideWorkspace（路径规范化与边界）', () => {
  const root = path.resolve('/tmp/fake-ws');

  it('相对路径解析到工作区内', () => {
    expect(resolveInsideWorkspace(root, 'a/b.txt').toLowerCase()).toBe(
      path.resolve(root, 'a/b.txt').toLowerCase()
    );
  });

  it('默认路径 . 解析为工作区根', () => {
    expect(resolveInsideWorkspace(root, '.').toLowerCase()).toBe(root.toLowerCase());
  });

  it('拒绝 .. 穿越', () => {
    expect(() => resolveInsideWorkspace(root, '../outside.txt')).toThrow(PolicyViolationError);
    expect(() => resolveInsideWorkspace(root, 'a/../../outside.txt')).toThrow(PolicyViolationError);
    expect(() => resolveInsideWorkspace(root, '..\\..\\outside.txt')).toThrow(PolicyViolationError);
  });

  it('拒绝绝对路径越界', () => {
    const outside = path.resolve(root, '..', 'outside.txt');
    expect(() => resolveInsideWorkspace(root, outside)).toThrow(PolicyViolationError);
  });

  it('拒绝空路径与 NUL 字节', () => {
    expect(() => resolveInsideWorkspace(root, '')).toThrow(PolicyViolationError);
    expect(() => resolveInsideWorkspace(root, 'a\0b')).toThrow(PolicyViolationError);
  });

  it('区内子目录指向合法', () => {
    expect(() => resolveInsideWorkspace(root, 'sub/../file.txt')).not.toThrow();
  });
});

describe('真实路径检查（符号链接防御）', () => {
  it('拒绝读取经由目录链接指向区外的文件', () => {
    const ws = makeTempDir('wa-boundary-');
    const outside = makeTempDir('wa-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    let made = false;
    try {
      fs.symlinkSync(outside, path.join(ws, 'link'), 'junction');
      made = true;
    } catch {
      // 某些环境不允许创建链接 —— 跳过
    }
    if (made) {
      expect(() =>
        requireReadableInsideWorkspace(ws, path.join(ws, 'link', 'secret.txt'))
      ).toThrow(PolicyViolationError);
    }
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('拒绝写入指向区外的文件符号链接', () => {
    const ws = makeTempDir('wa-boundary2-');
    const outside = makeTempDir('wa-outside2-');
    const target = path.join(outside, 'victim.txt');
    fs.writeFileSync(target, 'original');
    let made = false;
    try {
      fs.symlinkSync(target, path.join(ws, 'evil.txt'), 'file');
      made = true;
    } catch {
      // Windows 无开发者模式时创建文件符号链接需要管理员权限 —— 跳过
    }
    if (made) {
      expect(() => assertWritableInsideWorkspace(ws, path.join(ws, 'evil.txt'))).toThrow(
        PolicyViolationError
      );
    }
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('工作区内的普通文件读取通过', () => {
    const ws = makeTempDir('wa-ok-');
    fs.writeFileSync(path.join(ws, 'ok.txt'), 'hello');
    expect(() => requireReadableInsideWorkspace(ws, path.join(ws, 'ok.txt'))).not.toThrow();
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
