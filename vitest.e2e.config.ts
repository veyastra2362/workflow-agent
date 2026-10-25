import { defineConfig } from 'vitest/config';

// E2E 测试独立配置：不与普通测试混合运行
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 串行：避免多个 Electron 实例争用
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }
    },
    silent: false
  }
});
