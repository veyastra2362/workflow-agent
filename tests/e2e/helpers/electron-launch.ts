import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { _electron } from 'playwright';
import { startMockModelServer, type MockModelServer } from './mock-model-server';

/**
 * Electron E2E 测试辅助：启动真实应用（主进程 + preload + renderer + SQLite），
 * 使用临时 userData 与临时工作区，通过本地 mock 模型服务驱动。
 */

export interface E2EApp {
  electronApp: ElectronApplication;
  page: Page;
  userDataDir: string;
  workspaceDir: string;
  mockServer: MockModelServer;
  cleanup: () => Promise<void>;
}

/**
 * 启动 Electron 应用（真实主进程 + 渲染进程）
 * - userData 指向临时目录（通过 --user-data-dir 参数）
 * - 工作区指向临时目录（通过 settings.json 注入 lastWorkspace）
 * - 模型服务使用本地 mock（随机端口，仅监听 127.0.0.1）
 */
export async function launchE2EApp(opts: { workspaceFiles?: Record<string, string> } = {}): Promise<E2EApp> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-e2e-ud-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-e2e-ws-'));

  for (const [rel, content] of Object.entries(opts.workspaceFiles ?? {})) {
    const abs = path.join(workspaceDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const mockServer = await startMockModelServer();

  // 写入临时 settings.json（包含 mock 服务 URL 和工作区）
  const settings = {
    baseUrl: mockServer.url,
    model: 'mock-model',
    temperature: 0.2,
    maxTokens: 4096,
    streaming: false,
    maxSteps: 25,
    taskTimeoutMs: 120_000,
    modelTimeoutMs: 10_000,
    toolResultMaxChars: 20_000,
    maxContextChars: 120_000,
    allowedTestCommands: [],
    autoApproveTestCommands: true,
    requireApprovalForWrites: true,
    requireApprovalForWeb: false,
    searchProvider: 'none',
    searchBaseUrl: '',
    browserEnabled: false,
    requireApprovalForMcp: true,
    mcpServers: [],
    lastWorkspace: workspaceDir
  };
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(settings));

  const projectRoot = path.resolve(__dirname, '../../..');
  const electronPath = require('electron') as unknown as string;

  const electronApp = await _electron.launch({
    args: [
      projectRoot,
      `--user-data-dir=${userDataDir}`,
      '--disable-gpu',
      '--no-sandbox'
    ],
    env: {
      ...process.env,
      WORKFLOW_AGENT_E2E: '1',
      WORKFLOW_AGENT_DEV_SERVER: ''
    }
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // 注入 mock URL 到页面（用于 setModelConfig 调用）
  await page.evaluate((url: string) => {
    (window as unknown as Record<string, unknown>).__E2E_MOCK_URL = url;
  }, mockServer.url);

  // 通过 IPC 注入 mock 模型配置（API Key 仅存内存）
  await page.evaluate(async () => {
    const w = window as unknown as {
      __E2E_MOCK_URL: string;
      api: { setModelConfig(cfg: unknown): Promise<unknown> };
    };
    await w.api.setModelConfig({
      baseUrl: w.__E2E_MOCK_URL,
      apiKey: 'e2e-test-key-not-real',
      model: 'mock-model'
    });
  });

  const cleanup = async (): Promise<void> => {
    try {
      await electronApp.close();
    } catch {
      try { electronApp.process().kill(); } catch { /* 已退出 */ }
    }
    try { mockServer.close(); } catch { /* 已关闭 */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 清理失败 */ }
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* 清理失败 */ }
  };

  return { electronApp, page, userDataDir, workspaceDir, mockServer, cleanup };
}

/** 等待 UI 文本出现（带超时） */
export async function waitForText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForSelector(`text=${text}`, { timeout });
}

/** 等待按钮可点击 */
export async function waitForButton(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForSelector(`button:has-text("${text}")`, { state: 'visible', timeout });
}

/** 通过页面 evaluate 检查应用是否仍在运行 */
export async function isAppRunning(app: E2EApp): Promise<boolean> {
  try {
    await app.page.evaluate(() => true);
    return true;
  } catch {
    return false;
  }
}
