import { spawn } from 'node:child_process';
const children = ['dev:server', 'dev:web'].map((script) =>
  spawn('npm', ['run', script], { stdio: 'inherit' }),
);
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => close(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close());
