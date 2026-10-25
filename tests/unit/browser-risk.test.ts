import { describe, expect, it } from 'vitest';
import {
  approvalSummary,
  classifyClick,
  classifyType,
  elementSignature
} from '../../src/policy/browser-risk';
import { createDefaultRegistry } from '../../src/tools';
import { BrowserSessionManager } from '../../src/tools/browser/session';

const PAGE = 'https://shop.example.com/checkout';

describe('点击风险分类（动词矩阵与保守默认）', () => {
  const el = (over: Partial<Parameters<typeof classifyClick>[0]>): Parameters<typeof classifyClick>[0] => ({
    ref: 'e1',
    tag: 'button',
    ...over
  });

  it.each([
    ['删除账号', 'button', { text: '删除账号' }],
    ['发布', 'button', { text: '发布' }],
    ['确认支付', 'button', { text: '确认支付' }],
    ['Submit order', 'button', { text: 'Submit order' }],
    ['remove', 'a', { text: 'remove item', href: 'https://x.example/rm' }],
    ['登录', 'a', { text: '登录', href: 'https://x.example/login' }],
    ['change password', 'button', { text: 'change password' }],
    ['submit 型按钮', 'input', { type: 'submit', name: 'op' }],
    ['image 型提交', 'input', { type: 'image' }],
    ['表单内无文案按钮', 'button', { formAction: 'https://x.example/api', formMethod: 'post' }],
    ['password 控件', 'input', { type: 'password' }],
    ['信息不足的裸按钮', 'button', {}]
  ])('高风险：%s', (_label, _tag, over) => {
    expect(classifyClick(el(over as never), PAGE).risk).toBe('high');
  });

  it.each([
    ['普通导航链接', { tag: 'a', text: '下一页', href: 'https://shop.example.com/page2' }],
    ['普通文案按钮（无副作用动词、不在表单内）', { tag: 'button', text: '展开更多' }],
    ['禁用按钮', { tag: 'button', text: '删除', disabled: true }]
  ])('非高风险：%s', (_label, over) => {
    const d = classifyClick(el(over as never), PAGE);
    expect(d.risk).not.toBe('high');
  });

  it('禁用按钮直接判低风险（无实际效果）', () => {
    expect(classifyClick(el({ text: '删除账号', disabled: true }), PAGE).risk).toBe('low');
  });

  it('审批摘要包含目标 origin 与影响描述', () => {
    const d = classifyClick(el({ text: '删除账号' }), PAGE);
    const summary = approvalSummary('点击', el({ text: '删除账号' }), PAGE, d.impact ?? '');
    expect(summary).toContain('https://shop.example.com');
    expect(summary).toContain('删除账号');
  });
});

describe('输入风险分类（敏感字段保守规则）', () => {
  const field = (over: Record<string, unknown>): Parameters<typeof classifyType>[0] =>
    ({ ref: 'e2', tag: 'input', ...over }) as never;

  it('密码字段（type=password）→ 高', () => {
    expect(classifyType(field({ type: 'password' }), '任意值').risk).toBe('high');
  });

  it('autocomplete 支付/一次性码字段 → 高', () => {
    for (const ac of ['cc-number', 'cc-csc', 'one-time-code', 'current-password']) {
      expect(classifyType(field({ type: 'text', autocomplete: ac }), '4111 1111 1111 1111').risk).toBe('high');
    }
  });

  it.each([
    ['name 含验证码', { type: 'text', name: '短信验证码' }],
    ['name 含信用卡', { type: 'text', name: '信用卡卡号' }],
    ['name 含 cvv', { type: 'text', name: 'cvv code' }],
    ['语义不明的裸文本框', { type: 'text' }]
  ])('敏感迹象/不明确 → 高：%s', (_l, over) => {
    expect(classifyType(field(over), 'hello').risk).toBe('high');
  });

  it('待输入内容本身匹配密钥/卡号形态 → 高', () => {
    expect(classifyType(field({ type: 'text', name: '备注' }), 'sk-abcdefghijklmnop1234').risk).toBe('high');
    expect(classifyType(field({ type: 'text', name: '备注' }), '4111 1111 1111 1111').risk).toBe('high');
  });

  it.each([
    ['搜索框', { type: 'search', name: 'q' }],
    ['普通文本框（有名称）', { type: 'text', name: 'username-field' }],
    ['邮箱框', { type: 'email', name: 'email' }],
    ['textarea', { tag: 'textarea', name: 'comment' }]
  ])('普通字段 → 低（不逐次审批）：%s', (_l, over) => {
    expect(classifyType(field(over), '普通内容').risk).toBe('low');
  });

  it('审批摘要绝不包含待输入值', () => {
    const d = classifyType(field({ type: 'password' }), 'super-secret-987654');
    const summary = approvalSummary('输入', field({ type: 'password' }), PAGE, d.impact ?? '');
    expect(summary).not.toContain('super-secret-987654');
  });
});

describe('元素签名（审批绑定与失效）', () => {
  const base = { ref: 'e5', tag: 'button', text: '删除账号', name: 'del' };

  it('特征不变 → 签名稳定', () => {
    expect(elementSignature(base as never, PAGE)).toBe(elementSignature({ ...base } as never, PAGE));
  });

  it.each([
    ['文案变化', { text: '删除账 号' }],
    ['类型变化', { type: 'submit' }],
    ['名称变化', { name: 'del2' }],
    ['href 变化', { href: 'https://other.example/x' }]
  ])('%s → 签名变化', (_l, over) => {
    expect(elementSignature({ ...base, ...over } as never, PAGE)).not.toBe(
      elementSignature(base as never, PAGE)
    );
  });

  it('页面 URL 变化 → 签名变化（跨页失效）', () => {
    expect(elementSignature(base as never, 'https://shop.example.com/other')).not.toBe(
      elementSignature(base as never, PAGE)
    );
  });
});

describe('注册表注册边界', () => {
  it('默认（未启用浏览器）不注册 browser_* 工具', () => {
    const registry = createDefaultRegistry();
    const names = registry.list().map((d) => d.name);
    expect(names).not.toContain('browser_open');
    expect(names).not.toContain('browser_click');
  });

  it('传入 manager 后注册全部 6 个浏览器工具', () => {
    const manager = new BrowserSessionManager();
    const registry = createDefaultRegistry({ browser: { manager } });
    const names = registry.list().map((d) => d.name);
    for (const n of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_close']) {
      expect(names).toContain(n);
    }
  });

  it('click/type 只接受 ref（选择器被 Schema 拒绝）', async () => {
    const manager = new BrowserSessionManager();
    const registry = createDefaultRegistry({ browser: { manager } });
    const ctx = { workspace: '/tmp', taskId: 't-schema', signal: new AbortController().signal, cancellationToken: { cancelled: false }, now: () => Date.now(), recordFileChange: () => undefined, getRecordedChanges: () => [], readBackup: () => null };
    for (const bad of ['button:has-text("x")', 'div#main', '.cls', '//xpath', 'e1 abc']) {
      const r = await registry.run('browser_click', JSON.stringify({ ref: bad }), ctx);
      expect(r.error?.code, bad).toBe('INVALID_ARGS');
    }
  });
});
