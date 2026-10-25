import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { execSync } from 'node:child_process';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { guardedFetch, WebFetchError, type DnsLookup } from '../../src/tools/web/guarded-fetch';

const execAsync = promisify(execCb);

/**
 * 真实 TLS 路径测试：固定 IP + SNI + 证书主机名校验（非配置对象断言）。
 *
 * 方案：openssl 生成 CN/SAN=webtls.test 的自签证书 → 真实 HTTPS 服务器；
 * 正向用例在子进程中以 NODE_EXTRA_CA_CERTS 信任该 CA 后执行真实请求；
 * 服务器记录 TLS SNI 与 Host 头，证明「连接固定 IP、SNI/Host/证书校验均用原始域名」。
 */

let opensslAvailable = true;
try {
  execSync('openssl version', { stdio: 'ignore' });
} catch {
  opensslAvailable = false;
}

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const d = describe.skipIf(!opensslAvailable)('真实 TLS：固定 IP + SNI + 证书校验', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tls-'));
  const GOOD_HOST = 'webtls.test';
  const OTHER_HOST = 'other-name.test';
  let server: https.Server;
  let port = 0;
  const observed: Array<{ sni: string | undefined; host: string }> = [];
  const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];

  beforeAll(() => {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 ` +
        `-subj "/CN=${GOOD_HOST}" -addext "subjectAltName=DNS:${GOOD_HOST}"`,
      { cwd: TMP, stdio: 'ignore' }
    );
    // 子进程脚本：真实执行 guardedFetch（编译自同一源码）
    fs.writeFileSync(
      path.join(TMP, 'child.ts'),
      `import { guardedFetch } from ${JSON.stringify(path.join(PROJECT_ROOT, 'src/tools/web/guarded-fetch'))};
const dns = async () => [{ address: '127.0.0.1', family: 4 }];
guardedFetch({
  url: process.argv[2]!,
  targetPolicy: 'user-configured',
  dnsLookup: dns as never,
  timeoutMs: 5000
})
  .then((r) =>
    console.log('RESULT:' + JSON.stringify({ ok: true, status: r.statusCode, body: r.body.toString('utf8') }))
  )
  .catch((e: Error & { code?: string }) =>
    console.log('RESULT:' + JSON.stringify({ ok: false, code: e.code, message: e.message.slice(0, 200) }))
  );
`
    );
    server = https.createServer(
      {
        key: fs.readFileSync(path.join(TMP, 'key.pem')),
        cert: fs.readFileSync(path.join(TMP, 'cert.pem'))
      },
      (req, res) => {
        const socket = req.socket as tls.TLSSocket;
        const sni = typeof socket.servername === 'string' ? socket.servername : undefined;
        observed.push({ sni, host: req.headers.host ?? '' });
        res.setHeader('Content-Type', 'text/plain');
        res.end(`tls-ok sni=${sni ?? ''}`);
      }
    );
    return new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      })
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  /** 在信任 CA 的子进程中执行真实 TLS 请求（异步 exec：父进程事件循环保持运转以服务请求） */
  async function fetchViaTrustedChild(
    url: string
  ): Promise<{ ok: boolean; status?: number; body?: string; code?: string; message?: string }> {
    const { stdout } = await execAsync(`npx tsx "${path.join(TMP, 'child.ts')}" "${url}"`, {
      cwd: PROJECT_ROOT,
      timeout: 90_000,
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: path.join(TMP, 'cert.pem')
      },
      maxBuffer: 10 * 1024 * 1024
    });
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
    if (!line) throw new Error(`子进程无输出：${stdout.slice(0, 300)}`);
    return JSON.parse(line.slice('RESULT:'.length));
  }

  it('不信任 CA 的进程内请求 → TLS_ERROR（证明证书校验未关闭）', async () => {
    try {
      await guardedFetch({
        url: `https://${GOOD_HOST}:${port}/`,
        targetPolicy: 'user-configured',
        dnsLookup,
        timeoutMs: 4000
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WebFetchError);
      const e = err as WebFetchError;
      expect(e.code).toBe('TLS_ERROR');
      expect(e.message).toMatch(/certificate|SSL|TLS|SELF.?SIGNED/i);
      return;
    }
    throw new Error('证书校验未生效（可能被关闭）');
  });

  it('受信 CA 子进程：固定 IP 连接成功，SNI 与 Host 头均为原始域名', async () => {
    const result = await fetchViaTrustedChild(`https://${GOOD_HOST}:${port}/page?q=1`);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain('tls-ok');
    // 服务器观察到的 SNI 与 Host 都是原始域名（连接地址是注入的 127.0.0.1）
    expect(observed.at(-1)?.sni).toBe(GOOD_HOST);
    expect(observed.at(-1)?.host).toBe(`${GOOD_HOST}:${port}`);
  }, 120_000);

  it('受信 CA 但主机名不匹配（证书只对 webtls.test 有效）→ TLS_ERROR（证书按原始域名校验）', async () => {
    const result = await fetchViaTrustedChild(`https://${OTHER_HOST}:${port}/`);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TLS_ERROR');
    // CA 已受信 → 失败只能是主机名不匹配
    expect(result.message).toMatch(/ALTNAME|hostname|Hostname/i);
  }, 120_000);
});

void d;
