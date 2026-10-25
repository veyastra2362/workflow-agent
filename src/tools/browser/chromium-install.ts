import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';

/**
 * Chromium 按需下载管理（Stage 5.1）：
 * - 打包后不内嵌 Chromium（体积 ~150MB），首次使用浏览器功能时按需下载
 * - 浏览器缓存目录使用 PLAYWRIGHT_BROWSERS_PATH 或默认 %LOCALAPPDATA%\ms-playwright
 * - 下载经 Playwright 官方 CLI（版本与当前 playwright 包绑定，不会下错版本）
 * - 下载前后都做实际启动验证
 * - 不在应用启动时静默下载；必须由用户显式触发
 */

export interface BrowserInstallStatus {
  installed: boolean;
  /** Chromium 可执行文件路径（已安装时） */
  executablePath?: string;
  /** 浏览器缓存根目录 */
  browsersPath: string;
  error?: string;
}

/** 获取 Playwright 浏览器缓存目录（不修改环境） */
export function getBrowsersPath(): string {
  return process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
}

/** 检测 Chromium 是否已安装（通过 Playwright API，不启动浏览器） */
export function checkChromiumInstalled(): BrowserInstallStatus {
  const browsersPath = getBrowsersPath();
  try {
    const exePath = chromium.executablePath();
    const exists = fs.existsSync(exePath);
    return {
      installed: exists,
      executablePath: exists ? exePath : undefined,
      browsersPath
    };
  } catch (err) {
    return {
      installed: false,
      browsersPath,
      error: `无法检测 Chromium：${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * 验证 Chromium 可实际启动（headless，快速打开 about:blank 后立即关闭）。
 * 不做网络请求。
 */
export async function verifyChromiumLaunch(): Promise<{ ok: boolean; error?: string }> {
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-proxy-server', '--disable-background-networking', '--no-first-run']
    });
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.close();
    await browser.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
  }
}

export interface DownloadProgress {
  status: 'downloading' | 'verifying' | 'done' | 'error';
  message?: string;
}

/**
 * 下载 Chromium（通过 Playwright CLI）。
 * 调用方负责确保用户已确认下载。
 * 返回 Promise，resolve 时下载完成或失败。
 */
export async function downloadChromium(
  onProgress?: (p: DownloadProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  onProgress?.({ status: 'downloading', message: '正在下载 Chromium（约 150MB）...' });
  try {
    execSync('npx playwright install chromium', {
      stdio: 'pipe',
      timeout: 300_000, // 5 分钟上限
      env: { ...process.env, PLAYWRIGHT_DOWNLOAD_HOST: process.env.PLAYWRIGHT_DOWNLOAD_HOST }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    onProgress?.({ status: 'error', message: `下载失败：${msg}` });
    return { ok: false, error: msg };
  }

  onProgress?.({ status: 'verifying', message: '正在验证 Chromium 启动...' });
  const check = checkChromiumInstalled();
  if (!check.installed) {
    onProgress?.({ status: 'error', message: '下载后仍未检测到 Chromium' });
    return { ok: false, error: '下载后仍未检测到 Chromium 可执行文件' };
  }
  const launch = await verifyChromiumLaunch();
  if (!launch.ok) {
    onProgress?.({ status: 'error', message: `Chromium 无法启动：${launch.error}` });
    return { ok: false, error: launch.error };
  }

  onProgress?.({ status: 'done', message: 'Chromium 安装完成并验证可用' });
  return { ok: true };
}
