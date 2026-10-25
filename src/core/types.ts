import type { ChatMessage, ChatResponse, ModelGateway, ModelRequest, ToolSchemaDef } from '../gateway/types';
import type { PolicyEngine } from '../policy/policy';
import type { ToolRegistry, ToolContext } from '../tools/registry';
import type { TaskEventType, TaskStatus } from '../shared/types';
import type { FinalReport } from '../shared/types';

/**
 * Agent Core 内部类型：循环依赖注入接口与运行产物。
 * Core 不依赖 Electron，可复用于 CLI / API 服务。
 */

export interface Budgets {
  maxSteps: number;
  taskTimeoutMs: number;
  modelTimeoutMs: number;
  toolResultMaxChars: number;
  maxContextChars: number;
}

export interface LoopHooks {
  /** 事件由 Service 统一落库并转发 UI */
  emit(event: { type: TaskEventType; data: Record<string, unknown> }): void;
  setTaskStatus(status: TaskStatus): void;
  /** 保存完整对话记录（JSON 字符串），用于中断恢复 */
  saveTranscript(json: string): void;
  /** 保存/更新任务计划（JSON 字符串：{ steps: PlanStep[] }） */
  savePlan(json: string): void;
  /** 写入类工具修改文件时调用：持久化变更记录与修改前内容备份（用于回滚） */
  recordFileChange(rec: { path: string; kind: 'create' | 'modify'; backupContent: string | null }): void;
  recordToolCall(rec: {
    id: string;
    name: string;
    argsSummary: string;
    status: string;
    durationMs: number;
    resultSummary: string;
  }): void;
  requestApproval(req: {
    id: string;
    toolName: string;
    argsSummary: string;
    reason: string;
  }): Promise<boolean>;
}

export interface AgentRunContext {
  taskId: string;
  workspace: string;
  goal: string;
  acceptance?: string;
}

export interface FinishRequest {
  summary: string;
  verification?: string;
  blockers?: string;
  files_changed?: string[];
}

export interface VerifierInput {
  finish: FinishRequest | null;
  toolRecords: Array<{ name: string; ok: boolean }>;
  fileChanges: string[];
  deniedApprovals: number;
  endReason?: string;
  /** 用户给出的验收标准原文（可能要求测试通过等） */
  acceptance?: string;
  /** 最近一次 run_tests 实际未通过（exitCode != 0 或超时） */
  testsFailed?: boolean;
}

export interface Verdict {
  status: 'completed' | 'needs_review' | 'failed';
  reasons: string[];
  warnings: string[];
}

export interface Verifier {
  verify(input: VerifierInput): Verdict;
}

export interface AgentDeps {
  gateway: ModelGateway;
  registry: ToolRegistry;
  policy: PolicyEngine;
  verifier: Verifier;
  budgets: Budgets;
  systemPrompt: string;
  model: { temperature?: number; maxTokens?: number };
  hooks: LoopHooks;
  /** 任务级工具白名单（执行端强制；undefined = 不限制）。complete_task 由 Service 保证在内。 */
  allowedTools?: readonly string[];
}

export type AgentOutcomeStatus = 'completed' | 'needs_review' | 'failed' | 'cancelled' | 'paused';

export interface AgentOutcome {
  status: AgentOutcomeStatus;
  reason?: string;
  finish?: FinishRequest;
  verdict?: Verdict;
}

export interface PlanSubmission {
  steps: string[];
}

export { type ChatMessage, type ChatResponse, type ModelRequest, type ToolSchemaDef, type ToolContext };
