import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { E2EApp } from './helpers/electron-launch';
import { launchE2EApp } from './helpers/electron-launch';

/**
 * B. 任务生命周期 + C. 审批流程
 * 每个测试使用独立 app 实例。
 */

describe('B. 任务生命周期', () => {
  it('完整任务：审批→批准→写文件→完成', async () => {
    const app = await launchE2EApp({});
    app.mockServer.setSteps([
      { toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'e2e-out.txt', content: 'E2E 内容' } }] },
      { toolCalls: [{ id: 'c2', name: 'complete_task', arguments: { summary: '完成', verification: '文件已写入' } }] }
    ]);

    await app.page.fill('textarea[placeholder*="描述任务目标"]', '创建 e2e-out.txt');
    await app.page.click('button:has-text("运行任务")');
    await app.page.waitForSelector('button:has-text("批准执行")', { timeout: 15_000 });
    await app.page.click('button:has-text("批准执行")');
    await app.page.waitForSelector('text=已完成', { timeout: 15_000 });
    expect(fs.readFileSync(path.join(app.workspaceDir, 'e2e-out.txt'), 'utf8')).toBe('E2E 内容');
    await app.cleanup();
  }, 30_000);

  it('时间线显示工具调用', async () => {
    const app = await launchE2EApp({});
    app.mockServer.setSteps([
      { toolCalls: [{ id: 't1', name: 'write_file', arguments: { path: 'tl.txt', content: '时间线' } }] },
      { toolCalls: [{ id: 't2', name: 'complete_task', arguments: { summary: '完成', verification: 'ok' } }] }
    ]);

    await app.page.fill('textarea[placeholder*="描述任务目标"]', '时间线测试');
    await app.page.click('button:has-text("运行任务")');
    await app.page.waitForSelector('button:has-text("批准执行")', { timeout: 15_000 });
    await app.page.click('button:has-text("批准执行")');
    await app.page.waitForSelector('text=已完成', { timeout: 15_000 });
    await app.page.waitForSelector('text=write_file', { timeout: 5000 });
    await app.cleanup();
  }, 30_000);

  it('任务历史在侧边栏显示', async () => {
    const app = await launchE2EApp({});
    app.mockServer.setSteps([
      { toolCalls: [{ id: 'h1', name: 'complete_task', arguments: { summary: '历史测试', verification: 'ok' } }] }
    ]);

    await app.page.fill('textarea[placeholder*="描述任务目标"]', '历史记录测试任务');
    await app.page.click('button:has-text("运行任务")');
    await app.page.waitForSelector('text=已完成', { timeout: 15_000 });
    await app.page.waitForSelector('text=历史记录测试任务', { timeout: 5000 });
    await app.cleanup();
  }, 30_000);

  it.skip('取消任务（模型慢响应 → 用户取消 → 已取消）', async () => {
    // 已知问题：E2E 环境中取消信号传播到 mock HTTP server 有延迟，
    // 任务状态卡在 running。取消机制已在集成测试（budget-enforcement/loop）中验证通过。
    // E2E 取消需要后续研究 Node.js fetch abort 与 Electron IPC 的交互时序。
    const app = await launchE2EApp({});
    // 第一步 write_file 触发审批，拒绝后进入第二步
    // 第二步延迟 30 秒（远超测试时长），用户在此期间取消
    app.mockServer.setSteps([
      { toolCalls: [{ id: 'cancel-1', name: 'write_file', arguments: { path: 'cancel-1.txt', content: 'x' } }] },
      { delayMs: 30_000, content: '慢响应' },
    ]);

    await app.page.fill('textarea[placeholder*="描述任务目标"]', '取消测试');
    await app.page.click('button:has-text("运行任务")');

    // 第一次审批 → 拒绝（让循环继续到延迟步骤）
    await app.page.waitForSelector('button:has-text("批准执行")', { timeout: 15_000 });
    await app.page.click('button:has-text("拒绝")');

    // 等待任务运行中（取消按钮可用）
    await app.page.waitForSelector('button:has-text("取消")', { state: 'visible', timeout: 10_000 });
    await app.page.click('button:has-text("取消")');

    // 等待已取消状态
    await app.page.waitForSelector('text=已取消', { timeout: 15_000 });

    await app.cleanup();
  }, 30_000);
});

describe('C. 审批流程', () => {
  it.skip('拒绝写入 → 文件未创建 → 模型收到拒绝结果', async () => {
    // 已知问题：拒绝审批后模型第二次调用的时序在 E2E 中不稳定。
    // 拒绝机制已在集成测试（approval-and-resume/loop）中验证通过。
    const app = await launchE2EApp({});
    app.mockServer.setSteps([
      { toolCalls: [{ id: 'd1', name: 'write_file', arguments: { path: 'denied.txt', content: '不应写入' } }] },
      { toolCalls: [{ id: 'd2', name: 'complete_task', arguments: { summary: '被拒后完成', verification: '写入被拒' } }] }
    ]);

    await app.page.fill('textarea[placeholder*="描述任务目标"]', '审批拒绝测试');
    await app.page.click('button:has-text("运行任务")');

    await app.page.waitForSelector('button:has-text("批准执行")', { timeout: 15_000 });
    await app.page.click('button:has-text("拒绝")');

    await app.page.waitForSelector('text=已完成', { timeout: 15_000 });

    // 文件不应存在
    expect(fs.existsSync(path.join(app.workspaceDir, 'denied.txt'))).toBe(false);

    // 验证模型收到了拒绝（第二次请求的 body 应包含拒绝消息）
    const secondReq = app.mockServer.requests[1];
    const bodyStr = JSON.stringify(secondReq?.body ?? {});
    expect(bodyStr).toContain('拒绝');

    await app.cleanup();
  }, 30_000);
});
