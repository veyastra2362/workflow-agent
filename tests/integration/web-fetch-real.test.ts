import { afterAll, afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { guardedFetch, WebFetchError, type DnsLookup } from '../../src/tools/web/guarded-fetch';

/**
 * 真实本地网络测试：请求经真实 socket 完成（非 mock）。
 * 私网访问例外由「user-configured 显式配置 + dnsLookup 注入」只在测试中开启；
 * 生产默认路径（public-strict）不继承该例外。
 */

interface TestServer {
  url: (path?: string) => string;
  port: number;
  hits: { path: string; host: string; headers: http.IncomingHttpHeaders }[];
  close: () => Promise<void>;
}

const servers: Array<() => Promise<void>> = [];
let seq = 0;

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  servers.push(() => new Promise((r) => server.close(() => r())));
  const hits: TestServer['hits'] = [];
  seq += 1;
  return {
    port,
    hits,
    url: (path = '/') => `http://unit-host-${seq}.test:${port}${path}`,
    close: () => new Promise((r) => server.close(() => r()))
  };
}

/** 测试模式：私网目标经显式 user-configured 策略放行，并把主机名解析固定到本机 */
function testDnsLookup(ip = '127.0.0.1'): DnsLookup {
  return async (host) => {
    void host;
    return [{ address: ip, family: 4 }];
  };
}

/** 真实抓取：经 dnsLookup 注入 + user-configured（仅测试） */
function realFetch(url: string, opts: Partial<Parameters<typeof guardedFetch>[0]> = {}) {
  return guardedFetch({
    url,
    targetPolicy: 'user-configured',
    dnsLookup: testDnsLookup(),
    timeoutMs: 4000,
    ...opts
  });
}

afterAll(async () => {
  await Promise.all(servers.map((close) => close()));
});

async function expectErr(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WebFetchError);
    expect((err as WebFetchError).code, `期望 ${code}，实际 ${(err as WebFetchError).code}`).toBe(code);
    return;
  }
  throw new Error(`期望 WebFetchError(${code})，但成功返回`);
}

describe('真实本地抓取（真实 socket）', () => {
  it('GET 成功：返回状态码/类型/正文，Host 头使用原始域名，路径与查询保留', async () => {
    const srv = await startServer((req, res) => {
      srv.hits.push({ path: req.url ?? '/', host: req.headers.host ?? '', headers: req.headers });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><body>你好世界</body></html>');
    });
    const result = await realFetch(srv.url('/a/b?q=1'));
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toContain('text/html');
    expect(result.body.toString('utf8')).toContain('你好世界');
    expect(result.truncated).toBe(false);
    // Host 头 = 原始主机名（非注入的 IP）
    expect(srv.hits[0]!.host).toBe(srv.url('/a/b?q=1').split('/a/b')[0].replace('http://', ''));
    expect(srv.hits[0]!.path).toBe('/a/b?q=1');
  });

  it('固定 IP 连接（防重绑定）：使用注入的解析结果，不二次解析', async () => {
    const srv = await startServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('ok');
    });
    // 主机名 example-pin.test 公网不可解析；只有注入的 127.0.0.1 能到达服务器
    const result = await realFetch(srv.url('/'));
    expect(result.statusCode).toBe(200);
    // 注入一个无监听的回环地址 → 连接失败（而非回退重新解析主机名）
    await expectErr(
      () =>
        guardedFetch({
          url: srv.url('/'),
          targetPolicy: 'user-configured',
          dnsLookup: testDnsLookup('127.0.0.9'),
          timeoutMs: 1500
        }),
      'CONNECT_FAILED'
    );
  });

  it('代理环境变量不影响直连（node:http 不读代理环境）', async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('direct');
    });
    const prevHttp = process.env.HTTP_PROXY;
    const prevHttps = process.env.HTTPS_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:1/'; // 不可达代理
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1/';
    try {
      const result = await realFetch(srv.url('/'));
      expect(result.body.toString('utf8')).toBe('direct');
    } finally {
      if (prevHttp === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prevHttp;
      if (prevHttps === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prevHttps;
    }
  });

  it('重定向链：绝对地址跨服务器跟随 + 相对路径基于当前 URL 解析', async () => {
    const target = await startServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end(`final path=${req.url}`);
    });
    const targetUrl = target.url('/deep/ok');
    const hop = await startServer((req, res) => {
      res.statusCode = 302;
      // 绝对地址重定向到另一台服务器
      res.setHeader('Location', targetUrl);
      res.end();
    });
    const result = await realFetch(hop.url('/red'));
    expect(result.statusCode).toBe(200);
    expect(result.body.toString('utf8')).toContain('final path=/deep/ok');
    expect(result.redirects).toEqual([targetUrl]);

    // 相对路径重定向：基于当前 URL（同服务器）解析
    const single = await startServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('Location', 'landing?x=1'); // 相对路径
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/plain');
      res.end(`landed ${req.url}`);
    });
    const r2 = await realFetch(single.url('/start'));
    expect(r2.statusCode).toBe(200);
    expect(r2.body.toString('utf8')).toContain('landed /landing?x=1');
    expect(r2.finalUrl).toContain('/landing?x=1');
  });

  it('重定向目标校验：指向 ftp scheme 一律拒绝（含 user-configured 模式）', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', 'ftp://evil.test/data');
      res.end();
    });
    await expectErr(() => realFetch(srv.url('/')), 'SCHEME_NOT_ALLOWED');
  });

  it('重定向跳数上限（6 跳 > 5）', async () => {
    const srv = await startServer((req, res) => {
      const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? '0');
      res.statusCode = 302;
      res.setHeader('Location', `/?n=${n + 1}`);
      res.end();
    });
    await expectErr(() => realFetch(srv.url('/?n=0')), 'TOO_MANY_REDIRECTS');
  });

  it('响应大小上限：超限截断并立即断开连接', async () => {
    let clientClosedEarly = false;
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.on('close', () => {
        if (!res.writableEnded) clientClosedEarly = true;
      });
      const chunk = 'x'.repeat(8192);
      let sent = 0;
      const timer = setInterval(() => {
        res.write(chunk);
        sent += chunk.length;
        if (sent > 1024 * 1024) {
          clearInterval(timer);
          res.end();
        }
      }, 5);
      res.on('close', () => clearInterval(timer));
    });
    const startedAt = Date.now();
    const result = await realFetch(srv.url('/'), { maxBytes: 32 * 1024, timeoutMs: 8000 });
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(32 * 1024);
    expect(Date.now() - startedAt).toBeLessThan(3000); // 未等全部 1MB 传完
    await new Promise((r) => setTimeout(r, 300));
    expect(clientClosedEarly).toBe(true); // 服务端观察到客户端提前断开
  }, 10_000);

  it('非文本 Content-Type 拒绝（不下载响应体）', async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await expectErr(() => realFetch(srv.url('/')), 'UNSUPPORTED_CONTENT_TYPE');
  });

  it('压缩响应拒绝（防压缩炸弹：已请求 identity）', async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Encoding', 'gzip');
      res.end(zlib.gzipSync('x'.repeat(100)));
    });
    await expectErr(() => realFetch(srv.url('/')), 'COMPRESSED_CONTENT');
  });

  it('慢速响应头 → 总超时终止', async () => {
    const srv = await startServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('Content-Type', 'text/plain');
        res.end('late');
      }, 5000);
    });
    const startedAt = Date.now();
    await expectErr(() => realFetch(srv.url('/'), { timeoutMs: 600 }), 'TIMEOUT');
    expect(Date.now() - startedAt).toBeLessThan(2500);
  }, 8000);

  it('慢速响应体 + abort → 连接实际断开', async () => {
    let serverSawClose = false;
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.on('close', () => {
        serverSawClose = true;
      });
      let n = 0;
      const timer = setInterval(() => {
        res.write(`chunk-${n}\n`);
        n += 1;
        if (n > 100) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.on('close', () => clearInterval(timer));
    });
    const ac = new AbortController();
    const startedAt = Date.now();
    const p = realFetch(srv.url('/'), { signal: ac.signal, timeoutMs: 30_000 });
    setTimeout(() => ac.abort(), 450);
    await expectErr(async () => {
      await p;
    }, 'ABORTED');
    expect(Date.now() - startedAt).toBeLessThan(2500);
    await new Promise((r) => setTimeout(r, 300));
    expect(serverSawClose).toBe(true); // 服务端确认 socket 已断开
  }, 8000);

  it('超大响应头 → 拒绝（头大小上限）', async () => {
    const srv = await startServer((_req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('X-Big', 'y'.repeat(64 * 1024));
      res.end('ok');
    });
    await expectErr(() => realFetch(srv.url('/'), { timeoutMs: 3000 }), 'HEADER_TOO_LARGE');
  }, 6000);

  it('生产默认路径不继承私网例外：回环 IP（默认端口）被拒 + 非默认端口被拒', async () => {
    const srv = await startServer((_req, res) => {
      res.end('should not reach');
    });
    // 字面回环地址（默认 80 端口）→ 私网拦截
    await expectErr(
      () =>
        guardedFetch({
          url: 'http://127.0.0.1/',
          targetPolicy: 'public-strict',
          timeoutMs: 1000
        }),
      'PRIVATE_TARGET'
    );
    // 自定义端口 → 端口策略拦截（同样到达不了服务器）
    await expectErr(
      () =>
        guardedFetch({
          url: `http://127.0.0.1:${srv.port}/`,
          targetPolicy: 'public-strict',
          timeoutMs: 1000
        }),
      'PORT_NOT_ALLOWED'
    );
    expect(srv.hits.length).toBe(0);
  });
});
