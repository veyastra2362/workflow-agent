import { randomUUID } from 'node:crypto';
import { buildContextView } from './context';
import { redactValue } from '../policy/redact';
import type { PolicyDecision } from '../policy/policy';
import type { ToolContext, ToolRunResult } from '../tools/registry';
import type { ChatMessage, ChatResponse } from '../gateway/types';
import { describeModelError, isModelAbort } from '../gateway/types';
import type { PlanStep } from '../shared/types';
import type {
  AgentDeps,
  AgentOutcome,
  AgentRunContext,
  FinishRequest
} from './types';

/**
 * Agent Loop：真实的模型决策与工具执行循环。
 *
 * 任务 → 构建 System/Task 消息 → 调用模型 → 解析工具调用 →
 * 参数校验（Registry）+ 权限决策（Policy）→（需要时）用户审批 →
 * 执行工具 → 记录事件 → 结构化结果回填模型 → 判断继续/结束 →
 * complete_task → Verifier 验收 → 最终状态。
 *
 * 安全边界（程序层面，非提示词）：
 * - 最大决策步数 / 任务总超时 / 单次模型超时 / 工具超时 / 输出长度上限；
 * - 用户取消：任意模型调用或工具执行前检查，取消后不再启动新的工具调用；
 * - 重复调用防护：同一（工具+参数）重复多次时注入警告，超限强制停止；
 * - 悬空 tool_calls 修复：任何中断路径都会为未应答的调用补上 tool 消息。
 */

const MAX_NUDGES = 2;
const REPETITION_WARN_AT = 3;
const REPETITION_STOP_AT = 5;
/** run_tests 失败的最大修复轮次，超过后安全停止 */
const MAX_TEST_REPAIR_ROUNDS = 4;
/** 连续工具失败：警告与停止阈值（防止无效修复循环） */
const CONSECUTIVE_WARN_AT = 4;
const CONSECUTIVE_STOP_AT = 6;
/** 测试未通过时 complete_task 的最大拒绝次数（之后放行交给 Verifier 裁决，避免死锁） */
const MAX_COMPLETE_REJECTIONS = 1;

const TEST_REPAIR_INSTRUCTION =
  '[系统] 测试未通过。请：1) 阅读上方测试输出，定位失败根因；2) 实施影响范围最小的修复；3) 重新运行 run_tests 验证。在测试通过之前不要宣告任务完成（complete_task 会被程序拒绝）。';

export class AgentLoop {
  private transcript: ChatMessage[] = [];
  private stepCount = 0;
  private finish: FinishRequest | null = null;
  private readonly abortController = new AbortController();
  private pauseRequested = false;
  private readonly callSignatureCounts = new Map<string, number>();
  private nudges = 0;
  private toolRecords: Array<{ name: string; ok: boolean }> = [];
  private readonly fileChangeBackups = new Map<string, string | null>();
  private deniedApprovals = 0;
  private startedAt = 0;
  private plan: PlanStep[] = [];
  private lastTestsFailed = false;
  private testFailureRounds = 0;
  private consecutiveFailures = 0;
  private completeRejections = 0;
  /** 任务总超时触发标记：abort 同时区分「超时中止」与「用户取消」两种终态 */
  private timedOut = false;
  private taskTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: AgentDeps,
    private readonly ctx: AgentRunContext
  ) {}

  requestPause(): void {
    this.pauseRequested = true;
  }

  cancel(): void {
    this.abortController.abort();
  }

  /** existingTranscript 非空时表示从检查点恢复；initialPlan 用于恢复计划状态。 */
  async run(existingTranscript?: ChatMessage[], initialPlan?: PlanStep[]): Promise<AgentOutcome> {
    const { budgets } = this.deps;
    this.startedAt = Date.now();
    this.timedOut = false;
    // 任务总超时：定时器实际中止进行中的模型调用与工具执行（经 abort 信号），
    // 而非仅在步骤边界记录超时状态
    this.taskTimer = setTimeout(() => {
      this.timedOut = true;
      this.abortController.abort();
    }, budgets.taskTimeoutMs);
    this.taskTimer.unref?.();
    try {
      return await this.runInner(existingTranscript, initialPlan);
    } finally {
      if (this.taskTimer) clearTimeout(this.taskTimer);
    }
  }

  private async runInner(
    existingTranscript?: ChatMessage[],
    initialPlan?: PlanStep[]
  ): Promise<AgentOutcome> {
    const { budgets } = this.deps;
    this.transcript = existingTranscript ? [...existingTranscript] : [];
    if (initialPlan?.length) {
      this.plan = initialPlan.map((s) => ({ ...s }));
    }

    if (this.transcript.length === 0) {
      this.transcript.push({ role: 'system', content: this.deps.systemPrompt });
      this.transcript.push({ role: 'user', content: this.buildTaskMessage() });
    } else {
      this.transcript.push({
        role: 'user',
        content:
          '[系统] 任务此前被中断，现在恢复执行。请基于已保存的上下文继续，避免重复执行可能已产生副作用的操作。'
      });
    }
    this.deps.hooks.saveTranscript(JSON.stringify(this.transcript));

    while (true) {
      if (this.abortController.signal.aborted) {
        return this.abortOutcome();
      }
      if (this.pauseRequested) {
        return { status: 'paused', reason: '用户请求暂停' };
      }
      if (this.timedOut) {
        return this.outcome(
          'failed',
          `任务总耗时超过上限（${Math.round(budgets.taskTimeoutMs / 1000)}s），已强制中止`
        );
      }
      if (this.stepCount >= budgets.maxSteps) {
        return this.outcome('failed', `已达最大决策次数（${budgets.maxSteps}），安全停止`);
      }
      this.stepCount += 1;

      const response = await this.callModel();
      if (isAgentOutcome(response)) {
        // 模型调用失败/取消等终态
        return response;
      }

      // 记录 assistant 消息
      const assistantMsg: ChatMessage = { role: 'assistant', content: response.content };
      if (response.toolCalls.length > 0) assistantMsg.tool_calls = response.toolCalls;
      this.transcript.push(assistantMsg);
      if (response.content && response.content.trim().length > 0) {
        this.deps.hooks.emit({ type: 'model_message', data: { text: response.content } });
      }
      this.deps.hooks.saveTranscript(JSON.stringify(this.transcript));

      if (response.toolCalls.length === 0) {
        if (this.finish) break;
        if (this.nudges < MAX_NUDGES) {
          this.nudges += 1;
          this.transcript.push({
            role: 'user',
            content:
              '[系统] 请继续：如果任务已完成，调用 complete_task 提交总结与验证说明；如果未完成，继续使用工具执行。'
          });
          continue;
        }
        return this.outcome(
          'needs_review',
          '模型连续输出纯文本，既未调用 complete_task 也未继续使用工具'
        );
      }

      const finished = await this.executeToolCalls(response.toolCalls);
      if (finished === 'cancelled') {
        return this.abortOutcome();
      }
      if (finished === 'repetition') {
        return this.outcome('needs_review', '检测到对相同工具与参数的重复调用超过上限，安全停止');
      }
      if (finished === 'tests_exhausted') {
        return this.outcome(
          'needs_review',
          `测试修复轮次已达上限（连续 ${MAX_TEST_REPAIR_ROUNDS} 轮 run_tests 失败），任务安全停止`
        );
      }
      if (finished === 'consecutive_failures') {
        return this.outcome('needs_review', `连续 ${CONSECUTIVE_STOP_AT} 次工具调用失败，疑似无效修复循环，任务安全停止`);
      }
      if (this.finish) break;
    }

    return this.verifyAndFinish();
  }

  // ------------------------------------------------------------------

  private outcome(status: AgentOutcome['status'], reason: string): AgentOutcome {
    return { status, reason, finish: this.finish ?? undefined };
  }

  /** abort 之后的终态：超时触发 → failed(超时)；用户取消 → cancelled */
  private abortOutcome(): AgentOutcome {
    if (this.timedOut) {
      const secs = Math.round(this.deps.budgets.taskTimeoutMs / 1000);
      return this.outcome('failed', `任务总耗时超过上限（${secs}s），已强制中止`);
    }
    return this.outcome('cancelled', '任务被用户取消');
  }

  private buildTaskMessage(): string {
    const lines = [
      `任务目标：${this.ctx.goal}`,
      `验收标准：${this.ctx.acceptance?.trim() || '用户未显式给出；请以目标合理达成为准，完成前必须实际验证。'}`,
      `工作区（所有文件操作仅限此目录内）：${this.ctx.workspace}`,
      `开始时间：${new Date(this.startedAt).toISOString()}`
    ];
    return lines.join('\n');
  }

  /**
   * 调用模型；失败时先重试一次，仍失败返回错误终态（AgentOutcome）。
   */
  private async callModel(): Promise<ChatResponse | AgentOutcome> {
    const { gateway, budgets, model, hooks } = this.deps;
    const view = buildContextView(this.transcript, budgets.maxContextChars);
    const req = {
      messages: view.messages,
      tools: this.deps.registry.toModelTools(),
      temperature: model.temperature,
      maxTokens: model.maxTokens
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.abortController.signal.aborted) {
        return this.abortOutcome();
      }
      try {
        return await gateway.chat(req, this.abortController.signal);
      } catch (err) {
        if (isModelAbort(err) || this.abortController.signal.aborted) {
          return this.abortOutcome();
        }
        hooks.emit({
          type: 'error',
          data: { scope: 'model_call', attempt: attempt + 1, message: describeModelError(err) }
        });
        if (attempt === 0) {
          const ok = await this.interruptibleSleep(1500);
          if (!ok) return this.abortOutcome();
          continue;
        }
        return this.outcome('failed', `模型调用失败：${describeModelError(err)}`);
      }
    }
    return this.outcome('failed', '模型调用失败：未知错误');
  }

  private async interruptibleSleep(ms: number): Promise<boolean> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return !this.abortController.signal.aborted;
  }

  /** 执行一批工具调用；返回终态标记或 undefined（正常继续）。 */
  private async executeToolCalls(
    calls: NonNullable<ChatMessage['tool_calls']>
  ): Promise<'cancelled' | 'repetition' | 'tests_exhausted' | 'consecutive_failures' | undefined> {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (this.abortController.signal.aborted) {
        this.fillDanglingToolCalls(calls.slice(i), 'CANCELLED');
        return 'cancelled';
      }

      // ---- 重复调用防护 ----
      const sig = this.callSignature(call);
      const count = (this.callSignatureCounts.get(sig) ?? 0) + 1;
      this.callSignatureCounts.set(sig, count);
      if (count >= REPETITION_STOP_AT) {
        this.transcript.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: false,
            error: { code: 'REPETITION_LIMIT', message: '重复调用同一工具与参数超过上限，任务安全停止' }
          })
        });
        return 'repetition';
      }

      const argsSummary = summarizeArgs(call.argumentsJson);
      let toolMsgContent = '';
      let rejected: { code: string; message: string } | null = null;
      let execResult: ToolRunResult | null = null;

      const def = this.deps.allowedTools && !this.deps.allowedTools.includes(call.name)
        ? undefined
        : this.deps.registry.get(call.name);
      if (!def) {
        // 执行端强制：任务级白名单之外的调用（即使模型绕过工具声明提交）一律拒绝
        rejected = this.deps.allowedTools && !this.deps.allowedTools.includes(call.name)
          ? { code: 'TOOL_NOT_ALLOWED', message: `工具 "${call.name}" 不在本任务允许的工具集内` }
          : { code: 'UNKNOWN_TOOL', message: `未知工具 "${call.name}"，请改用已提供的工具` };
        toolMsgContent = JSON.stringify({ ok: false, error: rejected });
      } else {
        // ---- 权限决策 ----
        let parsedArgs: unknown = undefined;
        try {
          parsedArgs = JSON.parse(call.argumentsJson || '{}');
        } catch {
          parsedArgs = undefined;
        }
        const decision: PolicyDecision = this.deps.policy.decide(call.name, def.riskLevel, parsedArgs);
        let approved: boolean | 'cancelled' = true;
        if (decision.action === 'deny') {
          rejected = { code: 'POLICY_DENIED', message: decision.reason };
          toolMsgContent = JSON.stringify({ ok: false, error: rejected });
          approved = false;
        } else if (decision.action === 'ask') {
          approved = await this.requestUserApproval(call, argsSummary, decision.reason);
          if (approved === 'cancelled') {
            this.fillDanglingToolCalls(calls.slice(i), 'CANCELLED');
            return 'cancelled';
          }
          if (!approved) {
            this.deniedApprovals += 1;
            rejected = { code: 'DENIED_BY_USER', message: '用户拒绝了该操作。请调整方案或改用其他方式，不要原样重试。' };
            toolMsgContent = JSON.stringify({ ok: false, error: rejected });
          }
        }

        if (approved) {
          this.deps.hooks.emit({
            type: 'tool_call_started',
            data: { callId: call.id, name: call.name, argsSummary }
          });
          const result = await this.deps.registry.run(call.name, call.argumentsJson, this.toolCtx(), {
            maxResultChars: this.deps.budgets.toolResultMaxChars
          });
          execResult = result;
          this.toolRecords.push({ name: call.name, ok: result.ok });
          this.deps.hooks.recordToolCall({
            id: call.id,
            name: call.name,
            argsSummary,
            status: result.ok ? 'ok' : 'error',
            durationMs: result.durationMs,
            resultSummary: result.summary
          });
          this.deps.hooks.emit({
            type: 'tool_call_finished',
            data: {
              callId: call.id,
              name: call.name,
              ok: result.ok,
              summary: result.summary,
              durationMs: result.durationMs,
              error: result.error ?? null
            }
          });
          toolMsgContent = JSON.stringify(
            result.ok
              ? { ok: true, summary: result.summary, data: result.data }
              : { ok: false, error: result.error, summary: result.summary }
          );
        }
      }

      // ---- 拒绝统一审计：未知工具 / 白名单外 / 策略拒绝 / 用户拒绝 均记录留痕 ----
      if (rejected && !execResult) {
        const summary = `${rejected.code}: ${rejected.message.slice(0, 140)}`;
        this.deps.hooks.recordToolCall({
          id: call.id,
          name: call.name,
          argsSummary,
          status: 'rejected',
          durationMs: 0,
          resultSummary: summary
        });
        this.deps.hooks.emit({
          type: 'tool_call_finished',
          data: { callId: call.id, name: call.name, ok: false, summary, durationMs: 0, error: rejected }
        });
      }

      // ---- 控制类工具（计划 / 完成）在写入上下文前裁决 ----
      if (execResult?.ok) {
        const override = this.handleControlTool(call);
        if (override !== null) toolMsgContent = override;
      }

      this.transcript.push({ role: 'tool', tool_call_id: call.id, content: toolMsgContent });

      // ---- run_tests 结果跟踪：失败注入修复指令，超过轮次上限安全停止 ----
      if (execResult?.ok && call.name === 'run_tests') {
        const data = (execResult.data ?? {}) as { exitCode?: number; timedOut?: boolean };
        if (data.exitCode === 0 && !data.timedOut) {
          this.lastTestsFailed = false;
        } else {
          this.lastTestsFailed = true;
          this.testFailureRounds += 1;
          if (this.testFailureRounds >= MAX_TEST_REPAIR_ROUNDS) {
            this.fillDanglingToolCalls(calls.slice(i + 1), 'STOPPED');
            return 'tests_exhausted';
          }
          this.transcript.push({ role: 'user', content: TEST_REPAIR_INSTRUCTION });
        }
      }

      // ---- 连续失败防护：疑似无效修复循环时安全停止 ----
      if (execResult && !execResult.ok) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= CONSECUTIVE_STOP_AT) {
          this.fillDanglingToolCalls(calls.slice(i + 1), 'STOPPED');
          return 'consecutive_failures';
        }
        if (this.consecutiveFailures === CONSECUTIVE_WARN_AT) {
          this.transcript.push({
            role: 'user',
            content: `[系统] 警告：已连续 ${this.consecutiveFailures} 次工具调用失败。请停下来重新分析根因并改变策略，否则任务将被强制停止。`
          });
        }
      } else if (execResult?.ok) {
        this.consecutiveFailures = 0;
      }

      // ---- 重复调用警告 ----
      if (count === REPETITION_WARN_AT) {
        this.transcript.push({
          role: 'user',
          content: `[系统] 警告：相同的工具调用（${call.name}，相同参数）已重复 ${count} 次。请分析原因并改变策略；若继续原样重复，任务将被强制停止。`
        });
      }

      this.deps.hooks.saveTranscript(JSON.stringify(this.transcript));
    }
    return undefined;
  }

  private async requestUserApproval(
    call: { id: string; name: string },
    argsSummary: string,
    reason: string
  ): Promise<true | false | 'cancelled'> {
    const actionId = randomUUID();
    this.deps.hooks.emit({
      type: 'approval_required',
      data: { actionId, toolName: call.name, callId: call.id, argsSummary, reason }
    });
    this.deps.hooks.setTaskStatus('waiting_approval');
    try {
      const approved = await Promise.race([
        this.deps.hooks.requestApproval({
          id: actionId,
          toolName: call.name,
          argsSummary,
          reason
        }),
        // 任务超时/取消时解除审批等待，避免卡死在等待用户输入
        new Promise<false>((resolve) => {
          this.abortController.signal.addEventListener('abort', () => resolve(false), { once: true });
        })
      ]);
      this.deps.hooks.emit({ type: 'approval_resolved', data: { actionId, approved } });
      return approved;
    } catch {
      return 'cancelled';
    } finally {
      this.deps.hooks.setTaskStatus('running');
    }
  }

  /**
   * 控制类工具（submit_plan / update_plan / complete_task）的循环内裁决。
   * 返回 null 表示沿用工具自身结果；返回字符串则覆盖回填给模型的内容。
   */
  private handleControlTool(call: NonNullable<ChatMessage['tool_calls']>[number]): string | null {
    const parsed = safeParse(call.argumentsJson) as Record<string, unknown> | null;

    if (call.name === 'submit_plan') {
      const steps = Array.isArray(parsed?.steps) ? (parsed!.steps as unknown[]) : [];
      if (steps.length === 0) return null;
      this.plan = steps
        .slice(0, 20)
        .map((title, i) => ({ index: i + 1, title: String(title), status: 'pending' as const }));
      this.savePlan();
      this.deps.hooks.emit({
        type: 'plan_submitted',
        data: { steps: this.plan.map((s) => s.title) }
      });
      return null;
    }

    if (call.name === 'update_plan') {
      const updates = Array.isArray(parsed?.step_updates)
        ? (parsed!.step_updates as Array<{ index: number; status: 'done' | 'skipped' }>)
        : [];
      if (this.plan.length === 0) {
        return JSON.stringify({
          ok: false,
          error: { code: 'NO_PLAN', message: '尚未提交计划，请先调用 submit_plan' }
        });
      }
      for (const u of updates) {
        if (!this.plan.some((s) => s.index === u.index)) {
          return JSON.stringify({
            ok: false,
            error: {
              code: 'INVALID_PLAN_UPDATE',
              message: `步骤索引 ${u.index} 不存在（当前计划共 ${this.plan.length} 步，索引范围 1-${this.plan.length}）`
            }
          });
        }
      }
      for (const u of updates) {
        const step = this.plan.find((s) => s.index === u.index)!;
        step.status = u.status;
      }
      this.savePlan();
      this.deps.hooks.emit({ type: 'plan_updated', data: { steps: this.plan } });
      return JSON.stringify({ ok: true, data: { acknowledged: true, steps: this.plan } });
    }

    if (call.name === 'complete_task') {
      // 程序级门控：最近一次测试未通过时拒绝宣告完成（有限次），强制先修复
      if (this.lastTestsFailed && this.completeRejections < MAX_COMPLETE_REJECTIONS) {
        this.completeRejections += 1;
        return JSON.stringify({
          ok: false,
          error: {
            code: 'TESTS_NOT_PASSING',
            message:
              '最近一次 run_tests 未通过，不能宣告任务完成。请分析失败输出，实施最小修复并重新运行测试通过后再调用 complete_task。'
          }
        });
      }
      if (parsed?.summary) this.finish = parsed as unknown as FinishRequest;
      return null;
    }

    return null;
  }

  private savePlan(): void {
    this.deps.hooks.savePlan(JSON.stringify({ steps: this.plan }));
  }

  /** 取消时补齐未应答的 tool 消息，保证 transcript 结构一致、可安全恢复。 */
  private fillDanglingToolCalls(calls: NonNullable<ChatMessage['tool_calls']>, code: string): void {
    for (const call of calls) {
      this.transcript.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ ok: false, error: { code, message: `任务${code === 'CANCELLED' ? '已取消' : '中断'}，本次调用未执行` } })
      });
    }
    this.deps.hooks.saveTranscript(JSON.stringify(this.transcript));
  }

  private callSignature(call: { name: string; argumentsJson: string }): string {
    let normalized = call.argumentsJson;
    try {
      normalized = JSON.stringify(JSON.parse(call.argumentsJson));
    } catch {
      normalized = call.argumentsJson;
    }
    return `${call.name}::${normalized}`;
  }

  private toolCtx(): ToolContext {
    const self = this;
    return {
      workspace: this.ctx.workspace,
      taskId: this.ctx.taskId,
      signal: this.abortController.signal,
      cancellationToken: {
        get cancelled() {
          return self.abortController.signal.aborted;
        }
      },
      now: () => Date.now(),
      recordFileChange(rec) {
        self.fileChangeBackups.set(rec.path, rec.backupContent);
        // 持久化变更与备份（供 UI 展示与事后回滚）
        self.deps.hooks.recordFileChange(rec);
        self.deps.hooks.emit({
          type: 'file_changed',
          data: { path: rec.path, kind: rec.kind, backupAvailable: rec.backupContent !== null }
        });
      },
      getRecordedChanges() {
        return [...self.fileChangeBackups.keys()].map((p) => ({
          path: p,
          kind: (self.fileChangeBackups.get(p) === null ? 'create' : 'modify') as 'create' | 'modify'
        }));
      },
      readBackup(relPath: string) {
        return self.fileChangeBackups.get(relPath) ?? null;
      },
      // 工具内审批通道：复用循环的审批等待（含超时/取消 race、事件与状态流转）
      requestApproval: async (payload) => {
        const result = await self.requestUserApproval(
          { id: randomUUID(), name: payload.toolName },
          payload.argsSummary,
          payload.reason
        );
        return result === true;
      }
    };
  }

  private verifyAndFinish(): AgentOutcome {
    const verdict = this.deps.verifier.verify({
      finish: this.finish,
      toolRecords: this.toolRecords,
      fileChanges: [...this.fileChangeBackups.keys()],
      deniedApprovals: this.deniedApprovals,
      acceptance: this.ctx.acceptance,
      testsFailed: this.lastTestsFailed
    });
    return {
      status: verdict.status,
      reason: verdict.reasons.join('；') || undefined,
      finish: this.finish ?? undefined,
      verdict
    };
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isAgentOutcome(x: unknown): x is AgentOutcome {
  return typeof x === 'object' && x !== null && typeof (x as AgentOutcome).status === 'string';
}

function summarizeArgs(argsJson: string): string {
  const parsed = safeParse(argsJson);
  if (parsed === null) return '[参数不是合法 JSON]';
  return JSON.stringify(redactValue(parsed)).slice(0, 300);
}
