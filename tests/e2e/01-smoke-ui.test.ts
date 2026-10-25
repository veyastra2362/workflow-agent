import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2EApp } from './helpers/electron-launch';
import { launchE2EApp, isAppRunning } from './helpers/electron-launch';

/**
 * A. UI 冒烟：启动、导航、关键元素渲染
 */

let app: E2EApp;

beforeAll(async () => {
  app = await launchE2EApp();
}, 30_000);

afterAll(async () => {
  await app.cleanup();
});

describe('A. UI 冒烟', () => {
  it('Electron 窗口启动，React 挂载，window.api 可用', async () => {
    expect(await isAppRunning(app)).toBe(true);
    const mounted = await app.page.evaluate(() => {
      const root = document.getElementById('root');
      return !!root && root.children.length > 0;
    });
    expect(mounted).toBe(true);
    const hasApi = await app.page.evaluate(() => {
      return typeof (window as unknown as { api?: unknown }).api !== 'undefined';
    });
    expect(hasApi).toBe(true);
  });

  it('侧边栏渲染：工作区/任务历史/模板/设置入口', async () => {
    await app.page.waitForSelector('text=选择目录', { timeout: 5000 });
    await app.page.waitForSelector('text=任务历史', { timeout: 5000 });
    await app.page.waitForSelector('text=任务模板', { timeout: 5000 });
    await app.page.waitForSelector('text=设置', { timeout: 5000 });
  });

  it('主任务区渲染：输入框 + 运行按钮', async () => {
    await app.page.waitForSelector('textarea[placeholder*="描述任务目标"]', { timeout: 5000 });
    await app.page.waitForSelector('button:has-text("运行任务")', { timeout: 5000 });
  });

  it('导航到设置页面：关键表单渲染', async () => {
    await app.page.click('button:has-text("设置")');
    await app.page.waitForSelector('text=API Base URL', { timeout: 5000 });
    await app.page.waitForSelector('text=API Key', { timeout: 5000 });
    await app.page.waitForSelector('text=模型名称', { timeout: 5000 });
    await app.page.waitForSelector('button:has-text("保存设置")', { timeout: 5000 });
    await app.page.waitForSelector('button:has-text("测试连接")', { timeout: 5000 });
  });

  it('导航到模板页面', async () => {
    await app.page.click('button:has-text("任务模板")');
    await app.page.waitForSelector('button:has-text("新建模板")', { timeout: 5000 });
  });

  it('设置 ↔ 模板 页面切换', async () => {
    await app.page.click('button:has-text("设置")');
    await app.page.waitForSelector('text=API Base URL', { timeout: 5000 });
    await app.page.click('button:has-text("任务模板")');
    await app.page.waitForSelector('button:has-text("新建模板")', { timeout: 5000 });
  });
});
