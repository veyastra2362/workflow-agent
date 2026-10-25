// Electron 冒烟测试：以 WORKFLOW_AGENT_SMOKE=1 启动应用，
// 主进程完成初始化（窗口创建、数据库打开、IPC 注册）后输出 SMOKE_OK 并退出。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, WORKFLOW_AGENT_SMOKE: '1' }
});

const guard = setTimeout(() => {
  console.error('SMOKE_TIMEOUT: 应用 90 秒内未退出');
  child.kill();
  process.exit(1);
}, 90000);

child.on('exit', (code) => {
  clearTimeout(guard);
  process.exit(code ?? 1);
});
