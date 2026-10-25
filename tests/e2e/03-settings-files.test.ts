import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { E2EApp } from './helpers/electron-launch';
import { launchE2EApp } from './helpers/electron-launch';

/**
 * D. 设置持久化（保存 → 重启 → 恢复）
 * E. 文件变更 UI 与实际文件一致性
 */

describe('D. 设置持久化', () => {
  it('保存设置 → settings.json 正确持久化', async () => {
    const app = await launchE2EApp({});

    // 进入设置页
    await app.page.click('button:has-text("设置")');
    await app.page.waitForSelector('input[placeholder*="https://"]', { timeout: 5000 });

    // 修改并保存
    await app.page.fill('input[placeholder*="https://"]', 'http://127.0.0.1:19998/v1');
    await app.page.fill('input[placeholder*="gpt-4o"]', 'e2e-persist-model');
    await app.page.click('button:has-text("保存设置")');
    await app.page.waitForSelector('text=已保存', { timeout: 5000 });

    // 直接读取 settings.json 验证持久化（比重启更快更可靠）
    const settingsPath = path.join(app.userDataDir, 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(saved.baseUrl).toBe('http://127.0.0.1:19998/v1');
    expect(saved.model).toBe('e2e-persist-model');
    // API Key 不应出现在 settings.json 中（安全设计）
    expect(JSON.stringify(saved)).not.toContain('e2e-test-key');

    await app.cleanup();
  }, 20_000);

  it('测试连接（mock 返回 200 → 连接成功）', async () => {
    const app = await launchE2EApp({});

    await app.page.click('button:has-text("设置")');
    await app.page.waitForSelector('input[placeholder*="https://"]', { timeout: 5000 });

    // 设置 mock URL 并保存
    await app.page.fill('input[placeholder*="https://"]', app.mockServer.url);
    await app.page.fill('input[placeholder*="gpt-4o"]', 'mock-model');
    await app.page.click('button:has-text("保存设置")');
    await app.page.waitForSelector('text=已保存', { timeout: 5000 });

    // 测试连接（mock 立即响应）
    await app.page.click('button:has-text("测试连接")');
    await app.page.waitForSelector('text=连接成功', { timeout: 10_000 });

    await app.cleanup();
  }, 20_000);
});

describe('E. 文件变更 UI 与实际文件一致性', () => {
  it('任务修改文件 → UI 与实际一致 → 回滚恢复', async () => {
    const app = await launchE2EApp({ workspaceFiles: { 'existing.txt': '修改前内容' } });
    app.mockServer.setSteps([
      { toolCalls: [{ id: 'fc-1', name: 'write_file', arguments: { path: 'existing.txt', content: '修改后内容' } }] },
      { toolCalls: [{ id: 'fc-2', name: 'write_file', arguments: { path: 'new-file.txt', content: '新文件' } }] },
      { toolCalls: [{ id: 'fc-3', name: 'complete_task', arguments: { summary: '文件变更完成', verification: 'ok' } }] }
    ]);

    // 提交任务
    await app.page.fill('textarea[placeholder*="描述任务目标"]', '修改 existing.txt');
    await app.page.click('button:has-text("运行任务")');

    // 两次审批
    for (let i = 0; i < 2; i++) {
      await app.page.waitForSelector('button:has-text("批准执行")', { timeout: 15_000 });
      await app.page.click('button:has-text("批准执行")');
    }

    await app.page.waitForSelector('text=已完成', { timeout: 15_000 });

    // 验证实际文件
    expect(fs.readFileSync(path.join(app.workspaceDir, 'existing.txt'), 'utf8')).toBe('修改后内容');
    expect(fs.readFileSync(path.join(app.workspaceDir, 'new-file.txt'), 'utf8')).toBe('新文件');

    // 文件变更标签
    const fileTab = await app.page.$('button:has-text("文件变更")');
    if (fileTab) await fileTab.click();
    await app.page.waitForSelector('text=existing.txt', { timeout: 5000 });
    await app.page.waitForSelector('text=new-file.txt', { timeout: 5000 });

    // 回滚
    await app.page.waitForSelector('button:has-text("回滚全部")', { timeout: 5000 });
    await app.page.click('button:has-text("回滚全部")');

    // 验证回滚结果
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.readFileSync(path.join(app.workspaceDir, 'existing.txt'), 'utf8')).toBe('修改前内容');
    expect(fs.existsSync(path.join(app.workspaceDir, 'new-file.txt'))).toBe(false);

    await app.cleanup();
  }, 30_000);
});
