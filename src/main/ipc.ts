import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/protocol';
import { OpenAICompatGateway } from '../gateway/openai';
import { describeModelError } from '../gateway/types';
import { redactSecrets } from '../policy/redact';
import { auditParamValues, renderTemplate, validateTemplate } from '../core/templates';
import { createDefaultRegistry } from '../tools';
import { checkChromiumInstalled, downloadChromium } from '../tools/browser/chromium-install';
import { mcpServerConfigSchema } from '../tools/mcp/validate-config';
import type { McpManager } from '../tools/mcp/manager';
import type { PersistedSettings } from '../shared/types';
import type { AgentService } from '../core/service';
import type { Store } from '../persistence/store';
import type { Logger } from './logger';
import type { ModelConfigStore } from './settings';
import type { SecretStore } from './secrets';
import { SEARCH_KEY } from './secrets';

/**
 * 主进程 IPC 处理器：所有输入用 Zod 校验；只暴露白名单通道；
 * 渲染进程传入的任何路径都不会被直接用于文件访问（工作区只能由系统对话框选择）。
 */

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  service: AgentService;
  store: Store;
  logger: Logger;
  modelCfg: ModelConfigStore;
  secrets: SecretStore;
  mcpManager: McpManager;
  settingsRef: { current: PersistedSettings };
  persistSettings: (next: PersistedSettings) => void;
}

const startTaskSchema = z.object({
  goal: z.string().min(1).max(20_000),
  acceptance: z.string().max(20_000).optional(),
  modelConfig: z
    .object({
      baseUrl: z.string().url(),
      apiKey: z.string().optional(),
      model: z.string().min(1),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(64).max(200_000).optional(),
      streaming: z.boolean().optional()
    })
    .optional()
});

const modelConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(200_000).optional(),
  streaming: z.boolean().optional(),
  // 执行与安全设置（阶段 3 起随保存真正持久化）
  maxSteps: z.number().int().min(1).max(200).optional(),
  taskTimeoutMs: z.number().int().min(10_000).max(6 * 60 * 60_000).optional(),
  allowedTestCommands: z.array(z.string().min(1).max(200)).max(50).optional(),
  autoApproveTestCommands: z.boolean().optional(),
  requireApprovalForWrites: z.boolean().optional(),
  requireApprovalForWeb: z.boolean().optional(),
  browserEnabled: z.boolean().optional()
});

const testConnectionSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1)
});

export function registerIpcHandlers(deps: IpcDeps): void {
  const { service, store, logger, modelCfg, secrets, mcpManager, settingsRef, persistSettings } = deps;

  ipcMain.handle(IPC.selectWorkspace, async () => {
    const win = deps.getWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: '选择任务工作区',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settingsRef.current.lastWorkspace ?? undefined
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const workspace = result.filePaths[0];
    settingsRef.current = { ...settingsRef.current, lastWorkspace: workspace };
    persistSettings(settingsRef.current);
    logger.info('workspace.selected', { workspace });
    return workspace;
  });

  ipcMain.handle(IPC.getSettings, () => ({
    ...settingsRef.current,
    hasApiKey: modelCfg.hasApiKey(),
    hasSearchKey: secrets.has(SEARCH_KEY)
  }));

  ipcMain.handle(IPC.setWebConfig, (_e, input: unknown) => {
    const parsed = z
      .object({
        provider: z.enum(['none', 'searxng', 'brave']),
        baseUrl: z.string().max(500).optional(),
        apiKey: z.string().max(500).optional(),
        requireApprovalForWeb: z.boolean().optional()
      })
      .safeParse(input);
    if (!parsed.success) {
      throw new Error(`联网配置不合法：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const v = parsed.data;
    if (v.provider !== 'none') {
      if (!v.baseUrl) throw new Error('配置搜索服务时必须填写 Base URL');
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(v.baseUrl);
      } catch {
        throw new Error('Base URL 无法解析');
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Base URL 仅允许 http/https');
      }
    }
    // 切换 provider 或置为 none：立即清除内存中的旧密钥
    if (v.provider !== settingsRef.current.searchProvider || v.provider === 'none') {
      secrets.clear(SEARCH_KEY);
    }
    if (v.provider !== 'none' && v.apiKey && v.apiKey.length > 0) {
      secrets.set(SEARCH_KEY, v.apiKey);
    }
    settingsRef.current = {
      ...settingsRef.current,
      searchProvider: v.provider,
      searchBaseUrl: v.provider === 'none' ? '' : (v.baseUrl ?? settingsRef.current.searchBaseUrl),
      ...(v.requireApprovalForWeb !== undefined ? { requireApprovalForWeb: v.requireApprovalForWeb } : {})
    };
    persistSettings(settingsRef.current);
    logger.info('settings.webConfig.updated', {
      provider: v.provider,
      baseUrl: v.provider === 'none' ? '' : settingsRef.current.searchBaseUrl
    });
    return {
      ...settingsRef.current,
      hasApiKey: modelCfg.hasApiKey(),
      hasSearchKey: secrets.has(SEARCH_KEY)
    };
  });

  ipcMain.handle(IPC.setModelConfig, (_e, input: unknown) => {
    const parsed = modelConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`设置不合法：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const v = parsed.data;
    // 模型配置进内存（apiKey 不落盘）
    modelCfg.merge({
      ...(v.baseUrl !== undefined ? { baseUrl: v.baseUrl } : {}),
      ...(v.apiKey !== undefined && v.apiKey !== '' ? { apiKey: v.apiKey } : {}),
      ...(v.model !== undefined ? { model: v.model } : {}),
      ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
      ...(v.maxTokens !== undefined ? { maxTokens: v.maxTokens } : {}),
      ...(v.streaming !== undefined ? { streaming: v.streaming } : {})
    });
    // 全部非敏感设置持久化（含执行与安全字段）
    settingsRef.current = {
      ...settingsRef.current,
      ...(v.baseUrl !== undefined ? { baseUrl: v.baseUrl } : {}),
      ...(v.model !== undefined ? { model: v.model } : {}),
      ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
      ...(v.maxTokens !== undefined ? { maxTokens: v.maxTokens } : {}),
      ...(v.streaming !== undefined ? { streaming: v.streaming } : {}),
      ...(v.maxSteps !== undefined ? { maxSteps: v.maxSteps } : {}),
      ...(v.taskTimeoutMs !== undefined ? { taskTimeoutMs: v.taskTimeoutMs } : {}),
      ...(v.allowedTestCommands !== undefined ? { allowedTestCommands: v.allowedTestCommands } : {}),
      ...(v.autoApproveTestCommands !== undefined ? { autoApproveTestCommands: v.autoApproveTestCommands } : {}),
      ...(v.requireApprovalForWrites !== undefined ? { requireApprovalForWrites: v.requireApprovalForWrites } : {}),
      ...(v.browserEnabled !== undefined ? { browserEnabled: v.browserEnabled } : {})
    };
    persistSettings(settingsRef.current);
    const cfg = modelCfg.get();
    logger.info('settings.updated', { model: cfg?.model, baseUrl: cfg?.baseUrl });
    return { ...settingsRef.current, hasApiKey: modelCfg.hasApiKey() };
  });

  ipcMain.handle(IPC.testConnection, async (_e, input: unknown) => {
    const parsed = testConnectionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: '参数不合法' };
    }
    const apiKey =
      parsed.data.apiKey && parsed.data.apiKey.length > 0
        ? parsed.data.apiKey
        : modelCfg.get()?.apiKey ?? '';
    if (!apiKey) return { ok: false, error: '尚未填写 API Key' };
    const gateway = new OpenAICompatGateway({
      baseUrl: parsed.data.baseUrl,
      apiKey,
      model: parsed.data.model,
      timeoutMs: 20_000,
      maxRetries: 0,
      streaming: false,
      maxTokens: 8
    });
    const startedAt = Date.now();
    try {
      await gateway.chat({ messages: [{ role: 'user', content: 'ping' }] });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      logger.warn('settings.testConnection.failed', { error: redactSecrets(describeModelError(err)) });
      return { ok: false, error: redactSecrets(describeModelError(err)) };
    }
  });

  ipcMain.handle(IPC.listTasks, () => service.listTasks());

  ipcMain.handle(IPC.getTask, (_e, id: unknown) => {
    if (typeof id !== 'string') return null;
    return service.getTask(id);
  });

  ipcMain.handle(IPC.startTask, (_e, input: unknown) => {
    const parsed = startTaskSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`任务输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const workspace = settingsRef.current.lastWorkspace;
    if (!workspace) {
      throw new Error('请先在侧边栏选择工作区目录');
    }
    if (parsed.data.modelConfig) {
      modelCfg.merge(parsed.data.modelConfig);
    }
    const cfg = modelCfg.get();
    if (!cfg) {
      throw new Error('尚未配置模型，请先在设置中填写 Base URL / API Key / 模型名');
    }
    // 同步最新配置（apiKey 保留内存中的旧值即可）
    return service.startTask({
      goal: parsed.data.goal,
      acceptance: parsed.data.acceptance,
      workspace,
      modelConfig: cfg
    });
  });

  ipcMain.handle(IPC.cancelTask, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('参数不合法');
    service.cancelTask(id);
  });

  ipcMain.handle(IPC.pauseTask, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('参数不合法');
    return service.pauseTask(id);
  });

  ipcMain.handle(IPC.resumeTask, async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('参数不合法');
    // 恢复任务使用设置中当前的模型配置（应用重启后由用户重新填写 API Key）
    const cfg = modelCfg.get();
    await service.resumeTask(
      id,
      cfg
        ? {
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            model: cfg.model,
            temperature: cfg.temperature,
            maxTokens: cfg.maxTokens,
            streaming: cfg.streaming
          }
        : undefined
    );
  });

  ipcMain.handle(IPC.resolveApproval, (_e, input: unknown) => {
    const parsed = z
      .object({ actionId: z.string().min(1), approved: z.boolean() })
      .safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    return service.resolveApproval(parsed.data.actionId, parsed.data.approved);
  });

  ipcMain.handle(IPC.restoreFileChange, (_e, input: unknown) => {
    const parsed = z
      .object({ taskId: z.string().min(1), changeId: z.number().int().positive() })
      .safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    return service.restoreFileChange(parsed.data.taskId, parsed.data.changeId);
  });

  ipcMain.handle(IPC.restoreTaskFiles, (_e, input: unknown) => {
    const parsed = z.object({ taskId: z.string().min(1) }).safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    return service.restoreTaskFiles(parsed.data.taskId);
  });

  // ---------- 任务模板（阶段 4.1） ----------

  ipcMain.handle(IPC.templatesList, () => store.listTemplates());

  ipcMain.handle(IPC.getTemplate, (_e, input: unknown) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    return store.getTemplate(parsed.data.id);
  });

  ipcMain.handle(IPC.saveTemplate, (_e, input: unknown) => {
    const knownTools = createDefaultRegistry().list().map((d) => d.name);
    const validated = validateTemplate(input, knownTools);
    if (!validated.ok) {
      throw new Error(`模板不合法：${validated.issues.join('; ')}`);
    }
    return store.saveTemplate(validated.value);
  });

  ipcMain.handle(IPC.deleteTemplate, (_e, input: unknown) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    store.deleteTemplate(parsed.data.id);
  });

  ipcMain.handle(IPC.startFromTemplate, (_e, input: unknown) => {
    const parsed = z
      .object({
        templateId: z.string().min(1),
        paramValues: z.record(z.string().min(1).max(64), z.string().max(10_000))
      })
      .safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    const template = store.getTemplate(parsed.data.templateId);
    if (!template) throw new Error('模板不存在');
    const rendered = renderTemplate(template, parsed.data.paramValues);
    if (!rendered.ok) throw new Error(rendered.errors.join('; '));

    const workspace = settingsRef.current.lastWorkspace;
    if (!workspace) throw new Error('请先在侧边栏选择工作区目录');
    const cfg = modelCfg.get();
    if (!cfg) throw new Error('尚未配置模型，请先在设置中填写 Base URL / API Key / 模型名');

    logger.info('template.start', { templateId: template.id, name: template.name });
    // 执行约束只取自持久化模板，客户端不可注入；Service 内再与全局预算取 min
    return service.startTask({
      goal: rendered.goal,
      acceptance: rendered.acceptance,
      workspace,
      modelConfig: cfg,
      constraints: template.constraints,
      templateRef: {
        id: template.id,
        name: template.name,
        paramsAudit: auditParamValues(template.params, parsed.data.paramValues)
      }
    });
  });

  // ---------- MCP 服务器管理（阶段 4.4） ----------

  ipcMain.handle(IPC.mcpList, () => ({
    servers: mcpManager.status(),
    rejected: mcpManager.rejectedTools(),
    configs: settingsRef.current.mcpServers
  }));

  ipcMain.handle(IPC.mcpSave, async (_e, input: unknown) => {
    // 保存时校验（与连接时同一函数——运行时不因保存通过而放松）
    const parsed = mcpServerConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`MCP 服务器配置不合法：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const cfg = parsed.data;
    const others = settingsRef.current.mcpServers.filter((s) => s.id !== cfg.id);
    if (others.some((s) => s.name === cfg.name)) {
      throw new Error(`服务器名称 "${cfg.name}" 已被使用`);
    }
    settingsRef.current = {
      ...settingsRef.current,
      mcpServers: [...others, cfg]
    };
    persistSettings(settingsRef.current);
    logger.info('mcp.server.saved', { name: cfg.name, command: cfg.command });
    await mcpManager.syncConfigs(settingsRef.current.mcpServers);
    return { servers: mcpManager.status(), rejected: mcpManager.rejectedTools() };
  });

  ipcMain.handle(IPC.mcpDelete, async (_e, input: unknown) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    settingsRef.current = {
      ...settingsRef.current,
      mcpServers: settingsRef.current.mcpServers.filter((s) => s.id !== parsed.data.id)
    };
    persistSettings(settingsRef.current);
    await mcpManager.syncConfigs(settingsRef.current.mcpServers);
    return { servers: mcpManager.status(), rejected: mcpManager.rejectedTools() };
  });

  ipcMain.handle(IPC.mcpReconnect, async (_e, input: unknown) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
    if (!parsed.success) throw new Error('参数不合法');
    return mcpManager.reconnect(parsed.data.id);
  });

  // ---------- Chromium 按需安装（Stage 5.1） ----------

  ipcMain.handle(IPC.browserCheck, () => {
    const status = checkChromiumInstalled();
    return { installed: status.installed, browsersPath: status.browsersPath, error: status.error };
  });

  ipcMain.handle(IPC.browserInstall, async () => {
    logger.info('browser.chromium.install.started', { browsersPath: getBrowsersPathSafe() });
    const result = await downloadChromium();
    if (result.ok) {
      logger.info('browser.chromium.install.done');
    } else {
      logger.warn('browser.chromium.install.failed', { error: result.error });
    }
    return result;
  });
}

function getBrowsersPathSafe(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBrowsersPath } = require('../tools/browser/chromium-install') as typeof import('../tools/browser/chromium-install');
    return getBrowsersPath();
  } catch {
    return 'unknown';
  }
}
