import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentLoop } from './loop';
import { DefaultVerifier } from './verifier';
import { createDefaultRegistry } from '../tools';
import { PolicyEngine } from '../policy/policy';
import {
  PolicyViolationError,
  requireRealInsideWorkspace,
  resolveInsideWorkspace
} from '../policy/paths';
import type { Store } from '../persistence/store';
import type { BrowserSessionManager } from '../tools/browser/session';
import type { McpManager } from '../tools/mcp/manager';
import type { ChatMessage, ModelGateway } from '../gateway/types';
import type {
  FinalReport,
  FileChangeRecord,
  ModelConfig,
  PersistedSettings,
  PlanStep,
  TaskEvent,
  TaskEventType,
  TaskStatus,
  TemplateConstraints
} from '../shared/types';
import { TERMINAL_STATUSES } from '../shared/types';
import type { Logger } from '../main/logger';

/**
 * AgentService：Agent Core 的对外门面（供 Electron 主进程 / 未来 CLI 复用）。
 * 负责任务生命周期、事件落库与转发、审批等待、暂停/恢复与崩溃恢复标记。
 */

export interface AgentServiceOptions {
  store: Store;
  logger: Logger;
  settings: () => PersistedSettings;
  createGateway: (cfg: ModelConfig) => ModelGateway;
  systemPrompt: string;
  onEvent?: (event: TaskEvent) => void;
  /** 搜索服务 API Key 的内存读取器（密钥绝不进入配置/日志/事件） */
  searchApiKey?: () => string | null;
  /** 浏览器会话管理器（仅当用户启用浏览器自动化时传入；负责每任务上下文生命周期） */
  browserManager?: BrowserSessionManager;
  /** MCP 连接管理器（进程级共享；任务取消只中止单次调用，不关连接） */
  mcpManager?: McpManager;
}

export interface TemplateRef {
  id: string;
  name: string;
  /** 参数审计摘要（已脱敏/截断），写入事件日志；原始值不落事件 */
  paramsAudit?: Record<string, string>;
}

export interface StartTaskInput {
  goal: string;
  acceptance?: string;
  workspace: string;
  modelConfig: ModelConfig;
  /** 执行约束：与全局设置逐项取更严格值（min/子集），只能收紧 */
  constraints?: TemplateConstraints;
  templateRef?: TemplateRef;
}

export class AgentService {
  private readonly running = new Map<string, AgentLoop>();
  private readonly approvalWaiters = new Map<string, (approved: boolean) => void>();
  private readonly taskWaiters = new Map<string, (report: FinalReport) => void>();
  private readonly cachedModelConfig = new Map<string, ModelConfig>();

  constructor(private readonly opts: AgentServiceOptions) {}

  async startTask(input: StartTaskInput): Promise<{ taskId: string }> {
    if (!input.goal || input.goal.trim().length === 0) {
      throw new Error('任务目标不能为空');
    }
    if (!fs.existsSync(input.workspace)) {
      throw new Error(`工作区不存在：${input.workspace}`);
    }
    if (!input.modelConfig?.apiKey) {
      throw new Error('尚未配置模型 API Key，请先在设置中填写');
    }
    const taskId = randomUUID();
    this.opts.store.createTask({
      id: taskId,
      goal: input.goal,
      acceptance: input.acceptance,
      workspace: input.workspace,
      templateId: input.templateRef?.id,
      templateName: input.templateRef?.name
    });
    this.cachedModelConfig.set(taskId, input.modelConfig);
    this.opts.logger.info('task.start', { taskId, workspace: input.workspace, model: input.modelConfig.model, template: input.templateRef?.name });
    // 异步执行，UI 立即拿到 taskId
    void this.execute(taskId, input.workspace, input.goal, input.acceptance, undefined, {
      constraints: input.constraints,
      templateRef: input.templateRef
    });
    return { taskId };
  }

  waitForTask(taskId: string): Promise<FinalReport> {
    const existing = this.opts.store.getTask(taskId);
    if (existing && ['completed', 'needs_review', 'failed', 'cancelled'].includes(existing.status)) {
      const report = (existing.report as FinalReport | undefined) ?? {
        status: existing.status,
        reasons: existing.error ? [existing.error] : [],
        warnings: []
      };
      return Promise.resolve(report);
    }
    return new Promise((resolve) => {
      this.taskWaiters.set(taskId, resolve);
    });
  }

  cancelTask(taskId: string): void {
    const loop = this.running.get(taskId);
    this.opts.logger.info('task.cancel', { taskId });
    // 取消循环：中止进行中的模型调用，且后续不再启动新的工具执行
    loop?.cancel();
    // 等待中的审批一并解除（拒绝），让循环尽快退出
    for (const [actionId, resolve] of [...this.approvalWaiters]) {
      const pending = this.opts.store.getPendingAction(actionId);
      if (pending?.taskId === taskId && pending.status === 'pending') {
        this.opts.store.resolvePendingAction(actionId, 'denied');
        this.approvalWaiters.delete(actionId);
        resolve(false);
      }
    }
  }

  pauseTask(taskId: string): boolean {
    const loop = this.running.get(taskId);
    if (!loop) return false;
    loop.requestPause();
    return true;
  }

  async resumeTask(taskId: string, modelConfig?: ModelConfig): Promise<void> {
    const task = this.opts.store.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    if (task.status !== 'paused' && task.status !== 'interrupted') {
      throw new Error(`任务当前状态为 ${task.status}，无法恢复`);
    }
    if (modelConfig?.apiKey) {
      this.cachedModelConfig.set(taskId, modelConfig);
    }
    const cfg = this.cachedModelConfig.get(taskId);
    if (!cfg?.apiKey) {
      throw new Error('恢复任务需要模型配置，请先在设置中填写 API Key');
    }
    let transcript: ChatMessage[] = [];
    if (task.transcriptJson) {
      try {
        transcript = JSON.parse(task.transcriptJson) as ChatMessage[];
      } catch {
        transcript = [];
      }
    }
    // 副作用防护：恢复时告知模型此前已实际写入磁盘的文件，避免盲目重复
    const pendingChanges = this.opts.store
      .listFileChanges(taskId)
      .filter((c) => c.restoredAt === null);
    if (pendingChanges.length > 0) {
      const paths = [...new Set(pendingChanges.map((c) => c.path))];
      transcript.push({
        role: 'user',
        content: `[系统] 恢复提示：此任务此前已实际修改以下文件：${paths.join('、')}。除非验证确有需要，不要重复这些写入操作。`
      });
    }
    // 恢复计划状态：中断任务的 plan_json 回灌，update_plan 在恢复后仍可用
    let resumePlan: PlanStep[] | undefined;
    if (task.planJson) {
      try {
        const parsed = JSON.parse(task.planJson) as { steps?: PlanStep[] };
        resumePlan = Array.isArray(parsed.steps) ? parsed.steps : undefined;
      } catch {
        resumePlan = undefined;
      }
    }
    this.opts.store.updateTaskStatus(taskId, 'queued');
    this.opts.logger.info('task.resume', { taskId });
    void this.execute(taskId, task.workspace, task.goal, task.acceptance, transcript, { resumePlan });
  }

  /** 用户对某个待审批操作做出决定 */
  resolveApproval(actionId: string, approved: boolean): boolean {    const pending = this.opts.store.getPendingAction(actionId);
    if (!pending || pending.status !== 'pending') return false;
    this.opts.store.resolvePendingAction(actionId, approved ? 'approved' : 'denied');
    const waiter = this.approvalWaiters.get(actionId);
    if (waiter) {
      this.approvalWaiters.delete(actionId);
      waiter(approved);
    }
    return true;
  }

  /**
   * 将一条文件变更回滚为修改前内容：
   * - modify（有备份）→ 写回备份内容；
   * - create（无备份）→ 删除该文件（由任务创建）。
   * 仅允许对处于终态/interrupted 的任务操作，且路径重新经过完整安全检查。
   */
  restoreFileChange(
    taskId: string,
    changeId: number
  ): { restored: boolean; path: string; action: 'reverted' | 'deleted' | 'missing' | 'noop' } {
    const task = this.opts.store.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    this.assertTaskRestorable(task.id, task.status);
    const change = task.fileChanges.find((c) => c.id === changeId);
    if (!change) throw new Error('变更记录不存在');
    if (change.restoredAt !== null) {
      return { restored: false, path: change.path, action: 'noop' };
    }
    const backup = this.opts.store.getFileChangeBackup(changeId)?.backupContent ?? null;
    const action = this.applyRestore(task.workspace, change.path, backup);
    this.opts.store.markFileChangeRestored(changeId);
    this.opts.store.addEvent(taskId, 'file_restored', { path: change.path, action, scope: 'single' });
    this.opts.logger.info('file.restore', { taskId, path: change.path, action });
    return { restored: action !== 'missing', path: change.path, action };
  }

  /** 回滚任务全部未恢复的文件变更：每个路径恢复到任务执行前的状态（最早记录优先）。 */
  restoreTaskFiles(taskId: string): { paths: string[] } {
    const task = this.opts.store.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    this.assertTaskRestorable(task.id, task.status);
    const unrestored = task.fileChanges.filter((c) => c.restoredAt === null);
    const byPath = new Map<string, FileChangeRecord[]>();
    for (const c of unrestored) {
      byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
    }
    const paths: string[] = [];
    for (const [p, changes] of byPath) {
      const earliest = changes.reduce((a, b) => (a.id <= b.id ? a : b));
      const backup = this.opts.store.getFileChangeBackup(earliest.id)?.backupContent ?? null;
      const action = this.applyRestore(task.workspace, p, backup);
      for (const c of changes) this.opts.store.markFileChangeRestored(c.id);
      this.opts.store.addEvent(taskId, 'file_restored', { path: p, action, scope: 'all' });
      this.opts.logger.info('file.restoreAll', { taskId, path: p, action });
      paths.push(p);
    }
    return { paths };
  }

  private assertTaskRestorable(taskId: string, status: TaskStatus): void {
    const restorable = TERMINAL_STATUSES.includes(status) || status === 'interrupted';
    if (!restorable) {
      throw new Error(`任务当前状态为 ${status}，仍在运行或等待审批，不能回滚文件（请先取消或等待结束）`);
    }
    void taskId;
  }

  /** 执行实际回滚；所有路径检查与工具层一致（防穿越/防符号链接）。 */
  private applyRestore(
    workspace: string,
    relPath: string,
    backup: string | null
  ): 'reverted' | 'deleted' | 'missing' {
    const abs = resolveInsideWorkspace(workspace, relPath);
    if (backup === null) {
      // 任务创建的文件：删除（拒绝目录与符号链接）
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return 'missing';
      }
      if (st.isDirectory()) throw new Error('目标是目录，不能自动删除');
      if (st.isSymbolicLink()) throw new PolicyViolationError('目标是符号链接，拒绝删除');
      requireRealInsideWorkspace(workspace, abs);
      fs.rmSync(abs);
      return 'deleted';
    }
    const parent = path.dirname(abs);
    if (!fs.existsSync(parent)) {
      throw new PolicyViolationError(`父目录不存在：${parent}`);
    }
    requireRealInsideWorkspace(workspace, parent);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = undefined;
    }
    if (st?.isSymbolicLink()) throw new PolicyViolationError('目标是符号链接，拒绝写入');
    fs.writeFileSync(abs, backup, 'utf8');
    return 'reverted';
  }

  /** 应用启动时调用：把上次异常退出遗留的未完成任务标记为 interrupted */
  recoverOnStartup(): number {
    const unfinished = this.opts.store.findUnfinishedTasks();
    for (const t of unfinished) {
      // 防御性关闭可能残留的浏览器会话（进程内上下文，通常已随上次退出销毁；幂等）
      if (this.opts.browserManager) {
        void this.opts.browserManager.closeTask(t.id).catch(() => undefined);
      }
      // 遗留的待审批操作标记过期（等待审批的任务中断后审批已无意义）
      for (const pa of this.opts.store.listPendingActions(t.id)) {
        if (pa.status === 'pending') this.opts.store.resolvePendingAction(pa.id, 'expired');
      }
      this.opts.store.updateTaskStatus(t.id, 'interrupted');
      this.opts.store.addEvent(t.id, 'status_changed', {
        from: t.status,
        to: 'interrupted',
        note: '应用启动时检测到上次运行未完成，已标记中断；可在任务列表中恢复'
      });
      this.opts.logger.warn('task.recover.interrupted', { taskId: t.id, previous: t.status });
    }
    return unfinished.length;
  }

  listTasks() {
    return this.opts.store.listTasks();
  }

  getTask(id: string) {
    return this.opts.store.getTask(id);
  }

  // ------------------------------------------------------------------

  private async execute(
    taskId: string,
    workspace: string,
    goal: string,
    acceptance: string | undefined,
    resumeTranscript: ChatMessage[] | undefined,
    runOpts?: { constraints?: TemplateConstraints; templateRef?: TemplateRef; resumePlan?: PlanStep[] }
  ): Promise<void> {
    const settings = this.opts.settings();
    const cfg = this.cachedModelConfig.get(taskId);
    if (!cfg) {
      this.finishWithError(taskId, '缺少模型配置');
      return;
    }
    // 预算程序强制：模板约束与全局设置逐项取更严格值（只能收紧，不能放宽）
    const c = runOpts?.constraints;
    const budgets = {
      maxSteps: c?.maxSteps ? Math.min(settings.maxSteps, c.maxSteps) : settings.maxSteps,
      taskTimeoutMs: c?.taskTimeoutMs
        ? Math.min(settings.taskTimeoutMs, c.taskTimeoutMs)
        : settings.taskTimeoutMs,
      modelTimeoutMs: settings.modelTimeoutMs,
      toolResultMaxChars: settings.toolResultMaxChars,
      maxContextChars: settings.maxContextChars
    };
    const gateway = this.opts.createGateway(cfg);
    // 工具白名单：注册表子集（模型端过滤）+ loop 执行端强制，双端生效
    let registry = createDefaultRegistry({
      webSearch: {
        provider: settings.searchProvider,
        baseUrl: settings.searchBaseUrl,
        apiKey: this.opts.searchApiKey ?? (() => null)
      },
      ...(settings.browserEnabled && this.opts.browserManager
        ? { browser: { manager: this.opts.browserManager } }
        : {}),
      ...(this.opts.mcpManager ? { mcp: { manager: this.opts.mcpManager } } : {})
    });
    if (c?.allowedTools?.length) {
      registry = registry.subset(c.allowedTools);
    }
    const policy = new PolicyEngine({
      allowedTestCommands: settings.allowedTestCommands,
      autoApproveTestCommands: settings.autoApproveTestCommands,
      requireApprovalForWrites: settings.requireApprovalForWrites,
      requireApprovalForWeb: settings.requireApprovalForWeb,
      requireApprovalForMcp: settings.requireApprovalForMcp
    });

    const hooks = {
      emit: (ev: { type: TaskEventType; data: Record<string, unknown> }) => {
        const stored = this.opts.store.addEvent(taskId, ev.type, ev.data);
        try {
          this.opts.onEvent?.(stored);
        } catch (err) {
          this.opts.logger.error('event.forward.failed', { taskId, error: String(err) });
        }
      },
      setTaskStatus: (status: TaskStatus) => {
        this.opts.store.updateTaskStatus(taskId, status);
        hooks.emit({ type: 'status_changed', data: { status } });
      },
      saveTranscript: (json: string) => {
        try {
          this.opts.store.saveTranscript(taskId, json);
        } catch (err) {
          this.opts.logger.error('transcript.save.failed', { taskId, error: String(err) });
        }
      },
      savePlan: (json: string) => {
        try {
          this.opts.store.setTaskPlan(taskId, json);
        } catch (err) {
          this.opts.logger.error('plan.save.failed', { taskId, error: String(err) });
        }
      },
      recordFileChange: (rec: { path: string; kind: 'create' | 'modify'; backupContent: string | null }) => {
        try {
          this.opts.store.addFileChange({ taskId, ...rec });
        } catch (err) {
          this.opts.logger.error('filechange.save.failed', { taskId, path: rec.path, error: String(err) });
        }
      },
      recordToolCall: (rec: {
        id: string;
        name: string;
        argsSummary: string;
        status: string;
        durationMs: number;
        resultSummary: string;
      }) => {
        this.opts.store.addToolCall({ ...rec, taskId });
      },
      requestApproval: (req: { id: string; toolName: string; argsSummary: string; reason: string }) => {
        this.opts.store.addPendingAction({ ...req, taskId });
        return new Promise<boolean>((resolve) => {
          this.approvalWaiters.set(req.id, resolve);
        });
      }
    };

    const loop = new AgentLoop(
      {
        gateway,
        registry,
        policy,
        verifier: new DefaultVerifier(),
        budgets,
        systemPrompt: this.opts.systemPrompt,
        model: { temperature: cfg.temperature, maxTokens: cfg.maxTokens },
        hooks,
        allowedTools: registry.list().map((d) => d.name)
      },
      { taskId, workspace, goal, acceptance }
    );

    this.running.set(taskId, loop);
    this.opts.store.updateTaskStatus(taskId, 'running');
    hooks.emit({
      type: 'task_started',
      data: {
        goal,
        workspace,
        resume: !!resumeTranscript,
        // 模板溯源：仅记录 id/名称与参数审计摘要（已脱敏），不含参数原文
        template: runOpts?.templateRef
          ? {
              id: runOpts.templateRef.id,
              name: runOpts.templateRef.name,
              params: runOpts.templateRef.paramsAudit ?? {}
            }
          : undefined
      }
    });

    let report: FinalReport;
    try {
      const outcome = await loop.run(resumeTranscript, runOpts?.resumePlan);
      const verdict = outcome.verdict;
      report = {
        status: outcome.status === 'paused' ? 'paused' : (outcome.status as FinalReport['status']),
        summary: outcome.finish?.summary,
        verification: outcome.finish?.verification,
        blockers: outcome.finish?.blockers,
        reasons: verdict?.reasons ?? (outcome.reason ? [outcome.reason] : []),
        warnings: verdict?.warnings ?? []
      };
      if (outcome.status === 'paused') {
        this.opts.store.updateTaskStatus(taskId, 'paused');
      } else {
        this.opts.store.finishTask(taskId, {
          status: report.status,
          summary: report.summary,
          report,
          error: outcome.status === 'failed' ? outcome.reason : undefined
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger.error('task.loop.crashed', { taskId, error: message });
      report = {
        status: 'failed',
        reasons: [`执行循环异常终止：${message}`],
        warnings: []
      };
      this.opts.store.finishTask(taskId, { status: 'failed', report, error: message });
    }
    this.running.delete(taskId);
    // 任务结束（含取消/失败/暂停之外的一切终态路径）→ 关闭并清理该任务的浏览器上下文（幂等）
    if (this.opts.browserManager) {
      await this.opts.browserManager.closeTask(taskId).catch(() => undefined);
    }
    const waiter = this.taskWaiters.get(taskId);
    if (waiter) {
      this.taskWaiters.delete(taskId);
      waiter(report);
    }

    hooks.emit({
      type: 'task_finished',
      data: report as unknown as Record<string, unknown>
    });
    this.opts.logger.info('task.finished', { taskId, status: report.status });
  }

  private finishWithError(taskId: string, message: string): void {
    const report: FinalReport = { status: 'failed', reasons: [message], warnings: [] };
    this.opts.store.finishTask(taskId, { status: 'failed', report, error: message });
    this.opts.store.addEvent(taskId, 'task_finished', report as unknown as Record<string, unknown>);
  }
}

function fsExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
void fsExists;
