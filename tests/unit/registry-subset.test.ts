import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, ToolRegistry } from '../../src/tools';
import { makeCtx } from '../helpers';

describe('Registry.subset（工具白名单双端生效）', () => {
  const full = createDefaultRegistry();

  it('过滤结果只包含白名单工具 + 强制保留 complete_task', () => {
    const sub = full.subset(['read_file', 'search_files']);
    const names = sub.list().map((d) => d.name).sort();
    expect(names).toEqual(['complete_task', 'read_file', 'search_files']);
  });

  it('即使显式只给 complete_task 也保留（幂等）', () => {
    const sub = full.subset(['complete_task']);
    expect(sub.list().map((d) => d.name)).toEqual(['complete_task']);
  });

  it('未知名称被忽略（保存时已校验；运行时静默收紧）', () => {
    const sub = full.subset(['read_file', 'not_a_tool']);
    expect(sub.has('read_file')).toBe(true);
    expect(sub.has('not_a_tool')).toBe(false);
  });

  it('执行端：白名单外工具返回 UNKNOWN_TOOL（模型看不到却仍调用也会被拒）', async () => {
    const sub = full.subset(['read_file']);
    const res = await sub.run('write_file', JSON.stringify({ path: 'a.txt', content: 'x' }), makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('UNKNOWN_TOOL');
  });

  it('模型端：toModelTools 只暴露子集', () => {
    const sub = full.subset(['read_file']);
    const tools = sub.toModelTools().map((t) => t.name);
    expect(tools).toEqual(['read_file', 'complete_task']);
  });

  it('subset 产物与全量注册表互不影响', () => {
    full.subset(['read_file']);
    expect(full.has('write_file')).toBe(true);
    // 空注册表没有 complete_task 可保留 → 子集为空（保留语义只对源中存在的工具生效）
    const empty = new ToolRegistry().subset(['read_file']);
    expect(empty.list()).toEqual([]);
  });
});
