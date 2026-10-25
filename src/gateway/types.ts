/**
 * Model Gateway 统一类型。
 * Agent Core 只依赖这里的统一消息/工具调用格式；
 * 各模型供应商的原生协议（如 OpenAI function calling）由具体 Gateway 实现负责转换。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** assistant 消息上携带的工具调用（统一格式） */
  tool_calls?: UnifiedToolCall[];
  /** role === 'tool' 时对应被应答的 tool_call id */
  tool_call_id?: string;
}

export interface UnifiedToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串，解析交给 Tool Registry 校验 */
  argumentsJson: string;
}

export interface ToolSchemaDef {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools?: ToolSchemaDef[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: UnifiedToolCall[];
  finishReason: string | null;
  usage?: ChatUsage;
}

export interface ModelGateway {
  chat(req: ModelRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export type ModelErrorCode =
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_TIMEOUT'
  | 'MODEL_NETWORK_ERROR'
  | 'MODEL_BAD_RESPONSE'
  | 'MODEL_ABORTED';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly status?: number;
  readonly detail?: string;

  constructor(code: ModelErrorCode, message: string, opts?: { status?: number; detail?: string }) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = opts?.status;
    this.detail = opts?.detail;
  }
}

export function describeModelError(err: unknown): string {
  if (err instanceof ModelError) {
    const status = err.status ? ` HTTP ${err.status}` : '';
    const detail = err.detail ? `: ${err.detail.slice(0, 300)}` : '';
    return `${err.message}${status}${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function isModelAbort(err: unknown): boolean {
  return err instanceof ModelError && err.code === 'MODEL_ABORTED';
}
