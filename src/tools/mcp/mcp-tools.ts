import { z } from 'zod';
import type { ToolDefinition } from '../registry';
import type { McpCallOptions } from './manager';

/**
 * MCP 工具定义工厂（4.4）：
 * - riskLevel 恒为 external（默认逐次审批；不提供服务器级信任开关）；
 * - 参数校验与模型可见 Schema 同源（jsonSchema 直通 + execute 内同源校验器）；
 * - 描述限长并标注来源；超时/取消经 ctx.signal 逐调用生效。
 */

export function createMcpToolDefinition(input: {
  registeredName: string;
  originalName: string;
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: unknown, opts: McpCallOptions) => Promise<ReturnType<typeof import('./convert').mapMcpResult>>;
  maxResultChars: number;
}): ToolDefinition<Record<string, unknown>> {
  const desc =
    input.description.length > 600
      ? `${input.description.slice(0, 600)}…（描述已截断）`
      : input.description || '（外部 MCP 工具，无描述）';
  const callTimeoutMs = 30_000;
  return {
    name: input.registeredName,
    description: `[MCP 外部工具] ${desc}`,
    riskLevel: 'external',
    timeoutMs: callTimeoutMs + 5_000, // 略高于调用超时，让 SDK 超时先触发并给出更精确的错误
    // Zod 层只做"必须是合法 JSON 对象"的形状约束；实质校验由同源校验器在 call 内执行
    schema: z.record(z.string(), z.unknown()) as unknown as z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>,
    ...(input.inputSchema ? { jsonSchema: input.inputSchema } : {}),
    async execute(args, ctx) {
      const result = await input.call(args, {
        signal: ctx.signal,
        timeoutMs: callTimeoutMs
      });
      return {
        notice: result.notice,
        text: result.text,
        ignoredBlocks: result.ignoredBlocks,
        truncated: result.truncated
      };
    },
    summarize(data) {
      const d = data as { text?: string; truncated?: boolean };
      const head = (d.text ?? '').replace(/\s+/g, ' ').slice(0, 100);
      return `MCP 结果${d.truncated ? '（截断）' : ''}：${head}`;
    }
  };
}
