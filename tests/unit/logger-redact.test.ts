import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../src/main/logger';
import { makeTempDir } from '../helpers';

describe('阶段 3：日志脱敏落盘', () => {
  it('敏感字段在写入日志文件前被脱敏', () => {
    const dir = makeTempDir('wa-log-');
    const logger = createLogger({ logDir: dir, level: 'info', console: false });
    logger.info('auth.attempt', {
      apiKey: 'sk-abcdefghijklmnopqrst',
      header: 'Bearer abcdef1234567890abcd',
      user: 'alice',
      nested: { password: 'p@ss-w0rd-xyz', ok: true }
    });
    logger.error('boom', { detail: 'Authorization=live_secret_token_99; retry' });

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');

    // 密钥绝不出现
    expect(content).not.toContain('sk-abcdefghijklmnopqrst');
    expect(content).not.toContain('abcdef1234567890abcd');
    expect(content).not.toContain('p@ss-w0rd-xyz');
    expect(content).not.toContain('live_secret_token_99');
    // 脱敏标记与非敏感字段保留
    expect(content).toContain('[REDACTED');
    expect(content).toContain('alice');
    expect(content).toContain('"ok":true');
    // 结构化 JSON Lines
    for (const line of content.trim().split('\n')) {
      const rec = JSON.parse(line) as { level: string; msg: string };
      expect(['info', 'error']).toContain(rec.level);
      expect(rec.msg).toBeTruthy();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('child logger 继承上下文并同样脱敏', () => {
    const dir = makeTempDir('wa-log2-');
    const logger = createLogger({ logDir: dir, level: 'debug', console: false }).child({
      taskId: 't-1',
      apiKey: 'sk-childcontext123456'
    });
    logger.debug('step', { n: 1 });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(content).not.toContain('sk-childcontext123456');
    expect(content).toContain('t-1');
    expect(content).toContain('"n":1');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
