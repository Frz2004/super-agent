import { resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './db.js';
import { Service } from './service.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? 8787);
const concurrency = z.coerce
  .number()
  .int()
  .min(1)
  .max(8)
  .parse(process.env.TASKFLOW_CONCURRENCY ?? 2);
const store = new Store(resolve(process.env.TASKFLOW_DB ?? '.data/taskflow.sqlite'));
const service = new Service(store),
  runner = new Runner(service, undefined, concurrency);
runner.start();
const server = createApp(service, runner).listen(port, '127.0.0.1', () =>
  console.log(`TaskFlow: http://127.0.0.1:${port}`),
);
server.on('error', async (error) => {
  console.error(error.message);
  await runner.stop();
  store.close();
  process.exitCode = 1;
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    await runner.stop();
    store.close();
  });
