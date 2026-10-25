import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveInsideWorkspace, requireReadableInsideWorkspace, PolicyViolationError } from '../policy/paths';
import { toWorkspaceRel } from './fsutil';
import type { ToolDefinition } from './registry';

/**
 * get_git_diff：
 * 1) 工作区是 git 仓库 → 用 git diff / git status（固定参数，无用户输入拼入，无注入面）；
 * 2) 否则回退为"本任务会话差异"：用工具执行时记录的修改前备份与当前内容对比。
 */

const gitDiffArgs = z.object({
  staged: z.boolean().default(false),
  maxChars: z.number().int().min(1000).max(200_000).default(60_000)
});

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxOutput: number }
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', GIT_OPTIONAL_LOCKS: '0' }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, opts.timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < opts.maxOutput) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < opts.maxOutput) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

async function sessionDiff(ctx: Parameters<ToolDefinition['execute']>[1], maxChars: number): Promise<unknown> {
  const changes = ctx.getRecordedChanges();
  const seen = new Map<string, 'create' | 'modify'>();
  for (const c of changes) seen.set(c.path, c.kind);
  const { createTwoFilesPatch } = await import('diff');
  const parts: string[] = [];
  for (const [rel, kind] of seen) {
    const abs = resolveInsideWorkspace(ctx.workspace, rel);
    let current: string | null = null;
    try {
      const buf = await fsp.readFile(abs);
      if (!buf.includes(0)) current = buf.toString('utf8');
    } catch {
      current = null;
    }
    const before = ctx.readBackup(rel) ?? '';
    const after = current ?? '';
    if (before === after) continue;
    const note = kind === 'create' ? '# 新建文件\n' : '';
    parts.push(
      note + createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, undefined, undefined, { context: 3 })
    );
    if (parts.join('').length > maxChars) break;
  }
  const diff = parts.join('\n');
  return {
    mode: 'session',
    changedFiles: seen.size,
    diff: diff || '（本任务暂无文件变更）',
    truncated: diff.length > maxChars
  };
}

export const gitDiffTool: ToolDefinition<z.infer<typeof gitDiffArgs>> = {
  name: 'get_git_diff',
  description:
    '查看当前工作区的文件变更。若工作区是 git 仓库则返回 git diff（可用 staged 查看暂存区），否则返回本任务会话内的文件变更差异（基于修改前备份）。用于在修改后自查变更。',
  riskLevel: 'read',
  timeoutMs: 20_000,
  schema: gitDiffArgs,
  async execute(args, ctx) {
    const ws = path.resolve(ctx.workspace);
    const hasGit = fs.existsSync(path.join(ws, '.git'));
    if (hasGit) {
      const status = await runProcess('git', ['status', '--porcelain'], {
        cwd: ws,
        timeoutMs: 15_000,
        maxOutput: 4000
      });
      const diff = await runProcess(
        'git',
        ['diff', '--no-color', ...(args.staged ? ['--cached'] : [])],
        { cwd: ws, timeoutMs: 15_000, maxOutput: args.maxChars }
      );
      if (status.code === 0 && diff.code === 0 && !diff.timedOut) {
        return {
          mode: 'git',
          status: status.stdout,
          diff: diff.stdout || '（没有差异）',
          truncated: diff.stdout.length >= args.maxChars
        };
      }
      // git 不可用/异常时回退为会话差异
    }
    return sessionDiff(ctx, args.maxChars);
  },
  summarize(data) {
    const d = data as { mode: string; diff: string };
    const lineCount = d.diff.split('\n').length;
    return `${d.mode === 'git' ? 'git diff' : '会话差异'}，约 ${lineCount} 行`;
  }
};

// ---------------------------------------------------------------------------
// run_tests
// ---------------------------------------------------------------------------

const runTestsArgs = z.object({
  command: z.string().min(1).max(200),
  args: z.array(z.string().max(500)).max(20).default([]),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000)
});

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows 下终止整棵进程树（npm 等包装器会产生子进程）
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    killer.on('error', () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 3000).unref();
  }
}

export const runTestsTool: ToolDefinition<z.infer<typeof runTestsArgs>> = {
  name: 'run_tests',
  description:
    '在任务工作区中运行测试命令（command 必须是用户在设置中配置的白名单命令，如 "npm test"；args 为附加参数）。返回退出码与输出。修改代码后应运行测试验证。',
  riskLevel: 'execute',
  timeoutMs: 600_000,
  schema: runTestsArgs,
  async execute(args, ctx) {
    const startedAt = Date.now();
    const result = await new Promise<ProcResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(args.command, args.args, {
        cwd: ctx.workspace,
        shell: false, // 不经 shell，参数以数组传递，避免命令注入
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, args.timeoutMs);
      timer.unref?.();
      // 任务超时/用户取消 → 立即终止整棵进程树（实际中止，而非等待命令自然结束）
      const onAbort = () => killProcessTree(child);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      };
      const cap = 100_000;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < cap) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < cap) stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        cleanup();
        resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
      });
      child.on('close', (code) => {
        cleanup();
        resolve({ code: code ?? -1, stdout, stderr, timedOut });
      });
    });

    let output = result.stdout;
    if (result.stderr) output += (output ? '\n' : '') + `-- stderr --\n${result.stderr}`;
    if (output.length > 100_000) {
      output = `${output.slice(0, 100_000)}\n…[输出已截断]`;
    }
    return {
      command: args.command,
      args: args.args,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
      output: output || '（无输出）'
    };
  },
  summarize(data) {
    const d = data as { exitCode: number; timedOut: boolean };
    return `exit=${d.exitCode}${d.timedOut ? '（超时终止）' : ''}`;
  }
};

// 导出内部工具供测试复用
export const _internals = { runProcess, killProcessTree, toWorkspaceRel, requireReadableInsideWorkspace, PolicyViolationError };
