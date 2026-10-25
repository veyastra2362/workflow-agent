import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本地 Mock OpenAI 兼容模型服务（仅监听 127.0.0.1，随机端口）。
 * 返回确定性 tool_calls / content 序列，支持可控延迟与阻塞（测试取消/审批等待）。
 */

export interface MockStep {
  /** 返回的 tool_calls（可选） */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** 返回的纯文本内容（可选） */
  content?: string;
  /** 延迟（毫秒），0 = 不延迟 */
  delayMs?: number;
  /** 阻塞直到 unblock() 被调用（用于测试取消） */
  block?: boolean;
}

export interface MockModelServer {
  url: string;
  port: number;
  /** 设置响应序列（每次收到请求弹出下一个） */
  setSteps: (steps: MockStep[]) => void;
  /** 解除当前阻塞 */
  unblock: () => void;
  /** 已收到的请求记录（用于验证模型收到了什么） */
  requests: Array<{ body: unknown; ts: number }>;
  close: () => Promise<void>;
}

export async function startMockModelServer(): Promise<MockModelServer> {
  const requests: Array<{ body: unknown; ts: number }> = [];
  let steps: MockStep[] = [];
  let resolvers: Array<() => void> = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      try { requests.push({ body: JSON.parse(body), ts: Date.now() }); } catch { requests.push({ body, ts: Date.now() }); }

      const step = steps.shift() ?? { content: '（序列耗尽，返回默认文本）' };
      const send = (): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: step.content ?? null,
                  ...(step.toolCalls?.length
                    ? {
                        tool_calls: step.toolCalls.map((tc) => ({
                          id: tc.id,
                          type: 'function',
                          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                        }))
                      }
                    : {})
                },
                finish_reason: step.toolCalls?.length ? 'tool_calls' : 'stop'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          })
        );
      };

      if (step.block) {
        resolvers.push(send);
      } else if (step.delayMs) {
        setTimeout(send, step.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    setSteps: (s) => { steps = s; },
    unblock: () => {
      const r = resolvers;
      resolvers = [];
      r.forEach((fn) => fn());
    },
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
