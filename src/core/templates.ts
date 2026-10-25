import { z } from 'zod';
import { redactSecrets } from '../policy/redact';
import type { TemplateConstraints, TemplateParam } from '../shared/types';

/**
 * 任务模板：校验、渲染与参数审计（纯函数，无副作用）。
 * - 占位符语法：{{param}}，参数名 [A-Za-z_][A-Za-z0-9_]*；
 * - 渲染为单趟字符串替换：参数值中的 {{ 不会被二次展开；
 * - 参数审计只输出脱敏摘要，不落原始值。
 */

export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function extractPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    found.add(m[1]!);
  }
  return [...found];
}

const MAX_RENDERED_GOAL = 20_000;
const MAX_PARAM_VALUE = 10_000;
export const AUDIT_VALUE_MAX = 60;

const paramSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '参数名只能包含字母、数字与下划线，且以字母或下划线开头')
    .max(64),
  description: z.string().max(500).optional(),
  required: z.boolean(),
  default: z.string().max(2000).optional()
});

export const templateSaveSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  goalTemplate: z.string().min(1).max(20_000),
  acceptanceTemplate: z.string().max(20_000).optional(),
  params: z.array(paramSchema).max(20).default([]),
  constraints: z
    .object({
      maxSteps: z.number().int().min(1).max(200).optional(),
      taskTimeoutMs: z.number().int().min(10_000).max(6 * 60 * 60_000).optional(),
      allowedTools: z
        .array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/))
        .max(50)
        .optional()
    })
    .default({})
});

export type TemplateSaveParsed = {
  id?: string;
  name: string;
  description: string;
  goalTemplate: string;
  acceptanceTemplate?: string;
  params: TemplateParam[];
  constraints: TemplateConstraints;
};

export type ValidateResult =
  | { ok: true; value: TemplateSaveParsed }
  | { ok: false; issues: string[] };

/**
 * 保存前强校验：Schema、占位符已声明、参数名唯一、约束内工具存在。
 * knownTools 为当前注册表的工具名集合。
 */
export function validateTemplate(input: unknown, knownTools: readonly string[]): ValidateResult {
  const parsed = templateSaveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    };
  }
  const v = parsed.data;
  const issues: string[] = [];

  const names = new Set<string>();
  for (const p of v.params) {
    if (names.has(p.name)) issues.push(`参数名重复：${p.name}`);
    names.add(p.name);
  }

  const declaredPlaceholders = extractPlaceholders(
    `${v.goalTemplate}\n${v.acceptanceTemplate ?? ''}`
  );
  for (const ph of declaredPlaceholders) {
    if (!names.has(ph)) {
      issues.push(`目标/验收中的占位符 {{${ph}}} 未在参数列表中声明`);
    }
  }

  const known = new Set(knownTools);
  for (const t of v.constraints.allowedTools ?? []) {
    if (!known.has(t)) issues.push(`allowedTools 中的工具 "${t}" 不存在`);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: v as TemplateSaveParsed };
}

export type RenderResult =
  | { ok: true; goal: string; acceptance?: string }
  | { ok: false; errors: string[] };

/** 渲染模板：缺必填参数报错；默认值生效；单趟替换；长度上限沿用任务目标限制。 */
export function renderTemplate(
  template: { goalTemplate: string; acceptanceTemplate?: string; params: TemplateParam[] },
  values: Record<string, string>
): RenderResult {
  const valueMap = new Map<string, string>();
  const errors: string[] = [];
  for (const p of template.params) {
    const raw = values[p.name] ?? p.default;
    if (raw === undefined || String(raw).length === 0) {
      if (p.required) errors.push(`缺少必填参数：${p.name}${p.description ? `（${p.description}）` : ''}`);
      continue;
    }
    const val = String(raw);
    if (val.length > MAX_PARAM_VALUE) {
      errors.push(`参数 ${p.name} 过长（${val.length} > ${MAX_PARAM_VALUE} 字符）`);
      continue;
    }
    valueMap.set(p.name, val);
  }
  if (errors.length > 0) return { ok: false, errors };

  const substitute = (text: string): string =>
    text.replace(PLACEHOLDER_RE, (match, name: string) =>
      valueMap.has(name) ? valueMap.get(name)! : match
    );

  const goal = substitute(template.goalTemplate);
  if (goal.length > MAX_RENDERED_GOAL) {
    return { ok: false, errors: [`渲染后的任务目标过长（${goal.length} > ${MAX_RENDERED_GOAL} 字符）`] };
  }
  const acceptance = template.acceptanceTemplate
    ? substitute(template.acceptanceTemplate)
    : undefined;
  return { ok: true, goal, acceptance: acceptance || undefined };
}

/**
 * 参数审计：只记录参数名与脱敏摘要（截断），不落原始值。
 * 渲染结果本身按任务持久化策略存于 tasks.goal，不进事件日志原文。
 */
export function auditParamValues(
  params: TemplateParam[],
  values: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const raw = values[p.name] ?? p.default ?? '';
    let summary = redactSecrets(String(raw));
    if (summary.length > AUDIT_VALUE_MAX) {
      summary = `${summary.slice(0, AUDIT_VALUE_MAX)}…（已截断，共 ${String(raw).length} 字符）`;
    }
    out[p.name] = summary;
  }
  return out;
}
