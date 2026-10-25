import { contextBridge, ipcRenderer } from 'electron';
import type { ZcodeApi } from '../shared/protocol';
import type { TaskEvent } from '../shared/types';

/**
 * Preload：只暴露白名单方法，渲染进程不能访问任意 IPC 通道，
 * 也没有 Node.js / Shell 能力（contextIsolation + sandbox 均开启）。
 *
 * 注意：sandbox 模式下 preload 不能 require 本地模块（Electron 限制），
 * 因此通道名在此处内联，与 src/shared/protocol.ts 的 IPC 保持一致
 * （tests/unit/preload-channels.test.ts 会校验两者不漂移）。
 */
const CHANNELS = {
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
  onTaskEvent: 'event:taskEvent'
} as const;

const invoke = ipcRenderer.invoke.bind(ipcRenderer);

const api: ZcodeApi = {
  selectWorkspace: () => invoke(CHANNELS.selectWorkspace),
  getSettings: () => invoke(CHANNELS.getSettings),
  setModelConfig: (cfg) => invoke(CHANNELS.setModelConfig, cfg),
  setWebConfig: (input) => invoke(CHANNELS.setWebConfig, input),
  testConnection: (input) => invoke(CHANNELS.testConnection, input),
  listTasks: () => invoke(CHANNELS.listTasks),
  getTask: (id) => invoke(CHANNELS.getTask, id),
  startTask: (input) => invoke(CHANNELS.startTask, input),
  cancelTask: (id) => invoke(CHANNELS.cancelTask, id),
  pauseTask: (id) => invoke(CHANNELS.pauseTask, id),
  resumeTask: (id) => invoke(CHANNELS.resumeTask, id),
  resolveApproval: (actionId, approved) => invoke(CHANNELS.resolveApproval, { actionId, approved }),
  restoreFileChange: (taskId, changeId) => invoke(CHANNELS.restoreFileChange, { taskId, changeId }),
  restoreTaskFiles: (taskId) => invoke(CHANNELS.restoreTaskFiles, { taskId }),
  listTemplates: () => invoke(CHANNELS.templatesList),
  getTemplate: (id) => invoke(CHANNELS.getTemplate, { id }),
  saveTemplate: (input) => invoke(CHANNELS.saveTemplate, input),
  deleteTemplate: (id) => invoke(CHANNELS.deleteTemplate, { id }),
  startFromTemplate: (input) => invoke(CHANNELS.startFromTemplate, input),
  listMcpServers: () => invoke(CHANNELS.mcpList),
  saveMcpServer: (input) => invoke(CHANNELS.mcpSave, input),
  deleteMcpServer: (id) => invoke(CHANNELS.mcpDelete, { id }),
  reconnectMcpServer: (id) => invoke(CHANNELS.mcpReconnect, { id }),
  onTaskEvent: (cb: (event: TaskEvent) => void) => {
    const handler = (_e: unknown, event: TaskEvent): void => cb(event);
    ipcRenderer.on(CHANNELS.onTaskEvent, handler as never);
    return () => {
      ipcRenderer.removeListener(CHANNELS.onTaskEvent, handler as never);
    };
  }
};

contextBridge.exposeInMainWorld('api', api);
