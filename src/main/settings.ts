import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PersistedSettings } from '../shared/types';
import { mcpServerConfigSchema } from '../tools/mcp/validate-config';

/**
 * Configuration：
 * - 非敏感设置持久化到 userData/settings.json；
 * - API Key 只保存在内存（ModelConfigStore），绝不写盘、不进日志。
 */

export const DEFAULT_SETTINGS: PersistedSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 4096,
  streaming: true,
  maxSteps: 40,
  taskTimeoutMs: 15 * 60_000,
  modelTimeoutMs: 120_000,
  toolResultMaxChars: 20_000,
  maxContextChars: 120_000,
  allowedTestCommands: ['pnpm test', 'npm test', 'npx vitest run', 'npx jest', 'pytest', 'go test ./...', 'cargo test'],
  autoApproveTestCommands: false,
  requireApprovalForWrites: false,
  requireApprovalForWeb: false,
  searchProvider: 'none',
  searchBaseUrl: '',
  browserEnabled: false,
  requireApprovalForMcp: true,
  mcpServers: [],
  lastWorkspace: null
};

const settingsSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(64).max(200_000),
  streaming: z.boolean(),
  maxSteps: z.number().int().min(1).max(200),
  taskTimeoutMs: z.number().int().min(10_000).max(6 * 60 * 60_000),
  modelTimeoutMs: z.number().int().min(5_000).max(600_000),
  toolResultMaxChars: z.number().int().min(1_000).max(200_000),
  maxContextChars: z.number().int().min(10_000).max(2_000_000),
  allowedTestCommands: z.array(z.string().min(1).max(200)).max(50),
  autoApproveTestCommands: z.boolean(),
  requireApprovalForWrites: z.boolean(),
  requireApprovalForWeb: z.boolean(),
  searchProvider: z.enum(['none', 'searxng', 'brave']),
  searchBaseUrl: z.string().max(500),
  browserEnabled: z.boolean(),
  requireApprovalForMcp: z.boolean(),
  mcpServers: z.array(mcpServerConfigSchema).max(16),
  lastWorkspace: z.string().nullable()
});

export function loadSettings(userDataDir: string): PersistedSettings {
  const file = path.join(userDataDir, 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(raw as object) });
    if (parsed.success) return parsed.data;
  } catch {
    // 首次运行或文件损坏 —— 使用默认设置
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(userDataDir: string, settings: PersistedSettings): void {
  const file = path.join(userDataDir, 'settings.json');
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw new Error(`设置校验失败：${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parsed.data, null, 2), 'utf8');
}

const modelConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(200_000).optional(),
  streaming: z.boolean().optional()
});

/** API Key 的内存持有者（进程退出即消失，不落盘） */
export class ModelConfigStore {
  private cfg: z.infer<typeof modelConfigSchema> | null = null;

  set(input: unknown): { ok: true } {
    const parsed = modelConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`模型配置不合法：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    this.cfg = parsed.data;
    return { ok: true };
  }

  merge(input: unknown): void {
    // apiKey 留空时保留旧值，其余字段覆盖
    const partial = (input ?? {}) as Record<string, unknown>;
    const merged = {
      ...(this.cfg ?? {}),
      ...partial
    };
    if (typeof partial.apiKey !== 'string' || partial.apiKey.length === 0) {
      if (this.cfg) merged.apiKey = this.cfg.apiKey;
    }
    this.set(merged);
  }

  get(): z.infer<typeof modelConfigSchema> | null {
    return this.cfg;
  }

  hasApiKey(): boolean {
    return !!this.cfg?.apiKey;
  }
}
