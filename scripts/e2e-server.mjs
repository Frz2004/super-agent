import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const temp = mkdtempSync(join(tmpdir(), 'taskflow-browser-'));
const child = spawn(process.execPath, ['dist/server/server/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: '8798',
    TASKFLOW_DB: join(temp, 'test.sqlite'),
    NODE_ENV: 'production',
  },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  rmSync(temp, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});
