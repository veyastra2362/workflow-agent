import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { guardedFetch, validateUrl, WebFetchError, type DnsLookup } from '../../src/tools/web/guarded-fetch';

async function expectFetchError(
  fn: () => Promise<unknown>,
  code: string
): Promise<WebFetchError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WebFetchError);
    const e = err as WebFetchError;
    expect(e.code, `期望 ${code}，实际 ${e.code}: ${e.message}`).toBe(code);
    return e;
  }
  throw new Error(`期望抛出 WebFetchError(${code})，但成功返回`);
}

describe('SSRF：URL 校验矩阵（不发起任何网络请求）', () => {
  const blocked: Array<[string, string]> = [
    ['file:///etc/passwd', 'SCHEME_NOT_ALLOWED'],
    ['ftp://example.com/x', 'SCHEME_NOT_ALLOWED'],
    ['data:text/html,hi', 'SCHEME_NOT_ALLOWED'],
    ['gopher://example.com', 'SCHEME_NOT_ALLOWED'],
    ['http://user:pass@example.com/', 'CREDENTIALS_IN_URL'],
    ['http://example.com:8080/', 'PORT_NOT_ALLOWED'],
    ['https://example.com:8443/', 'PORT_NOT_ALLOWED'],
    ['http://example.com:443/', 'PORT_NOT_ALLOWED'], // 跨 scheme 端口同样拒绝
    ['http://example.com/ x', 'INVALID_URL'],
    ['http://exa\nmple.com/', 'INVALID_URL'],
    ['http://exa\u0000mple.com/', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    ['', 'INVALID_URL']
  ];
  for (const [url, code] of blocked) {
    it(`拒绝 ${JSON.stringify(url)} → ${code}`, () => {
      expect(() => validateUrl(url, 'public-strict')).toThrowError(WebFetchError);
      void expectFetchError(() => guardedFetch({ url, timeoutMs: 500 }), code);
    });
  }

  it('异常 IPv4 编码形式归一化后仍被私网检查拦截', async () => {
    // URL 解析器会把十六进制/八进制/十进制 IPv4 归一化为点分形式
    for (const u of ['http://0x7f000001/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://3232235777/']) {
      await expectFetchError(() => guardedFetch({ url: u, timeoutMs: 500 }), 'PRIVATE_TARGET');
    }
  });

  it('尾随点域名归一化：回环仍被拦截', async () => {
    await expectFetchError(() => guardedFetch({ url: 'http://127.0.0.1./' }), 'PRIVATE_TARGET');
    const v = validateUrl('http://example.com./path', 'public-strict');
    expect(v.host).toBe('example.com');
  });

  it('合法 URL 通过校验（不连接）', () => {
    const v = validateUrl('https://example.com/a/b?q=1', 'public-strict');
    expect(v.host).toBe('example.com');
    expect(v.port).toBe(443);
    expect(v.isHttps).toBe(true);
    expect(validateUrl('http://example.com:80/x', 'public-strict').port).toBe(80);
  });

  it('user-configured 模式允许自定义端口（用户显式配置的端点）', () => {
    const v = validateUrl('http://127.0.0.1:8080/search', 'user-configured');
    expect(v.port).toBe(8080);
  });
});

describe('SSRF：DNS 结果校验（注入解析器，模拟 DNS）', () => {
  const lookup = (addresses: string[]): DnsLookup => async () =>
    addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));

  it('解析结果为私网地址 → 拒绝（无任何连接）', async () => {
    await expectFetchError(
      () => guardedFetch({ url: 'http://host.test/x', dnsLookup: lookup(['10.0.0.7']), timeoutMs: 1000 }),
      'PRIVATE_TARGET'
    );
  });

  it('混合公私解析结果 → 整体拒绝（防绕过）', async () => {
    await expectFetchError(
      () => guardedFetch({ url: 'http://host.test/x', dnsLookup: lookup(['1.1.1.1', '192.168.0.9']), timeoutMs: 1000 }),
      'PRIVATE_TARGET'
    );
    await expectFetchError(
      () => guardedFetch({ url: 'http://host.test/x', dnsLookup: lookup(['2606:4700::1111', 'fd00::5']), timeoutMs: 1000 }),
      'PRIVATE_TARGET'
    );
  });

  it('解析结果为 IPv4-mapped 私网 → 拒绝', async () => {
    await expectFetchError(
      () => guardedFetch({ url: 'http://host.test/x', dnsLookup: lookup(['::ffff:10.1.2.3']), timeoutMs: 1000 }),
      'PRIVATE_TARGET'
    );
  });

  it('DNS 查询超时 → DNS_TIMEOUT', async () => {
    await expectFetchError(
      () =>
        guardedFetch({
          url: 'http://slow-dns.test/x',
          dnsLookup: () => new Promise(() => undefined), // 永不返回
          dnsTimeoutMs: 150,
          timeoutMs: 5000
        }),
      'DNS_TIMEOUT'
    );
  }, 4000);

  it('DNS 查询期间取消 → ABORTED', async () => {
    const ac = new AbortController();
    const p = guardedFetch({
      url: 'http://abort-dns.test/x',
      dnsLookup: () => new Promise(() => undefined),
      dnsTimeoutMs: 5000,
      signal: ac.signal
    });
    setTimeout(() => ac.abort(), 100);
    await expectFetchError(async () => {
      await p;
    }, 'ABORTED');
  }, 4000);

  it('DNS 失败 → DNS_FAILED', async () => {
    await expectFetchError(
      () =>
        guardedFetch({
          url: 'http://nx.test/x',
          dnsLookup: async () => {
            throw new Error('ENOTFOUND');
          },
          timeoutMs: 1000
        }),
      'DNS_FAILED'
    );
  });
});
