// 跨进程共享的领域类型：渲染进程与主进程都引用此文件（渲染进程仅做类型导入）。

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'needs_review'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'completed',
  'needs_review',
  'failed',
  'cancelled'
];

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
}

/** 持久化到本地 settings.json 的设置 —— 绝不包含 apiKey。 */
export interface PersistedSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  streaming: boolean;
  maxSteps: number;
  taskTimeoutMs: number;
  modelTimeoutMs: number;
  toolResultMaxChars: number;
  maxContextChars: number;
  allowedTestCommands: string[];
  autoApproveTestCommands: boolean;
  /** 开启后所有写入类工具（write_file / apply_patch）执行前需要用户批准 */
  requireApprovalForWrites: boolean;
  /** 开启后所有联网工具（web_fetch / web_search）执行前需要用户批准 */
  requireApprovalForWeb: boolean;
  /** 搜索服务提供方（none = 未配置，web_search 返回结构化错误） */
  searchProvider: 'none' | 'searxng' | 'brave';
  /** 搜索服务 Base URL（用户显式配置；可指向自建实例）。API Key 只存内存，绝不落盘 */
  searchBaseUrl: string;
  /** 浏览器自动化（4.3）：默认关闭；启用后注册 browser_* 工具（独立隔离上下文） */
  browserEnabled: boolean;
  /** MCP 外部工具默认逐次审批（4.4；关闭需用户显式操作，无服务器级信任开关） */
  requireApprovalForMcp: boolean;
  /** 用户显式配置的 stdio MCP 服务器列表（非敏感；密钥绝不落盘） */
  mcpServers: McpServerConfig[];
  lastWorkspace: string | null;
}

export interface AppSettings extends PersistedSettings {
  hasApiKey: boolean;
  hasSearchKey: boolean;
}

export interface PlanStep {
  index: number;
  title: string;
  status: 'pending' | 'done' | 'skipped';
}

export type TaskEventType =
  | 'task_started'
  | 'plan_submitted'
  | 'plan_updated'
  | 'model_message'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'approval_required'
  | 'approval_resolved'
  | 'file_changed'
  | 'file_restored'
  | 'error'
  | 'status_changed'
  | 'task_finished';

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: number;
  type: TaskEventType;
  data: Record<string, unknown>;
}

export interface FileChangeRecord {
  id: number;
  taskId: string;
  path: string;
  kind: 'create' | 'modify';
  backupAvailable: boolean;
  /** 已回滚的时间戳；null 表示尚未回滚 */
  restoredAt: number | null;
  createdAt: number;
}

export interface PendingActionRecord {
  id: string;
  taskId: string;
  toolName: string;
  argsSummary: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
}

export interface FinalReport {
  status: TaskStatus;
  summary?: string;
  verification?: string;
  blockers?: string;
  reasons: string[];
  warnings: string[];
}

export interface TaskSummary {
  id: string;
  goal: string;
  status: TaskStatus;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  templateId?: string;
  templateName?: string;
}

export interface TaskDetail extends TaskSummary {
  acceptance?: string;
  planJson?: string;
  transcriptJson?: string;
  summary?: string;
  report?: FinalReport;
  error?: string;
  events: TaskEvent[];
  fileChanges: FileChangeRecord[];
  pendingActions: PendingActionRecord[];
  toolCalls: ToolCallRecord[];
}

export interface ToolCallRecord {
  id: string;
  taskId: string;
  name: string;
  argsSummary: string;
  status: string;
  durationMs: number;
  resultSummary: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 任务模板（阶段 4.1）
// ---------------------------------------------------------------------------

export interface TemplateParam {
  name: string;
  description?: string;
  required: boolean;
  default?: string;
}

/** 执行约束：只能收紧（Service 层与全局设置取 min），不能放宽 */
export interface TemplateConstraints {
  maxSteps?: number;
  taskTimeoutMs?: number;
  allowedTools?: string[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: number;
}

export interface TemplateDetail extends TemplateSummary {
  goalTemplate: string;
  acceptanceTemplate?: string;
  params: TemplateParam[];
  constraints: TemplateConstraints;
  createdAt: number;
}

/** 保存模板的输入（id 省略=新建，存在=更新） */
export interface TemplateSaveInput {
  id?: string;
  name: string;
  description: string;
  goalTemplate: string;
  acceptanceTemplate?: string;
  params: TemplateParam[];
  constraints: TemplateConstraints;
}

// ---------------------------------------------------------------------------
// MCP 服务器（阶段 4.4）：仅 stdio；命令/参数分立，经双重校验
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  id: string;
  /** 小写 slug：^[a-z0-9][a-z0-9-]{0,31}$ */
  name: string;
  /** 可执行文件路径（无空格/元字符，数组式 spawn） */
  command: string;
  args: string[];
  /** 静态环境变量（键名禁止敏感词；密钥绝不落盘） */
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
}

export interface McpServerStatusInfo {
  id: string;
  name: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  toolCount: number;
  error?: string;
  lastConnectedAt?: number;
}

export interface McpToolRejection {
  server: string;
  name: string;
  reason: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_approval: '等待审批',
  paused: '已暂停',
  completed: '已完成',
  needs_review: '需复核',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};
