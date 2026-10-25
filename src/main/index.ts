import { app, BrowserWindow, net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../persistence/db';
import { Store } from '../persistence/store';
import { OpenAICompatGateway } from '../gateway/openai';
import { AgentService } from '../core/service';
import { loadSystemPrompt } from '../core/prompt';
import { BrowserSessionManager } from '../tools/browser/session';
import { McpManager } from '../tools/mcp/manager';
import { createLogger } from './logger';
import { loadSettings, saveSettings, ModelConfigStore } from './settings';
import { SecretStore, SEARCH_KEY } from './secrets';
import { registerIpcHandlers } from './ipc';

/**
 * Electron 主进程入口。
 * - Agent Core、持久化、模型网关全部运行在主进程；
 * - 渲染进程通过 contextBridge 白名单 IPC 交互，无 Node/Shell 能力；
 * - 生产环境经注册的 app:// 安全协议加载渲染层产物
 *   （file:// 下 ES Module 会被 Chromium CORS 拦截，且 app:// 允许保持严格 CSP）。
 */

// 必须在 app ready 之前调用
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let mainWindow: BrowserWindow | null = null;

const isSmoke = process.env.WORKFLOW_AGENT_SMOKE === '1';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#09090b',
    title: 'Workflow Agent',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  const devServer = process.env.WORKFLOW_AGENT_DEV_SERVER;
  if (devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadURL('app://local/index.html');
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** app://local/<path> → dist/renderer 内静态文件（路径规范化，防穿越） */
function registerAppProtocol(): void {
  const baseDir = path.resolve(__dirname, '../renderer');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const abs = path.resolve(baseDir, rel || 'index.html');
    if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(abs).toString());
  });
}

app.whenReady().then(async () => {
  try {
    registerAppProtocol();
    const userData = app.getPath('userData');
    const logger = createLogger({ logDir: path.join(userData, 'logs'), level: 'info' });
    const settings = loadSettings(userData);
    const settingsRef = { current: settings };
    const modelCfg = new ModelConfigStore();
    const secrets = new SecretStore();

    const db = openDatabase(path.join(userData, 'workflow-agent.db'));
    const store = new Store(db);
    // 浏览器会话管理器（生产策略：回环/私网一律拒绝；仅用户启用浏览器自动化时注册工具）
    const browserManager = new BrowserSessionManager({
      policy: { loopbackExempt: false },
      logger
    });
    // MCP 连接管理器（仅连接用户显式配置的 stdio 服务器；任务取消只中止单次调用）
    const mcpManager = new McpManager({ logger });

    // 应用退出：带超时清理浏览器进程与 MCP 连接（防止其阻止退出；仅执行一次）
    let browserCleanupDone = false;
    app.on('will-quit', (event) => {
      if (browserCleanupDone || (browserManager.isClosed() && mcpManager.isClosed())) {
        browserCleanupDone = true;
        return;
      }
      browserCleanupDone = true;
      event.preventDefault();
      void Promise.all([
        browserManager.closeAll(2500).catch(() => undefined),
        mcpManager.closeAll(2500).catch(() => undefined)
      ]).then(() => app.exit(0));
    });

    const prompt = loadSystemPrompt([
      // 打包后：extraResources 中的 prompts 目录（asar 外，可读）
      ...(app.isPackaged ? [path.join(process.resourcesPath, 'prompts', 'system.md')] : []),
      // 开发环境：项目源码目录
      path.join(app.getAppPath(), 'prompts', 'system.md'),
      // 开发环境回退：编译产物相对路径
      path.join(__dirname, '../../prompts/system.md')
    ]);
    logger.info('app.start', {
      promptSource: prompt.source,
      promptVersion: prompt.version,
      userData
    });

    const service = new AgentService({
      store,
      logger,
      settings: () => settingsRef.current,
      createGateway: (cfg) =>
        new OpenAICompatGateway({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          streaming: cfg.streaming ?? settingsRef.current.streaming,
          timeoutMs: settingsRef.current.modelTimeoutMs
        }),
      systemPrompt: prompt.text,
      searchApiKey: () => secrets.get(SEARCH_KEY),
      browserManager,
      mcpManager,
      onEvent: (event) => {
        // 事件转发到所有窗口（安全通道）
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('event:taskEvent', event);
        }
      }
    });

    const recovered = service.recoverOnStartup();
    if (recovered > 0) logger.warn('app.recovery', { interruptedTasks: recovered });

    registerIpcHandlers({
      getWindow: () => mainWindow,
      service,
      store,
      logger,
      modelCfg,
      secrets,
      mcpManager,
      settingsRef,
      persistSettings: (next) => {
        settingsRef.current = next;
        saveSettings(userData, next);
      }
    });

    // 启动时连接用户已启用的 MCP 服务器（失败不阻塞应用；状态经 IPC 可查）
    void mcpManager.syncConfigs(settings.mcpServers);

    createWindow();

    if (isSmoke) {
      const win = mainWindow!;
      win.webContents.once('did-finish-load', async () => {
        try {
          // 验证应用真实可用：React 已挂载（#root 有子元素）且 preload 已注入 window.api
          await new Promise((r) => setTimeout(r, 1200));
          const state = (await win.webContents.executeJavaScript(
            "(() => { const r = document.getElementById('root'); return JSON.stringify({ mounted: !!r && r.children.length > 0, hasApi: typeof window.api !== 'undefined' }); })()"
          )) as string;
          const { mounted, hasApi } = JSON.parse(state) as { mounted: boolean; hasApi: boolean };
          if (mounted && hasApi) {
            console.log('SMOKE_OK');
            app.exit(0);
          } else {
            console.error(`SMOKE_FAIL: mounted=${mounted} hasApi=${hasApi}`);
            app.exit(1);
          }
        } catch (err) {
          console.error(`SMOKE_FAIL: ${String(err)}`);
          app.exit(1);
        }
      });
      setTimeout(() => {
        console.error('SMOKE_FAIL: 超时未完成加载');
        app.exit(1);
      }, 30000);
    }
  } catch (err) {
    console.error(`主进程初始化失败: ${err instanceof Error ? err.stack : String(err)}`);
    if (isSmoke) {
      console.error('SMOKE_FAIL');
      app.exit(1);
    } else {
      app.exit(1);
    }
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
