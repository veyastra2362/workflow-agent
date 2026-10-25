import type {
  AppSettings,
  ConnectionTestResult,
  McpServerConfig,
  McpServerStatusInfo,
  McpToolRejection,
  ModelConfig,
  TaskDetail,
  TaskEvent,
  TaskSummary,
  TemplateDetail,
  TemplateSaveInput,
  TemplateSummary
} from './types';

/**
 * IPC 通道名常量。渲染进程与主进程都通过此文件引用，
 * preload 中使用 contextBridge 白名单暴露，渲染进程不能访问任意通道。
 */
export const IPC = {
  selectWorkspace: 'workspace:select',
  getSettings: 'settings:get',
  setModelConfig: 'settings:setModelConfig',
  setWebConfig: 'settings:setWebConfig',
  testConnection: 'settings:testConnection',
  listTasks: 'tasks:list',
  getTask: 'tasks:get',
  startTask: 'tasks:start',
  cancelTask: 'tasks:cancel',
  pauseTask: 'tasks:pause',
  resumeTask: 'tasks:resume',
  resolveApproval: 'approval:resolve',
  restoreFileChange: 'tasks:restoreFile',
  restoreTaskFiles: 'tasks:restoreTaskFiles',
  templatesList: 'templates:list',
  getTemplate: 'templates:get',
  saveTemplate: 'templates:save',
  deleteTemplate: 'templates:delete',
  startFromTemplate: 'templates:start',
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  mcpDelete: 'mcp:delete',
  mcpReconnect: 'mcp:reconnect',
  browserCheck: 'browser:check',
  browserInstall: 'browser:install',
  onTaskEvent: 'event:taskEvent'
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface StartTaskInput {
  goal: string;
  acceptance?: string;
  /** 留空字段表示沿用主进程内存中已保存的模型配置 */
  modelConfig: Partial<ModelConfig>;
}

/**
 * 渲染进程唯一可用的桥接 API（由 preload 注入）。
 * 渲染进程没有 Node 能力，不能访问文件系统 / Shell。
 */
export interface ZcodeApi {
  selectWorkspace(): Promise<string | null>;
  getSettings(): Promise<AppSettings>;
  setModelConfig(cfg: Partial<ModelConfig> & Partial<Omit<AppSettings, 'hasApiKey' | 'hasSearchKey'>>): Promise<AppSettings>;
  /** 配置搜索服务（provider 切换/置 none 时清除内存中的旧密钥） */
  setWebConfig(input: {
    provider: 'none' | 'searxng' | 'brave';
    baseUrl?: string;
    apiKey?: string;
    requireApprovalForWeb?: boolean;
  }): Promise<AppSettings>;
  testConnection(input: { baseUrl: string; apiKey?: string; model: string }): Promise<ConnectionTestResult>;
  listTasks(): Promise<TaskSummary[]>;
  getTask(id: string): Promise<TaskDetail | null>;
  startTask(input: StartTaskInput): Promise<{ taskId: string }>;
  cancelTask(id: string): Promise<void>;
  pauseTask(id: string): Promise<boolean>;
  resumeTask(id: string): Promise<void>;
  resolveApproval(actionId: string, approved: boolean): Promise<boolean>;
  /** 将某条文件变更回滚为修改前内容（任务创建的文件会被删除） */
  restoreFileChange(taskId: string, changeId: number): Promise<{ restored: boolean; path: string; action: string }>;
  /** 回滚任务的全部未恢复文件变更（每个路径恢复到任务前状态） */
  restoreTaskFiles(taskId: string): Promise<{ paths: string[] }>;
  listTemplates(): Promise<TemplateSummary[]>;
  getTemplate(id: string): Promise<TemplateDetail | null>;
  saveTemplate(input: TemplateSaveInput): Promise<TemplateDetail>;
  deleteTemplate(id: string): Promise<void>;
  /** 从模板启动任务：渲染与执行约束均在主进程完成，约束只取自持久化模板 */
  startFromTemplate(input: { templateId: string; paramValues: Record<string, string> }): Promise<{ taskId: string }>;
  listMcpServers(): Promise<{ servers: McpServerStatusInfo[]; rejected: McpToolRejection[]; configs: McpServerConfig[] }>;
  /** 保存/更新 MCP 服务器（保存即触发重连；命令与参数分立、双重校验） */
  saveMcpServer(input: McpServerConfig): Promise<{ servers: McpServerStatusInfo[]; rejected: McpToolRejection[] }>;
  deleteMcpServer(id: string): Promise<{ servers: McpServerStatusInfo[]; rejected: McpToolRejection[] }>;
  reconnectMcpServer(id: string): Promise<McpServerStatusInfo | null>;
  /** 检测 Chromium 是否已安装（不启动浏览器、不下载） */
  browserCheckInstall(): Promise<{ installed: boolean; browsersPath: string; error?: string }>;
  /** 用户主动触发 Chromium 下载（约 150MB；返回后可再调 browserCheckInstall 确认） */
  browserInstallChromium(): Promise<{ ok: boolean; error?: string }>;
  /** 订阅任务事件推送，返回取消订阅函数 */
  onTaskEvent(cb: (event: TaskEvent) => void): () => void;
}
