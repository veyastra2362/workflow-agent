import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { RiskLevel } from '../policy/policy';
import { PolicyViolationError } from '../policy/paths';
import type { ToolSchemaDef } from '../gateway/types';

/**
 * Tool Registry：统一工具协议。
 * - 每个工具声明：名称、描述、Zod Schema、风险等级、超时、执行函数、结果摘要函数；
 * - run() 负责：JSON 解析 → Zod 严格校验 → 取消检查 → 超时控制 → 异常归一化 →
 *   输出长度截断 → 结构化结果（成功数据或结构化错误），供 Agent Loop 回填给模型。
 */

export interface FileChangeNotification {
  path: string;
  kind: 'create' | 'modify';
  backupContent: string | null;
}

export interface ToolContext {
  workspace: string;
  taskId: string;
  signal: AbortSignal;
  cancellationToken: { readonly cancelled: boolean };
  now(): number;
  /** 写入类工具在修改前调用：登记变更与修改前内容备份 */
  recordFileChange(rec: FileChangeNotification): void;
  /** 读取本任务此前记录的变更列表（去重后） */
  getRecordedChanges(): Array<{ path: string; kind: 'create' | 'modify' }>;
  /** 读取某个相对路径的修改前备份内容 */
  readBackup(relPath: string): string | null;
  /**
   * 工具内审批通道（直通现有审批管道：落库/事件/UI/超时与取消解除）。
   * 浏览器等动态风险工具在副作用前调用；缺失时高风险操作必须按拒绝处理（fail-safe）。
   */
  requestApproval?(payload: { toolName: string; argsSummary: string; reason: string }): Promise<boolean>;
}

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  timeoutMs: number;
  /** Zod schema；I 为解析后的输出类型（输入允许含 default 的宽松形态） */
  schema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /**
   * 可选：模型可见的参数 JSON Schema（与本地校验同源时使用，如 MCP 工具）。
   * 提供时 toModelTools 直接使用它；未提供时由 Zod 转换生成。
   */
  jsonSchema?: Record<string, unknown>;
  execute(args: I, ctx: ToolContext): Promise<unknown>;
  summarize?: (data: unknown) => string;
}

export interface ToolError {
  code: string;
  message: string;
  issues?: unknown;
}

export interface ToolRunResult {
  ok: boolean;
  data?: unknown;
  error?: ToolError;
  summary: string;
  durationMs: number;
  truncated: boolean;
}

class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number
  ) {
    super(`工具 ${toolName} 执行超时（${timeoutMs}ms）`);
    this.name = 'ToolTimeoutError';
  }
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

// 注册表内部使用 any：具体工具注册时仍由 ToolDefinition<I> 泛型在编译期校验
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

export class ToolRegistry {
  private readonly defs = new Map<string, AnyToolDefinition>();

  register(def: AnyToolDefinition): void {
    if (!TOOL_NAME_RE.test(def.name)) {
      throw new Error(`非法工具名: ${def.name}`);
    }
    if (this.defs.has(def.name)) {
      throw new Error(`工具重复注册: ${def.name}`);
    }
    this.defs.set(def.name, def);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.defs.get(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.defs.values()];
  }

  /**
   * 工具子集：模型端（toModelTools）与执行端（run → UNKNOWN_TOOL）同时受限。
   * complete_task 始终保留 —— 否则任务无法正常宣告结束；
   * 但它仍走完整策略/门控流程，不因此绕过其他安全检查。
   * 未知名称忽略（调用方在保存模板时已校验；运行时静默收紧并记日志）。
   */
  subset(names: readonly string[]): ToolRegistry {
    const allowed = new Set(names);
    allowed.add('complete_task');
    const sub = new ToolRegistry();
    for (const def of this.defs.values()) {
      if (allowed.has(def.name)) sub.register(def);
    }
    return sub;
  }

  /** 转换为模型侧工具声明（OpenAI function calling JSON Schema） */
  toModelTools(): ToolSchemaDef[] {
    return this.list().map((d) => ({
      name: d.name,
      description: d.description,
      parametersJsonSchema:
        d.jsonSchema ??
        (zodToJsonSchema(d.schema as z.ZodTypeAny, {
          $refStrategy: 'none',
          target: 'openAi'
        }) as Record<string, unknown>)
    }));
  }

  async run(
    name: string,
    rawArgsJson: string,
    ctx: ToolContext,
    opts: { maxResultChars?: number } = {}
  ): Promise<ToolRunResult> {
    const startedAt = ctx.now();
    const maxChars = opts.maxResultChars ?? 20_000;
    const fail = (error: ToolError, data?: unknown): ToolRunResult => ({
      ok: false,
      error,
      data,
      summary: `${error.code}: ${error.message.slice(0, 160)}`,
      durationMs: ctx.now() - startedAt,
      truncated: false
    });

    const def = this.defs.get(name);
    if (!def) {
      return fail({
        code: 'UNKNOWN_TOOL',
        message: `未知工具 "${name}"，可用工具: ${[...this.defs.keys()].join(', ')}`
      });
    }

    let parsed: unknown;
    try {
      parsed = rawArgsJson.trim() === '' ? {} : JSON.parse(rawArgsJson);
    } catch (err) {
      return fail({
        code: 'INVALID_ARGS',
        message: `工具参数不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`
      });
    }

    const check = def.schema.safeParse(parsed);
    if (!check.success) {
      return fail({
        code: 'INVALID_ARGS',
        message: '工具参数未通过 Schema 校验',
        issues: check.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      });
    }

    if (ctx.cancellationToken.cancelled) {
      return fail({ code: 'CANCELLED', message: '任务已取消，工具未执行' });
    }

    try {
      const execPromise = Promise.resolve(def.execute(check.data as never, ctx));
      // 超时竞速；确保迟到的原始 Promise 拒绝不会变成 unhandled rejection
      execPromise.catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const data = await Promise.race([
        execPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ToolTimeoutError(name, def.timeoutMs)), def.timeoutMs);
          timer.unref?.();
        })
      ]);
      if (timer) clearTimeout(timer);
      const { out, truncated } = truncateData(data, maxChars);
      return {
        ok: true,
        data: out,
        summary: def.summarize ? def.summarize(out) : genericSummary(out),
        durationMs: ctx.now() - startedAt,
        truncated
      };
    } catch (err) {
      if (err instanceof ToolTimeoutError) {
        return fail({ code: 'TIMEOUT', message: err.message });
      }
      if (err instanceof PolicyViolationError) {
        return fail({ code: 'POLICY_VIOLATION', message: err.message, issues: err.detail });
      }
      return fail({
        code: 'EXECUTION_FAILED',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

export function truncateData(data: unknown, maxChars: number): { out: unknown; truncated: boolean } {
  if (typeof data === 'string') {
    if (data.length <= maxChars) return { out: data, truncated: false };
    return { out: `${data.slice(0, maxChars)}\n…[输出已截断，原始长度 ${data.length} 字符]`, truncated: true };
  }
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { out: String(data), truncated: false };
  }
  if (json.length <= maxChars) return { out: data, truncated: false };
  return {
    out: {
      truncated: true,
      note: `结果超过 ${maxChars} 字符上限，已被截断；请缩小查询范围或分批读取`,
      preview: json.slice(0, maxChars)
    },
    truncated: true
  };
}

export function genericSummary(data: unknown): string {
  if (data === null || data === undefined) return '（空结果）';
  if (typeof data === 'string') return data.slice(0, 160);
  if (Array.isArray(data)) return `${data.length} 项`;
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, 6).join(', ');
    return `{${keys}}`;
  }
  return String(data).slice(0, 160);
}
