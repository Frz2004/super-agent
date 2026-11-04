import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Runner, RetryableError, textExecutor } from '../server/runner.js';
import type { Run } from '../shared/types.js';
import { deferred, fixture, waitRun } from './helpers.js';
const output: NonNullable<Run['result']> = {
  normalized: 'test',
  words: 1,
  characters: 4,
  sha256: 'test-digest',
};

test('real text executor normalizes Unicode, counts and computes SHA-256', async (t) => {
  const f = fixture();
  const task = f.task('真实任务', { description: '  ＡＢＣ   hello  ' });
  const runner = new Runner(f.service, textExecutor(0));
  t.after(async () => {
    await runner.stop();
    f.store.close();
  });
  const run = f.service.createRun(task.id, {}, 'test');
  const done = waitRun(f.service, run.id);
  runner.tick();
  const result = await done;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result?.normalized, 'ABC hello');
  assert.equal(result.result?.characters, 9);
  assert.match(result.result!.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.steps.length, 3);
  assert.equal(f.service.task(task.id).status, 'done');
});
test('retryable errors retry to success with bounded attempt count', async (t) => {
  const f = fixture(),
    task = f.task('重试');
  const runner = new Runner(
    f.service,
    async (run) => {
      if (run.attempt < 3) throw new RetryableError('暂时失败');
      return output;
    },
    2,
    0,
  );
  t.after(async () => {
    await runner.stop();
    f.store.close();
  });
  runner.start();
  const run = f.service.createRun(task.id, { maxAttempts: 3 }, 'test');
  const done = waitRun(f.service, run.id);
  runner.tick();
  assert.equal((await done).status, 'succeeded');
  assert.equal(f.service.run(run.id).attempt, 3);
  assert.equal(f.store.events().filter((e) => e.type === 'run.retry_scheduled').length, 2);
});
test('retry limit becomes terminal failure', async (t) => {
  const f = fixture(),
    runner = new Runner(
      f.service,
      async () => {
        throw new RetryableError('失败');
      },
      2,
      0,
    );
  t.after(async () => {
    await runner.stop();
    f.store.close();
  });
  runner.start();
  const run = f.service.createRun(f.task('重试耗尽').id, { maxAttempts: 2 }, 'test');
  const done = waitRun(f.service, run.id);
  runner.tick();
  assert.equal((await done).status, 'failed');
  assert.equal(f.service.run(run.id).attempt, 2);
});
test('permanent error never retries and leaves task runnable', async (t) => {
  const f = fixture(),
    task = f.task('永久失败'),
    runner = new Runner(f.service, async () => {
      throw new Error('invalid input');
    });
  t.after(async () => {
    await runner.stop();
    f.store.close();
  });
  const run = f.service.createRun(task.id, {}, 'test');
  const done = waitRun(f.service, run.id);
  runner.tick();
  assert.equal((await done).status, 'failed');
  assert.equal(f.service.run(run.id).attempt, 1);
  assert.equal(f.service.task(task.id).status, 'todo');
});
test('late successful executor cannot overwrite canceled run', async (t) => {
  const f = fixture(),
    gate = deferred<NonNullable<Run['result']>>(),
    task = f.task('取消竞争');
  const runner = new Runner(f.service, async () => gate.promise);
  t.after(async () => {
    await runner.stop();
    f.store.close();
  });
  const run = f.service.createRun(task.id, {}, 'test');
  runner.tick();
  assert.equal(f.service.run(run.id).status, 'running');
  f.service.cancelRun(run.id, 'cancel');
  runner.cancel(run.id);
  gate.resolve(output);
  // Let the resolved executor complete its actual terminal-state guard.
  for (let i = 0; i < 50 && runner.runningCount; i++) await delay(1);
  assert.equal(runner.runningCount, 0);
  assert.equal(f.service.run(run.id).status, 'canceled');
  assert.equal(f.service.task(task.id).status, 'todo');
  assert.equal(f.store.events().filter((e) => e.type === 'run.succeeded').length, 0);
});
test('concurrency never exceeds configured limit and canceled queued run is skipped', async (t) => {
  const f = fixture(),
    gate = deferred<void>();
  let current = 0,
    peak = 0;
  const runner = new Runner(
    f.service,
    async () => {
      current++;
      peak = Math.max(peak, current);
      await gate.promise;
      current--;
      return output;
    },
    2,
  );
  t.after(async () => {
    gate.resolve();
    await runner.stop();
    f.store.close();
  });
  const runs = [0, 1, 2, 3].map((n) => f.service.createRun(f.task('任务' + n).id, {}, 'test'));
  f.service.cancelRun(runs[3].id, 'test');
  runner.tick();
  runner.tick();
  assert.equal(runner.runningCount, 2);
  assert.equal(peak, 2);
  // The queue orders by createdAt and then id; creation order is not queue order
  // because createRun can produce the same millisecond and ids are random UUIDs.
  const candidates = runs.slice(0, 3);
  const active = candidates.filter((run) => f.service.run(run.id).status === 'running');
  const waiting = candidates.filter((run) => f.service.run(run.id).status === 'queued');
  assert.equal(active.length, 2);
  assert.equal(waiting.length, 1);
  assert.equal(f.service.run(runs[3].id).status, 'canceled');
  const done = Promise.all(active.map((run) => waitRun(f.service, run.id)));
  gate.resolve();
  await done;
  for (let i = 0; i < 50 && runner.runningCount; i++) await delay(1);
  const third = waitRun(f.service, waiting[0].id);
  runner.tick();
  await third;
  assert.equal(peak, 2);
  assert.equal(f.service.run(runs[3].id).attempt, 0);
});
test('restart recovery fails interrupted running work and resumes queued work', async (t) => {
  const f = fixture(),
    interrupted = f.service.createRun(f.task('中断').id, {}, 'test'),
    queued = f.service.createRun(f.task('排队').id, {}, 'test');
  f.store.db.prepare("UPDATE runs SET status='running',attempt=1 WHERE id=?").run(interrupted.id);
  f.store.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(interrupted.taskId);
  const runner = new Runner(f.service, async () => output);
  t.after(async () => {
    await runner.stop();
    f.store.close();
  });
  const done = waitRun(f.service, queued.id);
  runner.start();
  assert.equal(f.service.run(interrupted.id).status, 'failed');
  assert.match(f.service.run(interrupted.id).error!, /进程中断/);
  assert.equal(f.service.task(interrupted.taskId).status, 'todo');
  assert.equal((await done).status, 'succeeded');
});
