/**
 * 内存密钥存储：敏感 Key（模型 Key、搜索服务 Key）只存在于运行进程内存，
 * 绝不写入配置文件、日志或事件。切换/重置配置时立即清除。
 */
export class SecretStore {
  private readonly vals = new Map<string, string>();

  set(key: string, value: string): void {
    this.vals.set(key, value);
  }

  get(key: string): string | null {
    return this.vals.get(key) ?? null;
  }

  clear(key: string): void {
    this.vals.delete(key);
  }

  has(key: string): boolean {
    return this.vals.has(key);
  }
}

export const SEARCH_KEY = 'webSearchApiKey';
