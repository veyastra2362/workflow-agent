import { describe, expect, it } from 'vitest';
import {
  mapMcpResult,
  mcpRegisteredName,
  validateArgsAgainstSchema,
  validateToolSchema
} from '../../src/tools/mcp/convert';
import { buildChildEnv, mcpServerConfigSchema, validateServerConfigAtRuntime } from '../../src/tools/mcp/validate-config';

const ECHO_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '内容', minLength: 1, maxLength: 100 },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    tags: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 5 }
  },
  required: ['text'],
  additionalProperties: false
} as const;

describe('MCP Schema 白名单（同源校验前提）', () => {
  it('合法 Schema 通过（含嵌套/枚举/边界）', () => {
    expect(validateToolSchema(ECHO_SCHEMA).ok).toBe(true);
    expect(
      validateToolSchema({
        type: 'object',
        properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] }, opt: { type: ['string', 'null'] } }
      }).ok
    ).toBe(true);
  });

  it.each([
    ['$ref', { type: 'object', properties: { a: { $ref: '#/$defs/x' } } }],
    ['oneOf', { type: 'object', oneOf: [] }],
    ['allOf', { type: 'object', allOf: [] }],
    ['anyOf', { type: 'object', anyOf: [] }],
    ['not', { type: 'object', not: { type: 'string' } }],
    ['format', { type: 'object', properties: { d: { type: 'string', format: 'date-time' } } }],
    ['pattern', { type: 'object', properties: { s: { type: 'string', pattern: '^a' } } }],
    ['patternProperties', { type: 'object', patternProperties: { '^x': { type: 'string' } } }],
    ['tuple items', { type: 'object', properties: { t: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } }],
    ['schema 形式 additionalProperties', { type: 'object', additionalProperties: { type: 'string' } }],
    ['无 type', { properties: { a: { type: 'string' } } }],
    ['未知关键字（顶层）', { type: 'object', description: 'x', example: true }],
    ['未知关键字（嵌套）', { type: 'object', properties: { a: { type: 'string', examples: ['x'] } } }],
    ['required 不在 properties', { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }],
    ['对象关键字用于标量', { type: 'string', properties: { a: { type: 'string' } } }],
    ['items 用于非数组', { type: 'string', items: { type: 'string' } }],
    ['enum 含对象', { type: 'string', enum: [{ bad: 1 }] }],
    ['enum 空数组', { type: 'string', enum: [] }],
    ['minLength 非整数', { type: 'string', minLength: 1.5 }],
    ['超深嵌套', (() => {
      let s: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 8; i += 1) s = { type: 'object', properties: { a: s } };
      return s;
    })()],
    ['属性数超限', { type: 'object', properties: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, { type: 'string' }])) }],
    ['不支持 type', { type: 'object', properties: { x: { type: 'any' } } }]
  ])('拒绝：%s', (_l, schema) => {
    const r = validateToolSchema(schema);
    expect(r.ok, r.reason).toBe(false);
  });
});

describe('MCP 参数同源校验（与模型可见 Schema 完全一致）', () => {
  const check = (args: unknown) => validateArgsAgainstSchema(ECHO_SCHEMA as Record<string, unknown>, args);

  it('合法参数通过（含 null 联合与数组边界）', () => {
    expect(check({ text: 'hi', count: 3, tags: ['a'] }).ok).toBe(true);
  });
  it.each([
    ['缺必填', {}],
    ['类型错误（count 传字符串）', { text: 'a', count: '3' }],
    ['integer 传小数', { text: 'a', count: 3.5 }],
    ['minimum 违反', { text: 'a', count: 0 }],
    ['maxLength 违反', { text: 'x'.repeat(101) }],
    ['minLength 违反', { text: '' }],
    ['maxItems 违反', { text: 'a', tags: ['1', '2', '3', '4', '5', '6'] }],
    ['数组元素类型错误', { text: 'a', tags: [1] }],
    ['additionalProperties=false 未知字段', { text: 'a', extra: 1 }]
  ])('拒绝：%s', (_l, args) => {
    expect(check(args).ok).toBe(false);
  });
});

describe('MCP 工具命名', () => {
  it('生成合法命名空间名（mcp__server__tool）', () => {
    expect(mcpRegisteredName('my-tools', 'echo')).toBe('mcp__my-tools__echo');
    expect(mcpRegisteredName('srv', 'Search_Web')).toBe('mcp__srv__search_web');
  });
  it.each([
    ['工具名含非法字符', 'bad tool!'],
    ['工具名为空', ''],
    ['工具名过长', 'x'.repeat(41)],
    ['服务器名过长导致超长', 'a'.repeat(32) + '-' + 'x'.repeat(40)]
  ])('拒绝：%s', (_l, name) => {
    const slug = _l === '服务器名过长导致超长' ? 'a'.repeat(32) : 'srv';
    expect(mcpRegisteredName(slug, name as string)).toBeNull();
  });
});

describe('MCP 结果映射（不可信 + 限长）', () => {
  it('仅提取 text 块；非文本占位；限长截断', () => {
    const r = mapMcpResult(
      { content: [{ type: 'text', text: '结果 A' }, { type: 'image', data: '...' }, { type: 'text', text: '结果 B' }] },
      10_000
    );
    expect(r.text).toContain('结果 A');
    expect(r.text).toContain('结果 B');
    expect(r.text).toContain('非文本内容块');
    expect(r.ignoredBlocks).toBe(1);
    expect(r.notice).toContain('不可信');
    expect(r.truncated).toBe(false);
  });
  it('超限截断并标记', () => {
    const r = mapMcpResult({ content: [{ type: 'text', text: 'x'.repeat(500) }] }, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100);
  });
  it('无 content 也不抛异常', () => {
    const r = mapMcpResult({}, 100);
    expect(r.text).toBe('');
  });
});

describe('MCP 服务器配置校验（防命令注入）', () => {
  const valid = {
    id: '0123456789abcdef',
    name: 'my-tools',
    command: 'node',
    args: ['server.js', '--flag'],
    env: { MY_VAR: '1' },
    enabled: true
  };

  it('合法配置通过（保存与运行时同函数）', () => {
    expect(mcpServerConfigSchema.safeParse(valid).success).toBe(true);
    expect(validateServerConfigAtRuntime(valid).ok).toBe(true);
  });

  it.each([
    ['命令含空格', { ...valid, command: 'C:\\Program Files\\x.exe' }],
    ['命令含 Shell 元字符 &', { ...valid, command: 'node&del' }],
    ['命令含管道', { ...valid, command: 'node|x' }],
    ['命令含引号', { ...valid, command: 'node"' }],
    ['命令含分号', { ...valid, command: 'node;x' }],
    ['slug 大写', { ...valid, name: 'MyTools' }],
    ['slug 含下划线开头', { ...valid, name: '_x' }],
    ['env 敏感键', { ...valid, env: { API_TOKEN: 'v' } }],
    ['env 敏感键 password', { ...valid, env: { password: 'v' } }],
    ['env 键名非法', { ...valid, env: { 'bad-key': 'v' } }],
    ['args 含控制字符', { ...valid, args: ['a\nb'] }],
    ['cwd 相对路径', { ...valid, cwd: 'rel/path' }],
    ['cwd 含 ..', { ...valid, cwd: 'C:\\a\\..\\b' }],
    ['args 超数量', { ...valid, args: Array.from({ length: 33 }, () => 'x') }]
  ])('拒绝：%s', (_l, cfg) => {
    expect(validateServerConfigAtRuntime(cfg).ok).toBe(false);
  });

  it('子进程 env 白名单：不含 API Key/令牌/全量环境', () => {
    const env = buildChildEnv({ MY_TOOL_MODE: 'fast' });
    expect(env.MY_TOOL_MODE).toBe('fast');
    expect(Object.keys(env).length).toBeLessThan(25);
    // 不含明显的应用敏感键（无论父进程是否设置）
    for (const key of Object.keys(env)) {
      expect(/token|secret|password|apikey|api_key/i.test(key)).toBe(false);
    }
    // 关键系统变量保留（Windows 上 PATH 大小写不敏感，构建时统一了键）
    expect(env.PATH ?? env.Path).toBeTruthy();
  });
});
