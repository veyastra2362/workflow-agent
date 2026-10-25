import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { redactSecrets } from '../../policy/redact';

/**
 * guarded-fetch：带 SSRF 防护的受控 HTTP(S) 客户端（4.2 核心）。
 *
 * 防护设计（均为程序层强制）：
 * - URL：仅 http/https；禁止 userinfo；public-strict 模式仅允许 scheme 默认端口；
 *   控制字符/空白拒绝；尾随点域名归一化后参与校验与解析。
 * - DNS：全部地址逐一校验（任一私网地址即拒绝 —— 混合公私结果防绕过）；
 *   查询有独立超时与取消；解析结果以固定 IP 参与连接（无二次解析窗口，防重绑定）。
 * - 连接：host=已校验 IP，Host 头与 TLS SNI/证书主机名校验使用原始域名；
 *   rejectUnauthorized 恒为 true；agent:false（不复用连接池，不经代理环境变量）。
 * - 重定向：手动跟随（默认 ≤5 跳），每跳从头走完整 URL+DNS+IP 校验。
 * - 响应：仅 identity 编码（防压缩炸弹）；Content-Type 白名单；流式字节数上限
 *   （超限立即断开）；响应头大小上限；总时长与单跳超时；随时响应 abort 信号断开。
 */

export class WebFetchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WebFetchError';
  }
}

export type DnsLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

export const defaultDnsLookup: DnsLookup = (host) =>
  dns.promises.lookup(host, { all: true, verbatim: true });

/** public-strict：模型可指定的一般目标（默认）；user-configured：用户显式配置的端点（如自建搜索） */
export type TargetPolicy = 'public-strict' | 'user-configured';

export interface GuardedFetchOptions {
  url: string;
  maxBytes?: number;
  maxRedirects?: number;
  /** 总时长上限（跨所有跳） */
  timeoutMs?: number;
  dnsTimeoutMs?: number;
  signal?: AbortSignal;
  targetPolicy?: TargetPolicy;
  /** 测试注入：替换 DNS 解析（生产路径不设置） */
  dnsLookup?: DnsLookup;
  maxHeaderSize?: number;
  /** 附加请求头（如搜索服务鉴权头）。受控头（Host/Connection/Accept-Encoding 等）不可覆盖 */
  headers?: Record<string, string>;
}

/** 附加头白名单式清洗：受控头与逐跳头禁止覆盖，数量与长度受限 */
function sanitizeExtraHeaders(extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra) return {};
  const forbidden = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding',
    'accept-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection'
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    const name = k.toLowerCase();
    if (forbidden.has(name)) continue;
    if (Object.keys(out).length >= 20) break;
    if (name.length > 64 || String(v).length > 2000) continue;
    out[name] = String(v);
  }
  return out;
}

export interface GuardedFetchResult {
  finalUrl: string;
  statusCode: number;
  contentType: string;
  charset?: string;
  body: Buffer;
  truncated: boolean;
  redirects: string[];
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HEADER_SIZE = 32 * 1024;

const ALLOWED_CONTENT_TYPE =
  /text\/(html|plain|xml|markdown|css|csv|javascript)|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml|yaml|x-yaml|ndjson)/i;

// ---------------------------------------------------------------------------
// IP 段检查（IPv4 / IPv6 / 映射 / NAT64）
// ---------------------------------------------------------------------------

function parseV4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v;
}

function parseV6(input: string): bigint | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, '');
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':').filter((g) => g !== '');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':').filter((g) => g !== '')) : null;
  const parseGroup = (g: string): number | null => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : null);
  const h: number[] = [];
  for (const g of head) {
    const n = parseGroup(g);
    if (n === null) return null;
    h.push(n);
  }
  const t: number[] = [];
  for (const g of tail ?? []) {
    const n = parseGroup(g);
    if (n === null) return null;
    t.push(n);
  }
  if (tail === null && h.length !== 8) return null;
  const missing = 8 - h.length - t.length;
  if (missing < 0) return null;
  const groups = [...h, ...Array<number>(missing).fill(0), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

function isBlockedV4(v: number): boolean {
  const a = v >>> 24;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // 未指定/私网/回环/组播/保留
  if (v >= 0x64400000 && v < 0x64800000) return true; // 100.64/10 CGNAT
  if (v >= 0xa9fe0000 && v < 0xa9ff0000) return true; // 169.254/16 链路本地（含云元数据）
  if (v >= 0xac100000 && v < 0xac200000) return true; // 172.16/12
  if (v >= 0xc0000000 && v < 0xc0000100) return true; // 192.0.0/24
  if (v >= 0xc0000200 && v < 0xc0000300) return true; // 192.0.2/24 TEST-NET-1
  if (v >= 0xc0586300 && v < 0xc0586400) return true; // 192.88.99/24
  if (v >= 0xc0a80000 && v < 0xc0a90000) return true; // 192.168/16
  if (v >= 0xc6120000 && v < 0xc6140000) return true; // 198.18/15 基准测试
  if (v >= 0xc6336400 && v < 0xc6336500) return true; // 198.51.100/24 TEST-NET-2
  if (v >= 0xcb007100 && v < 0xcb007200) return true; // 203.0.113/24 TEST-NET-3
  return false;
}

/** 样本地址前缀（避免手算位常量出错：样本地址与目标同右移后比较） */
const P_MAPPED_V4 = parseV6('::ffff:0:0')!; // ::ffff:0:0/96
const P_NAT64 = parseV6('64:ff9b::')!; // 64:ff9b::/96
const P_DISCARD = parseV6('100::')!; // 100::/64
const P_NAT64_LOCAL = parseV6('64:ff9b:1::')!; // 64:ff9b:1::/48
const P_DOC = parseV6('2001:db8::')!; // 2001:db8::/32

function inPrefix(v: bigint, sample: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return v >> shift === sample >> shift;
}

function isBlockedV6(v: bigint): boolean {
  if (v === 0n || v === 1n) return true; // :: 与 ::1
  // 前缀比较统一取「前 N 位」的整数值：fc00::/7 → 0xfc>>1=0x7E；fe80::/10 → 0xfe80>>6=0x3FA
  if (v >> 121n === 0x7en) return true; // fc00::/7 ULA
  if (v >> 118n === 0x3fan) return true; // fe80::/10 链路本地
  if (v >> 120n === 0xffn) return true; // ff00::/8 组播
  if (inPrefix(v, P_DOC, 32)) return true;
  if (inPrefix(v, P_DISCARD, 64)) return true;
  if (inPrefix(v, P_NAT64_LOCAL, 48)) return true;
  return false;
}

/** 目标地址是否被 SSRF 策略阻止（导出供测试做矩阵验证） */
export function isBlockedIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (net.isIPv4(s)) {
    const v = parseV4(s);
    return v === null ? true : isBlockedV4(v);
  }
  if (net.isIPv6(s)) {
    const v = parseV6(s);
    if (v === null) return true;
    // IPv4-mapped IPv6（::ffff:0:0/96，含 ::ffff:127.0.0.1 与 ::ffff:7f00:1 两种写法）
    if (inPrefix(v, P_MAPPED_V4, 96)) {
      return isBlockedV4(Number(v & 0xffffffffn));
    }
    // 知名 NAT64（64:ff9b::/96）：低 32 位即被映射的 IPv4
    if (inPrefix(v, P_NAT64, 96)) {
      return isBlockedV4(Number(v & 0xffffffffn));
    }
    return isBlockedV6(v);
  }
  return true; // 无法识别的地址一律拒绝
}

// ---------------------------------------------------------------------------
// URL 校验
// ---------------------------------------------------------------------------

export interface ValidatedUrl {
  url: URL;
  host: string;
  port: number;
  isHttps: boolean;
}

export function validateUrl(raw: string, policy: TargetPolicy): ValidatedUrl {
  if (typeof raw !== 'string' || raw === '' || /[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new WebFetchError('INVALID_URL', 'URL 含空白/控制字符或为空');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError('INVALID_URL', 'URL 无法解析');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError('SCHEME_NOT_ALLOWED', `仅允许 http/https，收到 ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebFetchError('CREDENTIALS_IN_URL', 'URL 中不允许携带用户名/密码');
  }
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // 尾随点归一化：校验与解析使用同一形式
  if (host === '') throw new WebFetchError('INVALID_URL', '缺少主机名');
  const isHttps = url.protocol === 'https:';
  const defaultPort = isHttps ? 443 : 80;
  let port = defaultPort;
  if (url.port !== '') {
    const p = Number(url.port);
    if (!Number.isInteger(p)) throw new WebFetchError('INVALID_URL', '端口非法');
    if (policy === 'public-strict' && p !== defaultPort) {
      throw new WebFetchError('PORT_NOT_ALLOWED', `公网目标仅允许默认端口（${defaultPort}），收到 ${p}`);
    }
    if (p < 1 || p > 65535) throw new WebFetchError('INVALID_URL', '端口超出范围');
    port = p;
  }
  return { url, host, port, isHttps };
}

// ---------------------------------------------------------------------------
// DNS 解析与校验
// ---------------------------------------------------------------------------

async function withTimeoutAndAbort<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  code: string,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new WebFetchError('ABORTED', `${label}已取消`));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => reject(new WebFetchError(code, `${label}超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveAndCheck(
  host: string,
  cfg: { targetPolicy: TargetPolicy; dnsLookup?: DnsLookup; dnsTimeoutMs: number; signal?: AbortSignal }
): Promise<string> {
  if (net.isIP(host) !== 0) {
    if (cfg.targetPolicy === 'public-strict' && isBlockedIp(host)) {
      throw new WebFetchError('PRIVATE_TARGET', `目标地址 ${host} 属于私网/保留/回环范围，已拒绝`);
    }
    return host;
  }
  const lookup = cfg.dnsLookup ?? defaultDnsLookup;
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await withTimeoutAndAbort(
      lookup(host),
      cfg.dnsTimeoutMs,
      cfg.signal,
      'DNS_TIMEOUT',
      'DNS 查询'
    );
  } catch (err) {
    if (err instanceof WebFetchError) throw err;
    throw new WebFetchError('DNS_FAILED', `DNS 解析失败：${summarizeError(err)}`);
  }
  if (addrs.length === 0) throw new WebFetchError('DNS_NO_ANSWER', 'DNS 未返回任何地址');
  if (cfg.targetPolicy === 'public-strict') {
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        // 任一解析结果落入私网/保留段即整体拒绝（防混合公私结果绕过）
        throw new WebFetchError('PRIVATE_TARGET', `${host} 的解析结果 ${a.address} 属于私网/保留/回环范围，已拒绝`);
      }
    }
  }
  // 固定 IP 连接：使用首个已校验地址，不再进行二次解析（防 DNS 重绑定）
  return addrs[0]!.address;
}

// ---------------------------------------------------------------------------
// 单跳请求（固定 IP 连接）
// ---------------------------------------------------------------------------

interface HopResult {
  res: http.IncomingMessage;
  req: http.ClientRequest;
}

function singleRequest(
  v: ValidatedUrl,
  ip: string,
  cfg: { timeoutMs: number; signal?: AbortSignal; maxHeaderSize: number; extraHeaders?: Record<string, string> }
): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const mod = v.isHttps ? https : http;
    const hostHeader = v.port === (v.isHttps ? 443 : 80) ? v.host : `${v.host}:${v.port}`;
    const req = mod.request(
      {
        host: ip, // 固定 IP：连接目标来自本次校验
        port: v.port,
        method: 'GET',
        path: v.url.pathname + v.url.search,
        // TLS：SNI 与证书主机名校验均使用原始域名；证书校验绝不关闭
        ...(v.isHttps ? { servername: v.host, rejectUnauthorized: true } : {}),
        headers: {
          ...cfg.extraHeaders,
          Host: hostHeader,
          'User-Agent': 'WorkflowAgent/0.1 (local-first desktop agent)',
          Accept:
            'text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.4',
          'Accept-Encoding': 'identity', // 拒绝压缩：防压缩炸弹（收到压缩响应即报错）
          Connection: 'close' // 不复用连接；不经代理环境变量（node:http 默认不读代理环境）
        },
        agent: false,
        maxHeaderSize: cfg.maxHeaderSize
      },
      (res) => {
        settled();
        resolve({ res, req });
      }
    );
    let done = false;
    const timer = setTimeout(() => {
      req.destroy();
      fail(new WebFetchError('TIMEOUT', `请求超时（${cfg.timeoutMs}ms，未收到响应头）`));
    }, cfg.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      req.destroy();
      fail(new WebFetchError('ABORTED', '请求已取消'));
    };
    if (cfg.signal) {
      if (cfg.signal.aborted) onAbort();
      else cfg.signal.addEventListener('abort', onAbort, { once: true });
    }
    function settled(): void {
      done = true;
      clearTimeout(timer);
      cfg.signal?.removeEventListener('abort', onAbort);
    }
    function fail(err: Error): void {
      if (done) return;
      settled();
      reject(err);
    }
    req.on('error', (err) => fail(normalizeConnError(err)));
    req.end(); // GET 请求立即发出（http.request 不会自动 end）
  });
}

function normalizeConnError(err: Error): WebFetchError {
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (/ERR_TLS|CERT|SSL/.test(code) || /certificate|SSL|TLS/i.test(err.message)) {
    return new WebFetchError('TLS_ERROR', `TLS/证书校验失败：${summarizeError(err)}`);
  }
  if (code === 'ECONNREFUSED') return new WebFetchError('CONNECT_FAILED', '连接被拒绝');
  if (code === 'ECONNRESET') return new WebFetchError('CONNECTION_RESET', '连接被重置');
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new WebFetchError('UNREACHABLE', '目标不可达');
  if (code === 'HPE_HEADER_OVERFLOW' || /header/i.test(err.message)) {
    return new WebFetchError('HEADER_TOO_LARGE', '响应头超过大小上限');
  }
  return new WebFetchError('CONNECT_FAILED', `连接失败：${summarizeError(err)}`);
}

function summarizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg).slice(0, 300);
}

// ---------------------------------------------------------------------------
// 响应体读取（大小/超时/取消）
// ---------------------------------------------------------------------------

function readBody(
  res: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      res.destroy();
      finish(new WebFetchError('ABORTED', '请求已取消（响应读取中断）'));
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve({ body: Buffer.concat(chunks), truncated });
    };
    timer = setTimeout(() => {
      res.destroy();
      finish(new WebFetchError('TIMEOUT', `响应读取超时（${timeoutMs}ms，疑似慢速响应）`));
    }, timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    res.on('data', (chunk: Buffer) => {
      if (size + chunk.length > maxBytes) {
        const keep = maxBytes - size;
        if (keep > 0) {
          chunks.push(chunk.subarray(0, keep));
          size = maxBytes;
        }
        truncated = true;
        res.destroy(); // 超限立即断开，不再继续接收
        finish();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    res.on('end', () => finish());
    res.on('error', (err) => finish(normalizeConnError(err)));
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function isRedirectStatus(status: number | undefined): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function guardedFetch(opts: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dnsTimeoutMs = opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const maxHeaderSize = opts.maxHeaderSize ?? DEFAULT_MAX_HEADER_SIZE;
  const targetPolicy = opts.targetPolicy ?? 'public-strict';
  const extraHeaders = sanitizeExtraHeaders(opts.headers);
  const deadline = Date.now() + timeoutMs;

  let currentUrl = opts.url;
  const redirects: string[] = [];
  for (let hop = 0; ; hop += 1) {
    if (opts.signal?.aborted) throw new WebFetchError('ABORTED', '请求已取消');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new WebFetchError('TIMEOUT', `请求总时长超限（${timeoutMs}ms）`);

    // 每一跳（含重定向目标）从头做完整校验
    const validated = validateUrl(currentUrl, targetPolicy);
    const ip = await resolveAndCheck(validated.host, {
      targetPolicy,
      dnsLookup: opts.dnsLookup,
      dnsTimeoutMs: Math.min(dnsTimeoutMs, remaining),
      signal: opts.signal
    });

    const { res, req } = await singleRequest(validated, ip, {
      timeoutMs: remaining,
      signal: opts.signal,
      maxHeaderSize,
      extraHeaders
    });

    const location = res.headers.location;
    if (isRedirectStatus(res.statusCode) && typeof location === 'string' && location !== '') {
      req.destroy(); // 不读重定向响应体
      if (hop >= maxRedirects) {
        throw new WebFetchError('TOO_MANY_REDIRECTS', `重定向超过 ${maxRedirects} 跳上限`);
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new WebFetchError('INVALID_REDIRECT', `重定向地址无法解析：${redactSecrets(location).slice(0, 120)}`);
      }
      redirects.push(next.toString());
      currentUrl = next.toString();
      continue;
    }

    const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (encoding !== 'identity') {
      req.destroy();
      throw new WebFetchError('COMPRESSED_CONTENT', `服务端返回压缩响应（${encoding}），已拒绝以防范压缩炸弹`);
    }
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    if (contentType !== '' && !ALLOWED_CONTENT_TYPE.test(contentType)) {
      req.destroy();
      throw new WebFetchError('UNSUPPORTED_CONTENT_TYPE', `不支持的 Content-Type：${contentType.slice(0, 80)}（仅允许文本类）`);
    }

    const { body, truncated } = await readBody(res, maxBytes, opts.signal, deadline - Date.now());
    const charsetMatch = /charset=([\w-]+)/i.exec(contentType);
    return {
      finalUrl: currentUrl,
      statusCode: res.statusCode ?? 0,
      contentType,
      charset: charsetMatch?.[1],
      body,
      truncated,
      redirects
    };
  }
}
