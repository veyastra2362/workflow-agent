import { describe, expect, it } from 'vitest';
import {
  auditParamValues,
  extractPlaceholders,
  renderTemplate,
  validateTemplate,
  PLACEHOLDER_RE
} from '../../src/core/templates';

const KNOWN_TOOLS = [
  'list_files', 'read_file', 'search_files', 'write_file', 'apply_patch',
  'get_git_diff', 'run_tests', 'submit_plan', 'update_plan', 'complete_task'
];

const VALID_BASE = {
  name: '代码整理',
  description: '整理目录',
  goalTemplate: '整理 {{directory}} 目录下的重复代码',
  acceptanceTemplate: '{{directory}} 目录无重复实现',
  params: [{ name: 'directory', required: true }],
  constraints: {}
};

describe('模板校验（保存时强校验）', () => {
  it('合法模板通过', () => {
    const r = validateTemplate(VALID_BASE, KNOWN_TOOLS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.params).toHaveLength(1);
      expect(r.value.description).toBe('整理目录');
    }
  });

  it('未声明的占位符被拒绝', () => {
    const r = validateTemplate(
      { ...VALID_BASE, goalTemplate: '整理 {{dir}} 与 {{scope}} 目录', params: [{ name: 'dir', required: true }] },
      KNOWN_TOOLS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toContain('{{scope}} 未在参数列表中声明');
  });

  it('非法参数名被拒绝', () => {
    const r = validateTemplate(
      { ...VALID_BASE, params: [{ name: '2bad-name', required: true }] },
      KNOWN_TOOLS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toContain('参数名');
  });

  it('重复参数名被拒绝', () => {
    const r = validateTemplate(
      {
        ...VALID_BASE,
        params: [
          { name: 'directory', required: true },
          { name: 'directory', required: false }
        ]
      },
      KNOWN_TOOLS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toContain('参数名重复');
  });

  it('allowedTools 中的未知工具被拒绝', () => {
    const r = validateTemplate(
      { ...VALID_BASE, constraints: { allowedTools: ['read_file', 'hack_tool'] } },
      KNOWN_TOOLS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toContain('hack_tool');
  });

  it('约束范围越界被拒绝（maxSteps=0 / 超时 1 秒）', () => {
    expect(validateTemplate({ ...VALID_BASE, constraints: { maxSteps: 0 } }, KNOWN_TOOLS).ok).toBe(false);
    expect(
      validateTemplate({ ...VALID_BASE, constraints: { taskTimeoutMs: 1000 } }, KNOWN_TOOLS).ok
    ).toBe(false);
  });
});

describe('模板渲染', () => {
  const tpl = {
    goalTemplate: '整理 {{directory}} 目录，风格为 {{directory}}-v2',
    acceptanceTemplate: '{{directory}} 下无重复',
    params: [
      { name: 'directory', required: true },
      { name: 'style', required: false, default: 'concise' }
    ]
  };

  it('必填缺失 → 错误', () => {
    const r = renderTemplate(tpl, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('缺少必填参数：directory');
  });

  it('默认值生效；同一占位符多处替换', () => {
    const r = renderTemplate(tpl, { directory: 'src' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goal).toBe('整理 src 目录，风格为 src-v2');
      expect(r.acceptance).toBe('src 下无重复');
    }
  });

  it('显式值覆盖默认值；未声明的多余值被忽略', () => {
    const r = renderTemplate(tpl, { directory: 'lib', style: 'verbose', hacker: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal).toContain('lib');
  });

  it('参数值中的 {{ 不会被二次展开（单趟替换）', () => {
    const r = renderTemplate(
      { goalTemplate: '内容：{{body}}', params: [{ name: 'body', required: true }] },
      { body: '{{directory}} 不应被替换' }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.goal).toBe('内容：{{directory}} 不应被替换');
  });

  it('参数值过长被拒绝；渲染后目标超长被拒绝', () => {
    const long = 'x'.repeat(10_001);
    expect(renderTemplate(tpl, { directory: long }).ok).toBe(false);
    const big = {
      goalTemplate: 'a'.repeat(19_000) + '{{body}}',
      params: [{ name: 'body', required: true }]
    };
    expect(renderTemplate(big, { body: 'b'.repeat(2000) }).ok).toBe(false);
  });
});

describe('参数审计脱敏', () => {
  it('只记录参数名与脱敏摘要，不落原始值', () => {
    const params = [{ name: 'apiKey', required: true }, { name: 'note', required: true }];
    const audit = auditParamValues(params, {
      apiKey: 'sk-abcdefghijklmnop123456',
      note: '普通说明'
    });
    expect(audit.note).toBe('普通说明');
    const json = JSON.stringify(audit);
    expect(json).not.toContain('sk-abcdefghijklmnop123456');
    expect(audit.apiKey).toContain('[REDACTED');
  });

  it('长值被截断并标注长度', () => {
    const audit = auditParamValues([{ name: 'doc', required: true }], { doc: 'y'.repeat(500) });
    expect(audit.doc.length).toBeLessThan(120);
    expect(audit.doc).toContain('已截断');
  });

  it('未提供值的参数记录为空摘要', () => {
    const audit = auditParamValues([{ name: 'opt', required: false }], {});
    expect(audit.opt).toBe('');
  });
});

describe('占位符提取', () => {
  it('extractPlaceholders 去重且容忍空白', () => {
    expect(extractPlaceholders('{{ a }} and {{b}} and {{a}}').sort()).toEqual(['a', 'b']);
    expect('x'.replace(PLACEHOLDER_RE, '')).toBe('x');
  });
});
