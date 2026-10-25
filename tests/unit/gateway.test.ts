import { afterAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatGateway, createStreamAccumulator, toWireMessages } from '../../src/gateway/openai';
import { ModelError } from '../../src/gateway/types';
import type { ChatMessage } from '../../src/gateway/types';

const servers: Array<{ close: () => Promise<void> }> = [];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  servers.push({ close: () => new Promise((r) => server.close(() => r())) });
  return `http://127.0.0.1:${port}/v1`;
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

function gw(baseUrl: string, opts: Partial<ConstructorParameters<typeof OpenAICompatGateway>[0]> = {}) {
  return new OpenAICompatGateway({
    baseUrl,
    apiKey: 'test-key',
    model: 'test-model',
    ...opts
  });
}

const SIMPLE_SSE = [
  'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
  'data: {"choices":[{"delta":{"content":"lo"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]'
].join('\n\n') + '\n\n';

describe('OpenAICompatGateway', () => {
  it('非流式：解析 tool_calls 与 usage', async () => {
    const url = await startServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 34 }
        })
      );
    });
    const resp = await gw(url, { streaming: false }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.content).toBeNull();
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a.txt"}' });
    expect(resp.finishReason).toBe('tool_calls');
    expect(resp.usage?.promptTokens).toBe(12);
  });

  it('流式：跨 chunk 累积文本与工具调用参数', async () => {
    const url = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(SIMPLE_SSE);
    });
    const resp = await gw(url, { streaming: true }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(resp.content).toBe('Hello');
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0].name).toBe('read_file');
    expect(resp.toolCalls[0].argumentsJson).toBe('{"path":"a.txt"}');
  });

  it('HTTP 401 → MODEL_HTTP_ERROR 且状态码保留', async () => {
    const url = await startServer((_req, res) => {
      res.statusCode = 401;
      res.end('{"error":{"message":"bad key"}}');
    });
    await expect(gw(url, { maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'MODEL_HTTP_ERROR',
      status: 401
    });
  });

  it('响应超时 → MODEL_TIMEOUT', async () => {
    const url = await startServer((_req, res) => {
      setTimeout(() => {
        res.end('{}');
      }, 600);
    });
    await expect(
      gw(url, { maxRetries: 0, timeoutMs: 80 }).chat({ messages: [{ role: 'user', content: 'x' }] })
    ).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  }, 5000);

  it('5xx 自动重试一次后成功', async () => {
    let attempts = 0;
    const url = await startServer((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.statusCode = 500;
        res.end('boom');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
      }
    });
    const resp = await gw(url, { streaming: false }).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(resp.content).toBe('ok');
    expect(attempts).toBe(2);
  }, 10_000);

  it('响应缺少 choices → MODEL_BAD_RESPONSE', async () => {
    const url = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"not":"choices"}');
    });
    await expect(gw(url, { streaming: false }).chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'MODEL_BAD_RESPONSE'
    });
  });

  it('流式中单条损坏事件被跳过，不影响整体', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {broken json\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n';
    const url = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(sse);
    });
    const resp = await gw(url, { streaming: true }).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(resp.content).toBe('AB');
  });

  it('外部取消 → MODEL_ABORTED', async () => {
    const url = await startServer((_req, res) => {
      // 永不结束
    });
    const ac = new AbortController();
    const p = gw(url, { maxRetries: 0 }).chat({ messages: [{ role: 'user', content: 'x' }] }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ code: 'MODEL_ABORTED' });
  }, 5000);

  it('统一消息转换为 OpenAI 线上格式（tool_calls / tool 结果）', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"a":1}' }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }
    ];
    const wire = toWireMessages(messages);
    expect(wire[2]!.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"a":1}' } }
    ]);
    expect(wire[3]).toEqual({ role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' });
  });

  it('createStreamAccumulator 可独立使用', () => {
    const acc = createStreamAccumulator();
    acc.consume({ choices: [{ delta: { content: 'x' } }] });
    acc.consume({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{' } }] } }] });
    acc.consume({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] });
    const r = acc.result();
    expect(r.content).toBe('x');
    expect(r.toolCalls[0]!.argumentsJson).toBe('{}');
  });

  it('ModelError 携带结构化信息', () => {
    const e = new ModelError('MODEL_HTTP_ERROR', 'msg', { status: 429, detail: 'rate limited' });
    expect(e.code).toBe('MODEL_HTTP_ERROR');
    expect(e.status).toBe(429);
  });
});
