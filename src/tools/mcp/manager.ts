import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { Client } from '@modelcontextprotocol/client';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ToolDefinition } from '../registry';
import { createMcpToolDefinition } from './mcp-tools';
import {
  mcpRegisteredName,
  mapMcpResult,
  validateArgsAgainstSchema,
  validateToolSchema,
  type McpCallResult
} from './convert';
import { buildChildEnv, validateServerConfigAtRuntime, type McpServerConfigRaw } from './validate-config';

/**
 * MCP 连接管理（4.4）：
 * - 仅 stdio；仅连接用户显式配置的服务器（无自动发现/自动连接）；
 * - 连接为进程级共享（跨任务），任务取消只中止该次调用（SDK 逐请求 signal），
 *   不关闭共享连接（探针实测：取消后连接仍可用）；
 * - 服务器进程退出 → 状态 disconnected，后续调用返回结构化 [MCP_SERVER_DOWN]；
 * - 配置在保存时与每次连接前双重校验（同一函数）；
 * - 子进程环境仅白名单系统变量 + 用户静态配置（绝不转发全量 env/密钥）。
 */

export type McpServerStatusValue = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpServerStatus {
  id: string;
  name: string;
  status: McpServerStatusValue;
  toolCount: number;
  error?: string;
  lastConnectedAt?: number;
}

interface Connection {
  config: McpServerConfigRaw;
  client: Client;
}

interface McpToolEntry {
  serverId: string;
  serverSlug: string;
  originalName: string;
  def: ToolDefinition<Record<string, unknown>>;
  inputSchema: Record<string, unknown>;
}

interface ServerState {
  config: McpServerConfigRaw;
  status: McpServerStatusValue;
  client?: Client;
  tools: McpToolEntry[];
  error?: string;
  lastConnectedAt?: number;
  /** 发现阶段被拒绝的工具（名称冲突 / Schema 不兼容） */
  rejectedTools: Array<{ name: string; reason: string }>;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const MCP_DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_LIST_TIMEOUT_MS = 10_000;

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  private closed = false;
  private readonly listeners = new Set<(status: McpServerStatus[]) => void>();

  constructor(
    private readonly opts: {
      logger?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
      maxResultChars?: number;
    } = {}
  ) {}

  isClosed(): boolean {
    return this.closed;
  }

  onStatusChange(cb: (status: McpServerStatus[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emitStatus(): void {
    const snapshot = this.status();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch {
        // 监听器异常不影响管理器
      }
    }
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => ({
      id: s.config.id,
      name: s.config.name,
      status: s.status,
      toolCount: s.tools.length,
      error: s.error,
      lastConnectedAt: s.lastConnectedAt
    }));
  }

  /** 同步配置（设置保存/删除后调用）：新增或更新则（重）连接，移除则断开 */
  async syncConfigs(configs: unknown[]): Promise<void> {
    const validated: McpServerConfigRaw[] = [];
    for (const c of configs) {
      const check = validateServerConfigAtRuntime(c);
      if (!check.ok) {
        this.opts.logger?.warn('mcp.config.rejected', { reason: check.reason });
        continue;
      }
      validated.push(check.value);
    }
    const nextIds = new Set(validated.map((v) => v.id));
    // 移除的配置 → 断开
    for (const [id, state] of [...this.servers.entries()]) {
      if (!nextIds.has(id)) {
        await this.disconnect(id).catch(() => undefined);
        this.servers.delete(id);
      }
    }
    for (const cfg of validated) {
      const existing = this.servers.get(cfg.id);
      if (!existing) {
        this.servers.set(cfg.id, {
          config: cfg,
          status: 'disconnected',
          tools: [],
          rejectedTools: []
        });
        if (cfg.enabled) void this.connect(cfg.id);
      } else if (
        existing.config.command !== cfg.command ||
        JSON.stringify(existing.config.args) !== JSON.stringify(cfg.args) ||
        JSON.stringify(existing.config.env) !== JSON.stringify(cfg.env) ||
        existing.config.cwd !== cfg.cwd ||
        existing.config.enabled !== cfg.enabled
      ) {
        await this.disconnect(cfg.id).catch(() => undefined);
        this.servers.set(cfg.id, { config: cfg, status: 'disconnected', tools: [], rejectedTools: [] });
        if (cfg.enabled) void this.connect(cfg.id);
      }
    }
    this.emitStatus();
  }

  /** 手动（重）连接 */
  async reconnect(id: string): Promise<McpServerStatus | null> {
    const state = this.servers.get(id);
    if (!state) return null;
    await this.disconnect(id).catch(() => undefined);
    state.tools = [];
    state.rejectedTools = [];
    await this.connect(id);
    const s = this.status().find((x) => x.id === id) ?? null;
    this.emitStatus();
    return s;
  }

  private async disconnect(id: string): Promise<void> {
    const state = this.servers.get(id);
    if (!state) return;
    const client = state.client;
    state.client = undefined;
    state.tools = [];
    if (state.status !== 'error') state.status = 'disconnected';
    if (client) {
      await Promise.race([
        client.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 3000))
      ]).catch(() => undefined);
    }
  }

  /**
   * 检查命令在生产环境中是否可执行（Stage 5.1）。
   * - 绝对路径：检查文件存在
   * - 相对路径/裸名：通过 where（Windows）或 which（Unix）查找
   * 返回 null 表示可用；否则返回用户可理解的诊断信息。
   */
  private checkCommandAvailable(command: string, cwd?: string): string | null {
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(command) || command.startsWith('/');
    if (isAbsolute) {
      if (!fs.existsSync(command)) {
        return `可执行文件不存在：${command}。请确认路径正确。`;
      }
      return null;
    }
    // 裸名或相对路径 → PATH 查找
    try {
      execSync(`where "${command}" 2>nul`, { cwd: cwd || process.cwd(), stdio: 'pipe', timeout: 3000 });
      return null;
    } catch {
      // where 失败 → 检查是否是常见运行时缺失
      const hints: Array<[RegExp, string]> = [
        [/^node$/, '未找到 node。此 MCP 服务器需要 Node.js 运行时。请从 https://nodejs.org 安装后重试。'],
        [/^npx$/, '未找到 npx。此 MCP 服务器需要 Node.js（含 npm）。请从 https://nodejs.org 安装后重试。'],
        [/^python$/, '未找到 python。此 MCP 服务器需要 Python。请从 https://python.org 安装后重试。'],
        [/^uv$/, '未找到 uv。此 MCP 服务器需要 uv 包管理器。请运行 pip install uv 或参考 https://docs.astral.sh/uv/'],
        [/^bun$/, '未找到 bun。此 MCP 服务器需要 Bun 运行时。请从 https://bun.sh 安装。'],
        [/^deno$/, '未找到 deno。此 MCP 服务器需要 Deno 运行时。请从 https://deno.land 安装。']
      ];
      for (const [re, hint] of hints) {
        if (re.test(command)) return hint;
      }
      return `命令 "${command}" 在 PATH 中未找到。请确认：1) 已安装对应程序；2) 其所在目录已加入系统 PATH；3) 或使用完整路径配置。`;
    }
  }

  private async connect(id: string): Promise<void> {
    const state = this.servers.get(id);
    if (!state || this.closed) return;
    state.status = 'connecting';
    state.error = undefined;
    this.emitStatus();

    // 生产环境命令可用性预检（Stage 5.1）
    const cmdError = this.checkCommandAvailable(state.config.command, state.config.cwd);
    if (cmdError) {
      state.status = 'error';
      state.error = cmdError;
      state.tools = [];
      this.opts.logger?.warn('mcp.command.unavailable', { server: state.config.name, command: state.config.command, reason: cmdError });
      this.emitStatus();
      return;
    }

    try {
      const client = new McpClient({ name: 'workflow-agent', version: '0.1.0' });
      const transport = new StdioClientTransport({
        command: state.config.command,
        args: state.config.args,
        env: buildChildEnv(state.config.env),
        ...(state.config.cwd ? { cwd: state.config.cwd } : {})
      });
      client.onclose = () => {
        const s = this.servers.get(id);
        if (s && s.client === client) {
          s.client = undefined;
          s.tools = [];
          if (s.status === 'connected') s.status = 'disconnected';
          this.emitStatus();
        }
      };
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('连接超时')), MCP_CONNECT_TIMEOUT_MS)
        )
      ]);
      state.client = client;

      const listed = await Promise.race([
        client.listTools(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('工具发现超时')), MCP_LIST_TIMEOUT_MS)
        )
      ]);
      const tools = listed.tools ?? [];
      const entries: McpToolEntry[] = [];
      const rejected: Array<{ name: string; reason: string }> = [];
      for (const t of tools) {
        const schemaCheck = validateToolSchema(t.inputSchema);
        const registered = mcpRegisteredName(state.config.name, t.name);
        if (!registered) {
          rejected.push({ name: t.name, reason: '工具名无法安全映射（字符/长度限制）' });
          continue;
        }
        if (!schemaCheck.ok) {
          rejected.push({ name: t.name, reason: schemaCheck.reason ?? 'Schema 不兼容' });
          continue;
        }
        if (entries.some((e) => e.def.name === registered)) {
          rejected.push({ name: t.name, reason: '命名冲突' });
          continue;
        }
        const inputSchema = t.inputSchema as Record<string, unknown>;
        entries.push({
          serverId: id,
          serverSlug: state.config.name,
          originalName: t.name,
          inputSchema,
          def: createMcpToolDefinition({
            registeredName: registered,
            originalName: t.name,
            serverId: id,
            description: t.description ?? '',
            inputSchema,
            call: (args, callOpts) => this.callTool(id, t.name, args, callOpts),
            maxResultChars: this.opts.maxResultChars ?? 20_000
          })
        });
      }
      state.tools = entries;
      state.rejectedTools = rejected;
      state.status = 'connected';
      state.lastConnectedAt = Date.now();
      if (rejected.length > 0) {
        this.opts.logger?.warn('mcp.tools.rejected', {
          server: state.config.name,
          rejected: rejected.map((r) => `${r.name}: ${r.reason}`).slice(0, 5)
        });
      }
      this.opts.logger?.info('mcp.connected', {
        server: state.config.name,
        tools: entries.length,
        rejected: rejected.length
      });
    } catch (err) {
      state.status = 'error';
      state.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      state.tools = [];
      this.opts.logger?.warn('mcp.connect.failed', { server: state.config.name, error: state.error });
    }
    this.emitStatus();
  }

  /**
   * 调用服务器工具：逐请求 signal/timeout（取消不关闭共享连接）。
   * 服务器返回 isError → 抛 [MCP_TOOL_ERROR]；参数经同源校验失败 → [MCP_INVALID_ARGS]。
   */
  async callTool(
    serverId: string,
    originalName: string,
    args: unknown,
    opts: McpCallOptions = {}
  ): Promise<ReturnType<typeof mapMcpResult>> {
    const state = this.servers.get(serverId);
    if (!state) throw new Error('[MCP_SERVER_UNKNOWN] 服务器配置不存在');
    if (!state.client || state.status !== 'connected') {
      throw new Error(`[MCP_SERVER_DOWN] 服务器 "${state.config.name}" 未连接（${state.status}${state.error ? `：${state.error}` : ''}）`);
    }
    const entry = state.tools.find((t) => t.originalName === originalName);
    if (!entry) throw new Error(`[MCP_TOOL_UNKNOWN] 工具 "${originalName}" 不在已发现列表中`);

    // 同源参数校验（与模型可见 Schema 完全一致）
    const argsCheck = validateArgsAgainstSchema(entry.inputSchema, args ?? {});
    if (!argsCheck.ok) {
      throw new Error(`[MCP_INVALID_ARGS] 参数未通过服务器 Schema 校验：${argsCheck.issues.join('；')}`);
    }

    const timeoutMs = Math.min(opts.timeoutMs ?? MCP_DEFAULT_CALL_TIMEOUT_MS, 120_000);
    let result: McpCallResult;
    try {
      result = (await state.client.callTool(
        { name: originalName, arguments: (args ?? {}) as Record<string, unknown> },
        { timeout: timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) }
      )) as McpCallResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(msg) || opts.signal?.aborted) {
        throw new Error(`[MCP_ABORTED] 调用已取消（连接保持，其他任务不受影响）：${msg.slice(0, 120)}`);
      }
      if (/timed out|timeout/i.test(msg)) {
        throw new Error(`[MCP_TIMEOUT] 调用超时（${timeoutMs}ms，连接保持）`);
      }
      throw new Error(`[MCP_CALL_FAILED] ${msg.slice(0, 200)}`);
    }
    if (result?.isError === true) {
      const excerpt = (result.content ?? [])
        .filter((b) => b && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .slice(0, 300);
      throw new Error(`[MCP_TOOL_ERROR] 服务器报告工具执行失败：${excerpt || '（无详情）'}`);
    }
    return mapMcpResult(result, this.opts.maxResultChars ?? 20_000);
  }

  /** 当前所有已连接服务器的工具定义快照（供注册表按任务合并） */
  listToolDefinitions(): ToolDefinition<never>[] {
    const out: ToolDefinition<never>[] = [];
    for (const state of this.servers.values()) {
      if (state.status !== 'connected') continue;
      for (const t of state.tools) {
        out.push(t.def as never);
      }
    }
    return out;
  }

  /** 服务器发现阶段被拒绝的工具（供 UI/诊断） */
  rejectedTools(): Array<{ server: string; name: string; reason: string }> {
    const out: Array<{ server: string; name: string; reason: string }> = [];
    for (const state of this.servers.values()) {
      for (const r of state.rejectedTools) {
        out.push({ server: state.config.name, name: r.name, reason: r.reason });
      }
    }
    return out;
  }

  /** 应用退出：带超时关闭全部连接 */
  async closeAll(timeoutMs = 2500): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      [...this.servers.keys()].map((id) => this.disconnect(id).catch(() => undefined))
    );
    this.emitStatus();
    void timeoutMs;
  }
}

export function newMcpServerId(): string {
  return randomUUID();
}

export type { Connection };
