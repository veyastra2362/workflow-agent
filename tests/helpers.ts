import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/persistence/db';
import { Store } from '../src/persistence/store';
import { AgentService } from '../src/core/service';
import { createLogger } from '../src/main/logger';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import type { ModelError, ModelGateway, ModelRequest, ChatResponse, UnifiedToolCall } from '../src/gateway/types';
import { ModelError as ModelErrorClass } from '../src/gateway/types';
import type { FinalReport, PersistedSettings, TaskEvent, ToolCallRecord } from '../src/shared/types';
import type { ToolContext } from '../src/tools/registry';

let callCounter = 0;

export function nextCallId(): string {
  callCounter += 1;
  return `call_${callCounter}`;
}

export function toolCall(name: string, args: unknown, id?: string): UnifiedToolCall {
  return { id: id ?? nextCallId(), name, argumentsJson: JSON.stringify(args) };
}

export function textResponse(text: string): ChatResponse {
  return { content: text, toolCalls: [], finishReason: 'stop' };
}

export function toolResponse(text: string, calls: UnifiedToolCall[]): ChatResponse {
  return { content: text || null, toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'stop' };
}

export function makeTempDir(prefix = 'wa-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const TEST_SETTINGS: PersistedSettings = {
  ...DEFAULT_SETTINGS,
  allowedTestCommands: ['node'],
  maxSteps: 25,
  taskTimeoutMs: 60_000
};

export class ScriptedGateway implements ModelGateway {
  requests: ModelRequest[] = [];
  private idx = 0;

  constructor(
    public steps: Array<
      (req: ModelRequest, signal?: AbortSignal) => Promise<ChatResponse> | ChatResponse
    >
  ) {}

  async chat(req: ModelRequest, signal?: AbortSignal): Promise<ChatResponse> {
    this.requests.push(req);
    if (signal?.aborted) {
      throw new ModelErrorClass('MODEL_ABORTED', '请求已被取消');
    }
    const step = this.steps[Math.min(this.idx, this.steps.length - 1)];
    this.idx += 1;
    return step(req, signal);
  }
}

export function makeCtx(ws: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const backups = new Map<string, string | null>();
  const ac = new AbortController();
  return {
    workspace: ws,
    taskId: 'test-task',
    signal: ac.signal,
    // 普通可变对象，便于测试直接置 cancelled = true
    cancellationToken: { cancelled: false },
    now: () => Date.now(),
    recordFileChange: (rec) => {
      backups.set(rec.path, rec.backupContent);
    },
    getRecordedChanges: () =>
      [...backups.keys()].map((p) => ({
        path: p,
        kind: (backups.get(p) === null ? 'create' : 'modify') as 'create' | 'modify'
      })),
    readBackup: (p) => backups.get(p) ?? null,
    ...overrides
  };
}

export interface BuiltService {
  store: Store;
  gateway: ScriptedGateway;
  service: AgentService;
  events: TaskEvent[];
  workspace: string;
}

export function buildService(opts: {
  workspace: string;
  steps: Array<
    (req: ModelRequest, signal?: AbortSignal) => Promise<ChatResponse> | ChatResponse
  >;
  settings?: Partial<PersistedSettings>;
}): BuiltService {
  const store = new Store(openDatabase(':memory:'));
  const logger = createLogger({ level: 'error', console: false });
  const settings: PersistedSettings = { ...TEST_SETTINGS, ...opts.settings };
  const events: TaskEvent[] = [];
  const gateway = new ScriptedGateway(opts.steps);
  const service = new AgentService({
    store,
    logger,
    settings: () => settings,
    createGateway: () => gateway,
    systemPrompt: '你是测试用 Agent。所有文件操作仅限工作区内。',
    onEvent: (ev) => events.push(ev)
  });
  return { store, gateway, service, events, workspace: opts.workspace };
}

export const TEST_MODEL_CONFIG = {
  baseUrl: 'http://localhost:9/v1',
  apiKey: 'test-key-sk-1234567890',
  model: 'test-model'
};

export async function startAndWait(
  built: BuiltService,
  goal = '测试任务'
): Promise<{ taskId: string; report: FinalReport }> {
  const { taskId } = await built.service.startTask({
    goal,
    workspace: built.workspace,
    modelConfig: TEST_MODEL_CONFIG
  });
  const report = await built.service.waitForTask(taskId);
  return { taskId, report };
}

export async function until<T>(
  fn: () => T | undefined | null | false,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('until: 等待条件超时');
}

export type { ModelError, ToolCallRecord };
