import { z } from 'zod';

/**
 * MCP 服务器配置校验（4.4，要求 2：stdio 命令注入防护）。
 * 同一份规则在两处执行：设置保存时（IPC 层）与每次建立连接前（运行时）——
 * 保存时的确认不能代替运行时限制。
 *
 * - command 与 args 分开配置、由 SDK 数组式 spawn（不经 Shell 拼接）；
 *   command 额外约束为"路径式 token"（无空白与 Shell 元字符），杜绝 Windows
 *   cmd 包装场景下的注入面；
 * - env 键值强约束，且禁止敏感键名（密钥不得明文进 settings.json，应走内存 SecretStore）；
 * - cwd 必须绝对路径且无 `..` 段。
 */

export const MCP_SERVER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COMMAND_RE = /^[A-Za-z0-9_\-./\\:]{1,260}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE = /(token|secret|password|passwd|credential|authorization|api[-_]?key|private[-_]?key)/i;

export const mcpServerConfigSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().regex(MCP_SERVER_SLUG_RE, '服务器名称必须是 ^[a-z0-9][a-z0-9-]{0,31}$ 的小写 slug'),
    command: z.string().min(1).max(260),
    args: z.array(z.string().min(1).max(1000)).max(32),
    env: z.record(z.string().min(0).max(2000)),
    cwd: z.string().max(500).optional(),
    enabled: z.boolean()
  })
  .superRefine((cfg, ctx) => {
    if (!COMMAND_RE.test(cfg.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'command 只允许字母/数字/_-. /\\:（路径式 token）：不得含空格、引号或 Shell 元字符'
      });
    }
    if (/[\0\n\r]/.test(cfg.command)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'command 含控制字符' });
    }
    for (const [i, a] of cfg.args.entries()) {
      if (/[\0\n\r]/.test(a)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['args', i], message: '参数含控制字符' });
      }
    }
    if (Object.keys(cfg.env).length > 16) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['env'], message: '环境变量最多 16 项' });
    }
    for (const [k, v] of Object.entries(cfg.env)) {
      if (!ENV_KEY_RE.test(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['env', k], message: '环境变量名非法' });
      }
      if (SENSITIVE_ENV_KEY_RE.test(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['env', k],
          message: '禁止在配置文件中保存疑似密钥的环境变量（请勿明文持久化敏感值）'
        });
      }
      if (v.length > 2000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['env', k], message: '环境变量值过长' });
      }
    }
    if (cfg.cwd !== undefined) {
      const isAbs = /^[A-Za-z]:[\\/]/.test(cfg.cwd) || cfg.cwd.startsWith('/');
      const hasTraversal = cfg.cwd.split(/[\\/]/).includes('..');
      if (!isAbs || hasTraversal) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cwd'], message: 'cwd 必须是绝对路径且不含 .. 段' });
      }
    }
  });

export type McpServerConfigRaw = z.infer<typeof mcpServerConfigSchema>;

/** 运行时再校验（连接建立前必经；与保存校验同源） */
export function validateServerConfigAtRuntime(input: unknown): { ok: true; value: McpServerConfigRaw } | { ok: false; reason: string } {
  const parsed = mcpServerConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: parsed.data };
}

/**
 * 构建子进程环境：仅系统白名单 + 用户配置的静态键。
 * 绝不转发 process.env 全量、API Key、SecretStore 或任何应用配置。
 */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'COMSPEC',
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'OS',
  'LANG',
  'HOME',
  'TMPDIR',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE'
];

export function buildChildEnv(userEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) lower.set(k.toLowerCase(), v);
  }
  for (const key of CHILD_ENV_ALLOWLIST) {
    const v = lower.get(key.toLowerCase());
    if (v !== undefined) out[key] = v;
  }
  // 用户显式配置覆盖（已在配置校验中排除敏感键名与非法键名）
  for (const [k, v] of Object.entries(userEnv)) {
    out[k] = v;
  }
  return out;
}
