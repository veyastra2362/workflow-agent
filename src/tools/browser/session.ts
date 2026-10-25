import { createHash } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { isBlockedIp } from '../web/guarded-fetch';

/**
 * 浏览器会话管理（4.3）：
 * - 进程级惰性启动 headless Chromium（Playwright 自管理，不接管用户浏览器）；
 * - 每个任务独立 BrowserContext（空 Cookie / 无扩展 / Service Worker 禁用）；
 * - 全局路由拦截（context.route 匹配所有 URL）：主框架 / 子资源 / iframe / WebSocket /
 *   重定向后每一跳 / popup 新页面（context 级路由覆盖其所有页面）。
 *   校验失败或无法校验 → 一律 abort，绝不静默放行；校验复用 4.2 原语（scheme/端口/userinfo/DNS+私网段）；
 * - 清理幂等：closeTask 可重复调用；closed 会话对迟到调用直接拒绝。
 */

export interface BrowserPolicyConfig {
  /** 生产默认 false：回环/私网一律拒绝。测试经此豁免仅放行回环（其余私网段仍拒绝） */
  loopbackExempt?: boolean;
  /** 请求校验 DNS 缓存 TTL */
  dnsCacheTtlMs?: number;
}

export interface TaskBrowserSession {
  taskId: string;
  context: BrowserContext;
  page: Page;
  closed: boolean;
  stats: { allowed: number; blocked: number };
  /** 最近一次快照的元素签名表（ref → signature），审批复检用 */
  lastSignatures: Map<string, string>;
  /** 快照时页面 URL（用于检测审批等待期间页面变化） */
  lastSnapshotUrl: string;
}

const DNS_CACHE_TTL_MS = 30_000;

export class BrowserSessionManager {
  private browser: Browser | null = null;
  private browserLaunching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, TaskBrowserSession>();
  private readonly closingTasks = new Set<string>();
  private managerClosed = false;
  private readonly dnsCache = new Map<string, { ok: boolean; reason: string; addresses: string[]; at: number }>();

  constructor(
    private readonly opts: {
      policy?: BrowserPolicyConfig;
      logger?: { warn(msg: string, meta?: Record<string, unknown>): void; info(msg: string, meta?: Record<string, unknown>): void };
    } = {}
  ) {}

  isClosed(): boolean {
    return this.managerClosed;
  }

  /** 导航前校验（与路由层同一规则；供 browser_open 主框架预检） */
  async validateUrlForNavigation(rawUrl: string): Promise<{ ok: boolean; reason?: string }> {
    return this.checkUrl(rawUrl);
  }

  /** 获取（或创建）任务专属会话；任务结束/管理器关闭后调用直接报错 */
  async openTaskSession(taskId: string): Promise<TaskBrowserSession> {
    if (this.managerClosed) throw new Error('[BROWSER_DISABLED] 浏览器管理器已关闭');
    const existing = this.sessions.get(taskId);
    if (existing) {
      if (existing.closed) throw new Error('[BROWSER_SESSION_CLOSED] 任务浏览器会话已关闭，不能复用');
      return existing;
    }
    if (this.closingTasks.has(taskId)) {
      throw new Error('[BROWSER_SESSION_CLOSED] 任务浏览器会话正在关闭，不能重建');
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      serviceWorkers: 'block',
      // 不注入任何凭证；不持久化
      storageState: undefined,
      permissions: []
    });
    const session: TaskBrowserSession = {
      taskId,
      context,
      page: await context.newPage(),
      closed: false,
      stats: { allowed: 0, blocked: 0 },
      lastSignatures: new Map(),
      lastSnapshotUrl: ''
    };
    // 统一路由：覆盖本 context 全部页面（含 popup / iframe / 重定向）
    await context.route('**/*', async (route) => {
      try {
        const url = route.request().url();
        const check = await this.checkUrl(url);
        if (!check.ok) {
          session.stats.blocked += 1;
          await route.abort('blockedbyclient');
          return;
        }
        session.stats.allowed += 1;
        await route.continue();
      } catch {
        // 校验过程本身失败 → 拒绝（不能静默放行）
        session.stats.blocked += 1;
        try {
          await route.abort('blockedbyclient');
        } catch {
          // 路由已失效
        }
      }
    });
    // WebSocket 不经过 route()：单独注册 routeWebSocket 全部阻断
    //（不 connectToServer 即不建立连接；close 通知页面失败。对齐 4.2 目标：仅 http/https）
    await context.routeWebSocket('**/*', (ws) => {
      session.stats.blocked += 1;
      ws.close({ code: 1006, reason: 'blocked by agent policy' });
    });
    this.sessions.set(taskId, session);
    return session;
  }

  /** 幂等关闭任务会话；设置 closed 标记使迟到调用立即失败 */
  async closeTask(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return; // 幂等：不存在即已完成
    if (session.closed) return;
    session.closed = true;
    this.closingTasks.add(taskId);
    try {
      await session.context.close();
    } catch {
      // 上下文可能已死
    } finally {
      this.sessions.delete(taskId);
      this.closingTasks.delete(taskId);
    }
  }

  /** 应用退出：带超时的全量清理（防止浏览器进程阻止退出） */
  async closeAll(timeoutMs = 2500): Promise<void> {
    if (this.managerClosed) return;
    this.managerClosed = true;
    const taskIds = [...this.sessions.keys()];
    await Promise.all(
      taskIds.map((id) => this.closeTask(id).catch(() => undefined))
    );
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await Promise.race([
        b.close(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      ]).catch(() => undefined);
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browserLaunching) return this.browserLaunching;
    this.browserLaunching = (async () => {
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-proxy-server', // 直连：代理会绕开目标 IP 校验
          '--disable-background-networking', // 禁用后台网络（组件更新/安全浏览上报等）
          '--disable-component-update',
          '--disable-sync',
          '--disable-breakpad', // 禁止崩溃上报外发
          '--no-first-run',
          '--no-default-browser-check'
        ]
      });
      browser.on('disconnected', () => {
        if (this.browser === browser) this.browser = null;
        for (const s of this.sessions.values()) s.closed = true;
        this.sessions.clear();
      });
      this.browser = browser;
      return browser;
    })();
    try {
      return await this.browserLaunching;
    } finally {
      this.browserLaunching = null;
    }
  }

  /**
   * 请求级校验（路由回调内）：
   * 仅 http/https + about:blank；无 userinfo；目标地址（DNS 全部结果）不得落入
   * 私网/保留段；默认端口（测试模式对「回环目标」豁免端口与 IP，其余私网段仍拒绝）。
   * 校验顺序：scheme → userinfo → 地址（IP/DNS）→ 端口 —— 私网拒绝优先于端口拒绝。
   */
  private async checkUrl(rawUrl: string): Promise<{ ok: boolean; reason?: string }> {
    if (rawUrl === 'about:blank') return { ok: true };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, reason: 'INVALID_URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      // ws/wss/file/data/ftp 等一律阻断（对齐 4.2 目标；SW 已禁用）
      return { ok: false, reason: 'SCHEME_NOT_ALLOWED' };
    }
    if (url.username !== '' || url.password !== '') return { ok: false, reason: 'CREDENTIALS_IN_URL' };
    let host = url.hostname.toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host === '') return { ok: false, reason: 'INVALID_URL' };

    // 地址校验（字面量直判；域名走 DNS，全部地址均需通过）
    let addresses: string[];
    if (net.isIP(host) !== 0) {
      addresses = [host];
    } else {
      const cached = this.dnsCache.get(host);
      if (cached && Date.now() - cached.at < (this.opts.policy?.dnsCacheTtlMs ?? DNS_CACHE_TTL_MS)) {
        if (!cached.ok) return { ok: false, reason: cached.reason };
        addresses = cached.addresses;
      } else {
        let result: { ok: boolean; reason: string; addresses: string[] };
        try {
          const addrs = await dns.promises.lookup(host, { all: true });
          const ok = addrs.length > 0 && addrs.every((a) => this.ipAllowed(a.address));
          result = { ok, reason: ok ? '' : 'PRIVATE_TARGET', addresses: addrs.map((a) => a.address) };
        } catch {
          result = { ok: false, reason: 'DNS_FAILED', addresses: [] }; // 解析失败 = 无法校验 → 拒绝
        }
        this.dnsCache.set(host, { ok: result.ok, reason: result.reason, addresses: result.addresses, at: Date.now() });
        if (!result.ok) return { ok: false, reason: result.reason };
        addresses = result.addresses;
      }
    }
    const allLoopback = addresses.length > 0 && addresses.every((a) => isLoopbackLiteral(a));
    if (addresses.some((a) => !this.ipAllowed(a))) {
      return { ok: false, reason: 'PRIVATE_TARGET' };
    }

    // 端口校验（测试模式仅对回环目标豁免）
    const isHttps = url.protocol === 'https:';
    const defaultPort = isHttps ? 443 : 80;
    if (url.port !== '' && Number(url.port) !== defaultPort) {
      if (!(this.opts.policy?.loopbackExempt === true && allLoopback)) {
        return { ok: false, reason: 'PORT_NOT_ALLOWED' };
      }
    }
    return { ok: true };
  }

  private ipAllowed(ip: string): boolean {
    if (isBlockedIp(ip)) {
      // 测试豁免：仅回环（127/8 与 ::1）
      if (this.opts.policy?.loopbackExempt === true && isLoopbackLiteral(ip)) return true;
      return false;
    }
    return true;
  }
}

function isLoopbackLiteral(ip: string): boolean {
  const s = ip.toLowerCase();
  return s.startsWith('127.') || s === '::1' || s.startsWith('[::1]');
}

/** 页面元素签名（与 policy/browser-risk 的 elementSignature 一致的输入键） */
export function pageSignatureOf(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}
