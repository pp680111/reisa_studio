// 以冒烟模式启动真实应用主进程（REISA_SMOKE=1），退出码即测试结果。
// 冒烟断言位于 apps/desktop/src/main/smoke.ts，随主进程一同打包。
const { spawn } = require('node:child_process');
const path = require('node:path');

const electronBinary = require(
  path.resolve(__dirname, '..', 'apps', 'desktop', 'node_modules', 'electron'),
);
const proc = spawn(electronBinary, ['.'], {
  cwd: path.resolve(__dirname, '..', 'apps', 'desktop'),
  env: { ...process.env, REISA_SMOKE: '1' },
  stdio: 'inherit',
});
proc.on('exit', (code) => process.exit(code === 0 ? 0 : 1));
