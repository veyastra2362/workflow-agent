import { sseDataEvents } from './sse';
import {
  type ChatResponse,
  type ChatMessage,
  type ModelGateway,
  type ModelRequest,
  type UnifiedToolCall,
  ModelError,
  isModelAbort
} from './types';

/**
 * OpenAI 兼容 Model Gateway。
 * - 统一将模型原生 function calling 格式转换为 UnifiedToolCall；
 * - 支持流式（SSE）与非流式两种响应；
 * - 处理超时、网络错误、HTTP 错误、一次自动重试（仅限幂等安全的可重试错误）。
 */

export interface GatewayOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** 统一消息 → OpenAI Chat Completions 线上格式 */
export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argumentsJson }
        }))
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: m.tool_call_id ?? ''
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** 流式增量累积（导出便于单元测试） */
export function createStreamAccumulator() {
  let content = '';
  const calls: UnifiedToolCall[] = [];
  let finishReason: string | null = null;
  return {
    consume(delta: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    }): void {
      const choice = delta.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta;
      if (!d) return;
      if (typeof d.content === 'string') content += d.content;
      for (const tc of d.tool_calls ?? []) {
        const index = tc.index ?? 0;
        let entry = calls[index];
        if (!entry) {
          entry = { id: '', name: '', argumentsJson: '' };
          calls[index] = entry;
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.argumentsJson += tc.function.arguments;
      }
    },
    result(): ChatResponse {
      return {
        content: content.length ? content : null,
        toolCalls: calls.filter((c) => c && (c.name || c.argumentsJson)),
        finishReason,
        usage: undefined
      };
    }
  };
}

interface OpenAIChatJson {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

function normalizeToolCalls(raw: OpenAIChatJson): UnifiedToolCall[] {
  const message = raw.choices?.[0]?.message;
  if (!message?.tool_calls?.length) return [];
  return message.tool_calls.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? '',
    argumentsJson: tc.function?.arguments ?? '{}'
  }));
}

export class OpenAICompatGateway implements ModelGateway {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GatewayOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前运行环境缺少 fetch 实现');
    }
  }

  private endpoint(): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  }

  async chat(req: ModelRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const maxRetries = this.opts.maxRetries ?? 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.attemptOnce(req, signal);
      } catch (err) {
        lastErr = err;
        if (isModelAbort(err)) throw err;
        if (signal?.aborted) {
          throw new ModelError('MODEL_ABORTED', '请求已被取消');
        }
        const retryable =
          err instanceof ModelError &&
          (err.code === 'MODEL_NETWORK_ERROR' ||
            err.code === 'MODEL_TIMEOUT' ||
            (err.code === 'MODEL_HTTP_ERROR' && (err.status === 429 || (err.status ?? 0) >= 500)));
        if (!retryable || attempt === maxRetries) throw err;
        await sleep(1200 * (attempt + 1), signal);
      }
    }
    throw lastErr; // 理论上不可达
  }

  private async attemptOnce(req: ModelRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new ModelError('MODEL_ABORTED', '请求已被取消');
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = {
        model: this.opts.model,
        messages: toWireMessages(req.messages),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parametersJsonSchema
                }
              }))
            }
          : {}),
        temperature: req.temperature ?? this.opts.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? this.opts.maxTokens ?? 4096,
        stream: this.opts.streaming ?? false
      };

      const res = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ModelError('MODEL_HTTP_ERROR', `模型 API 返回错误`, {
          status: res.status,
          detail: text.slice(0, 2000)
        });
      }

      if (this.opts.streaming) {
        if (!res.body) {
          throw new ModelError('MODEL_BAD_RESPONSE', '流式响应缺少 body');
        }
        const acc = createStreamAccumulator();
        try {
          for await (const payload of sseDataEvents(res.body, signal)) {
            try {
              acc.consume(JSON.parse(payload));
            } catch {
              // 单条事件 JSON 损坏 —— 跳过，不中断整个流
            }
          }
        } catch (err) {
          if (controller.signal.aborted && !signal?.aborted) {
            throw new ModelError('MODEL_TIMEOUT', `模型响应超时（${timeoutMs}ms）`);
          }
          if (signal?.aborted) throw new ModelError('MODEL_ABORTED', '请求已被取消');
          if (err instanceof Error && err.message === 'SSE_ABORTED') {
            throw new ModelError('MODEL_ABORTED', '请求已被取消');
          }
          throw new ModelError('MODEL_NETWORK_ERROR', `流式读取失败: ${String(err)}`);
        }
        return acc.result();
      }

      const json = (await res.json()) as OpenAIChatJson;
      if (json.error) {
        const msg = typeof json.error === 'string' ? json.error : json.error.message ?? '未知错误';
        throw new ModelError('MODEL_BAD_RESPONSE', `模型 API 返回 error 字段: ${msg}`);
      }
      const choice = json.choices?.[0];
      if (!choice) {
        throw new ModelError('MODEL_BAD_RESPONSE', '响应缺少 choices 字段');
      }
      return {
        content: choice.message?.content ?? null,
        toolCalls: normalizeToolCalls(json),
        finishReason: choice.finish_reason ?? null,
        usage: json.usage
          ? {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens
            }
          : undefined
      };
    } catch (err) {
      if (err instanceof ModelError) throw err;
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        if (signal?.aborted) throw new ModelError('MODEL_ABORTED', '请求已被取消');
        throw new ModelError('MODEL_TIMEOUT', `模型响应超时（${timeoutMs}ms）`);
      }
      throw new ModelError('MODEL_NETWORK_ERROR', `网络错误: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new ModelError('MODEL_ABORTED', '请求已被取消'));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
