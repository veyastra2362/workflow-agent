import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../../src/shared/protocol';

/**
 * 防漂移：sandbox 模式下 preload 不能 require 本地模块，通道名在 preload 中内联。
 * 此测试确保内联的通道名与协议定义始终一致。
 */
describe('preload 通道与协议一致', () => {
  it('preload 内联通道覆盖 IPC 的每个通道', () => {
    const preloadSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/preload/index.ts'),
      'utf8'
    );
    for (const channel of Object.values(IPC)) {
      expect(preloadSrc, `preload 缺少通道 "${channel}"`).toContain(`'${channel}'`);
    }
  });

  it('preload 不 require 本地模块（sandbox 兼容）', () => {
    const preloadSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/preload/index.ts'),
      'utf8'
    );
    const runtimeRequires = [...preloadSrc.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)];
    expect(runtimeRequires, 'sandbox preload 不能引入本地运行时模块').toHaveLength(0);
  });
});
