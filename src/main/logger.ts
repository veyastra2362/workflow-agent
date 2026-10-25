import fs from 'node:fs';
import path from 'node:path';
import { redactValue } from '../policy/redact';

/**
 * 结构化日志：JSON Lines 文件 + 控制台；写入前统一脱敏。
 * Core 通过此接口依赖日志能力（main 进程提供实现）。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: {
  logDir?: string;
  level?: LogLevel;
  context?: Record<string, unknown>;
  console?: boolean;
}): Logger {
  const level = opts.level ?? 'info';
  const minOrder = LEVEL_ORDER[level];
  const logFile = opts.logDir
    ? path.join(opts.logDir, `app-${new Date().toISOString().slice(0, 10)}.log`)
    : null;
  if (opts.logDir) {
    try {
      fs.mkdirSync(opts.logDir, { recursive: true });
    } catch {
      // 目录创建失败时只输出控制台
    }
  }

  const write = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < minOrder) return;
    const merged = Object.assign({}, opts.context ?? {}, meta ?? {});
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...(redactValue(merged) as Record<string, unknown>)
    };
    const line = JSON.stringify(record);
    // eslint-disable-next-line no-console
    if (opts.console !== false) console[line === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'log'](line);
    if (logFile) {
      try {
        fs.appendFileSync(logFile, `${line}\n`);
      } catch {
        // 日志写失败不影响业务
      }
    }
  };

  const logger: Logger = {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child: (context) =>
      createLogger({ ...opts, context: { ...(opts.context ?? {}), ...context } })
  };
  return logger;
}
