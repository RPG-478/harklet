import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const venv = resolve('sidecar/.venv');
const win = process.platform === 'win32';
const python = join(venv, win ? 'Scripts/python.exe' : 'bin/python');
const quicksand = join(venv, win ? 'Scripts/quicksand.exe' : 'bin/quicksand');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PIP_NO_CACHE_DIR: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

if (win) run('py', ['-3', '-m', 'venv', venv]);
else run('python3', ['-m', 'venv', venv]);
run(python, ['-m', 'pip', 'install', 'quick-sandbox==0.12.0']);
run(quicksand, ['install', 'qemu', 'quicksand-cua']);
