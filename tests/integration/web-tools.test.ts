import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDefaultRegistry } from '../../src/tools';
import { _activeWebCount } from '../../src/tools/web/web-tools';
import type { DnsLookup } from '../../src/tools/web/guarded-fetch';
import {
  buildService,
  makeTempDir,
  TEST_MODEL_CONFIG,
  toolCall,
  toolResponse,
  until
} from '../helpers';

/**
 * 联网工具集成测试（本地真实 HTTP；搜索适配器为协议一致性验证，未做真实外网调用）。
 */

const closers: Array<() => Promise<void>> = [];
const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ baseUrl: string; requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => new Promise((r) => server.close(() => r())));
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  return { baseUrl: `http://search.local:${port}`, requests };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) fs.rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});
afterAll(async () => {
  await Promise.all(closers.map((c) => c()));
});

describe('web_fetch 工具（注册表层，真实本地抓取）', () => {
  it('正常抓取并提取正文与链接', async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<html><head><title>示例页</title><meta name="description" content="页面描述"></head><body><p>正文内容 ABC</p><a href="/next">下一页</a></body></html>'
      );
    });
    const registry = createDefaultRegistry({ webFetch: { allowPrivateTargets: true, dnsLookup } });
    const { makeCtx } = await import('../helpers');
    const result = await registry.run('web_fetch', JSON.stringify({ url: `${srv.baseUrl}/page` }), makeCtx('/tmp'));
    expect(result.ok).toBe(true);
    const data = result.data as { title?: string; text: string; links: Array<{ href: string }> };
    expect(data.title).toBe('示例页');
    expect(data.text).toContain('正文内容 ABC');
    expect(data.links[0]!.href).toContain('/next');
    expect(result.summary).toContain('HTTP 200');
  });

  it('SSRF 拦截以结构化错误返回模型（生产默认路径）', async () => {
    const srv = await startServer((_req, res) => res.end('should-not-reach'));
    const registry = createDefaultRegistry(); // 生产默认：public-strict
    const { makeCtx } = await import('../helpers');
    // 回环字面地址（默认端口）→ 私网拦截
    const result = await registry.run('web_fetch', JSON.stringify({ url: 'http://127.0.0.1/x' }), makeCtx('/tmp'));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('PRIVATE_TARGET');
    // 自定义端口的本地服务 → 端口策略拦截，请求 0 次
    const r2 = await registry.run('web_fetch', JSON.stringify({ url: `${srv.baseUrl}/x` }), makeCtx('/tmp'));
    expect(r2.error?.message).toContain('PORT_NOT_ALLOWED');
    expect(srv.requests.length).toBe(0);
  });

  it('非法参数（非 URL / 超长）被 Zod 拒绝', async () => {
    const registry = createDefaultRegistry();
    const { makeCtx } = await import('../helpers');
    const r1 = await registry.run('web_fetch', JSON.stringify({ url: '' }), makeCtx('/tmp'));
    expect(r1.error?.code).toBe('INVALID_ARGS');
    const r2 = await registry.run('web_fetch', JSON.stringify({ url: 'x'.repeat(3000) }), makeCtx('/tmp'));
    expect(r2.error?.code).toBe('INVALID_ARGS');
  });

  it('并发信号量：同时发起的联网请求不超过上限', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const srv = await startServer((_req, res) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      setTimeout(() => {
        res.setHeader('Content-Type', 'text/plain');
        res.end('done');
        concurrent -= 1;
      }, 250);
    });
    const registry = createDefaultRegistry({ webFetch: { allowPrivateTargets: true, dnsLookup } });
    const { makeCtx } = await import('../helpers');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        registry.run('web_fetch', JSON.stringify({ url: `${srv.baseUrl}/c${i}` }), makeCtx('/tmp'))
      )
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(_activeWebCount()).toBe(0);
    // 服务端观察到的并发不超过进程级上限（4）
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  }, 15_000);
});

describe('web_search 工具（协议一致性验证，本地伪服务）', () => {
  it('未配置搜索服务 → 结构化错误 SEARCH_NOT_CONFIGURED', async () => {
    const registry = createDefaultRegistry();
    const { makeCtx } = await import('../helpers');
    const result = await registry.run('web_search', JSON.stringify({ query: '测试' }), makeCtx('/tmp'));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('SEARCH_NOT_CONFIGURED');
  });

  it('searxng：按协议请求（q/format 参数），结果映射并限量', async () => {
    const srv = await startServer((req, res) => {
      srv.requests.push({ url: req.url ?? '', headers: req.headers });
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q');
      const format = new URL(req.url ?? '/', 'http://x').searchParams.get('format');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          results: Array.from({ length: 12 }, (_, i) => ({
            title: `结果${i}-${q}`,
            url: `https://site.example/${i}`,
            content: `关于 ${q} 的摘要 ${i}`
          }))
        })
      );
      void format;
    });
    const registry = createDefaultRegistry({
      webSearch: { provider: 'searxng', baseUrl: srv.baseUrl, apiKey: () => null, runtime: { allowPrivateTargets: true, dnsLookup } }
    });
    const { makeCtx } = await import('../helpers');
    const result = await registry.run('web_search', JSON.stringify({ query: 'hello 世界', maxResults: 5 }), makeCtx('/tmp'));
    expect(result.ok).toBe(true);
    const data = result.data as { count: number; results: Array<{ title: string; url: string; snippet: string }> };
    expect(data.count).toBe(5);
    expect(data.results[0]!.title).toContain('hello 世界');
    expect(srv.requests[0]!.url).toContain('q=hello');
    expect(srv.requests[0]!.url).toContain('format=json');
  });

  it('brave：密钥只经请求头，绝不出现在 URL；错误消息对回显密钥脱敏', async () => {
    const SECRET = 'BSA-supersecret-123456789';
    const srv = await startServer((req, res) => {
      srv.requests.push({ url: req.url ?? '', headers: req.headers });
      // 服务端恶意回显密钥到错误响应体
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `bad token=${req.headers['x-subscription-token']}` }));
    });
    const registry = createDefaultRegistry({
      webSearch: { provider: 'brave', baseUrl: srv.baseUrl, apiKey: () => SECRET, runtime: { allowPrivateTargets: true, dnsLookup } }
    });
    const { makeCtx } = await import('../helpers');
    const result = await registry.run('web_search', JSON.stringify({ query: 'q' }), makeCtx('/tmp'));
    // 密钥经头传递
    expect(srv.requests[0]!.headers['x-subscription-token']).toBe(SECRET);
    expect(srv.requests[0]!.url).not.toContain(SECRET);
    // 错误消息对回显内容脱敏：密钥不得出现在返回给模型/日志的错误里
    expect(result.ok).toBe(false);
    expect(result.error?.message).not.toContain(SECRET);
    expect(result.error?.message).toContain('SEARCH_HTTP_500');
  });

  it('brave 未提供密钥 → 结构化错误（不发起请求）', async () => {
    const srv = await startServer((_req, res) => res.end('{}'));
    const registry = createDefaultRegistry({
      webSearch: { provider: 'brave', baseUrl: srv.baseUrl, apiKey: () => null, runtime: { allowPrivateTargets: true, dnsLookup } }
    });
    const { makeCtx } = await import('../helpers');
    const result = await registry.run('web_search', JSON.stringify({ query: 'q' }), makeCtx('/tmp'));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('SEARCH_NOT_CONFIGURED');
    expect(srv.requests.length).toBe(0);
  });
});

describe('联网审批（service 集成）', () => {
  it('开启 requireApprovalForWeb：审批被拒 → 请求不执行；审计摘要对 URL 凭据脱敏', async () => {
    const workspace = makeTempDir('wa-web-appr-');
    cleanupDirs.push(workspace);
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('should-not-reach');
    });
    const built = buildService({
      workspace,
      settings: { requireApprovalForWeb: true },
      steps: [
        () => toolResponse('', [toolCall('web_fetch', { url: `${srv.baseUrl}/page?token=secret-token-987654321` })]),
        (req) => {
          const toolMsg = req.messages.find((m) => m.role === 'tool');
          expect(toolMsg!.content).toContain('DENIED_BY_USER');
          return toolResponse('', [toolCall('complete_task', { summary: '被拒', verification: '未联网' })]);
        }
      ]
    });
    const { taskId } = await built.service.startTask({
      goal: '联网审批',
      workspace,
      modelConfig: TEST_MODEL_CONFIG
    });
    const req = await until(() => built.events.find((e) => e.type === 'approval_required'));
    expect(String((req.data as { toolName: string }).toolName)).toBe('web_fetch');
    built.service.resolveApproval(String((req.data as { actionId: string }).actionId), false);

    const report = await built.service.waitForTask(taskId);
    expect(report.status).toBe('completed'); // 模型汇报被拒后收尾
    // 请求从未发出
    expect(srv.requests.length).toBe(0);
    // 审计记录中的 URL 已脱敏（token 凭据不落日志）
    const call = built.store.listToolCalls(taskId).find((c) => c.name === 'web_fetch')!;
    expect(call.argsSummary).not.toContain('secret-token-987654321');
    expect(call.argsSummary).toContain('REDACTED');
  });
});
