/**
 * 敏感信息脱敏：日志、事件、审批摘要中的密钥在写入前必须经过这里。
 */

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // 常见 API Key 形态：sk-xxx、gsk_xxx、AIza... 等
  { name: 'api_key', re: /\b(sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g },
  { name: 'api_key', re: /\b(gsk|sk-ant|sk-or)-[A-Za-z0-9_-]{10,}\b/g },
  // key=value 形式的凭据字段（兼容 JSON 键名带引号的写法）
  {
    name: 'credential',
    re: /\b(api[-_]?key|authorization|x-api-key|secret|password|token)\b["']?\s*[:=]\s*["']?[^\s"',;\\]{8,}/gi
  },
  // Bearer / Authorization 头
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi }
];

const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'secret',
  'password',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token'
]);

export function redactSecrets(input: string): string {
  let out = input;
  for (const { name, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

/** 深度遍历对象，对字符串值做模式脱敏，对敏感键名整值抹除。 */
export function redactValue(value: unknown, maxDepth = 6): unknown {
  if (maxDepth <= 0) return '[depth-limit]';
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, maxDepth - 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED:key]';
    } else {
      out[k] = redactValue(v, maxDepth - 1);
    }
  }
  return out;
}

export function redactJson(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(redactValue(value)));
  } catch {
    return '[unserializable]';
  }
}
