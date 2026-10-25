// 打包产物冒烟测试：启动免安装目录中的应用并验证关键功能
// 使用：node scripts/smoke-dist.mjs [path-to-exe]
//   不传参数时自动查找 release/win-unpacked/ 下的可执行文件
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function findExe() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const dir = path.join(root, 'release', 'win-unpacked');
  const candidates = fs.readdirSync(dir).filter((f) => f.endsWith('.exe'));
  if (candidates.length === 0) throw new Error(`未找到 .exe in ${dir}`);
  return path.join(dir, candidates[0]);
}

const exe = findExe();
console.log(`[smoke:dist] exe: ${exe}`);

if (!fs.existsSync(exe)) {
  console.error('SMOKE_DIST_FAIL: 可执行文件不存在');
  process.exit(1);
}

const child = spawn(exe, [], {
  stdio: 'inherit',
  env: { ...process.env, WORKFLOW_AGENT_SMOKE: '1' }
});

const guard = setTimeout(() => {
  console.error('SMOKE_DIST_TIMEOUT: 应用 60 秒内未退出');
  child.kill();
  process.exit(1);
}, 60_000);

child.on('exit', (code) => {
  clearTimeout(guard);
  if (code === 0) {
    console.log('SMOKE_DIST_OK');
    process.exit(0);
  } else {
    console.error(`SMOKE_DIST_FAIL: 退出码 ${code}`);
    process.exit(1);
  }
});
