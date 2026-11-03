import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { Runner } from '../server/runner.js';
import type { Task } from '../shared/types.js';
import { fixture } from './helpers.js';
async function setup(t: TestContext) {
  const f = fixture(),
    runner = new Runner(f.service, async () => ({
      normalized: 'test',
      words: 1,
      characters: 4,
      sha256: 'test',
    }));
  const server = createApp(f.service, runner, '/nonexistent').listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runner.stop();
    f.store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(base + '/api' + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...f, runner, base, request };
}
test('health and project/task HTTP roundtrip', async (t) => {
  const f = await setup(t);
  const health = await f.request('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).database, 'sqlite');
  const created = await f.request(`/projects/${f.project.id}/tasks`, 'POST', {
    title: 'HTTP 测试',
  });
  assert.equal(created.status, 201);
  const task = (await created.json()) as Task;
  assert.equal((await (await f.request('/tasks/' + task.id)).json()).task.title, 'HTTP 测试');
});
test('invalid body, query, unknown API and malformed JSON have structured errors', async (t) => {
  const f = await setup(t);
  for (const response of [
    await f.request('/projects', 'POST', { name: '' }),
    await f.request(`/projects/${f.project.id}/tasks?page=-1`),
    await f.request('/missing'),
  ]) {
    assert.ok(response.status >= 400 && response.status < 500);
    const error = (await response.json()).error;
    assert.ok(error.requestId);
    assert.ok(error.code);
  }
  const bad = await fetch(f.base + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_JSON');
});
test('foreign origins and rebinding host are rejected', async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.request('/projects', 'POST', { name: 'x' }, { Origin: 'https://untrusted.invalid' }))
      .status,
    403,
  );
  // fetch/Undici normalizes Host; use an actual HTTP request to exercise rebinding protection.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      f.base + '/api/health',
      { headers: { Host: 'untrusted.invalid' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});
test('concurrent HTTP idempotency requests create exactly one task', async (t) => {
  const f = await setup(t);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.request(
        `/projects/${f.project.id}/tasks`,
        'POST',
        { title: '一次创建' },
        { 'Idempotency-Key': 'same-http-key' },
      ),
    ),
  );
  const ids = await Promise.all(
    responses.map(async (r) => {
      assert.equal(r.status, 201);
      return (await r.json()).id;
    }),
  );
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.service.tasks(f.project.id, { page: 1, pageSize: 30, q: '' }).total, 1);
  const conflict = await f.request(
    `/projects/${f.project.id}/tasks`,
    'POST',
    { title: '不同内容' },
    { 'Idempotency-Key': 'same-http-key' },
  );
  assert.equal(conflict.status, 409);
});
test('concurrent HTTP edits yield one winner and one version conflict', async (t) => {
  const f = await setup(t),
    task = f.task('竞态');
  const responses = await Promise.all(
    ['one', 'two'].map((title) => f.request('/tasks/' + task.id, 'PATCH', { title, version: 1 })),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
});
test('concurrent HTTP run replays create one run and one execution', async (t) => {
  const f = await setup(t),
    task = f.task('只执行一次');
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.request(`/tasks/${task.id}/runs`, 'POST', {}, { 'Idempotency-Key': 'same-run-key' }),
    ),
  );
  const ids = await Promise.all(
    responses.map(async (r) => {
      assert.equal(r.status, 201);
      return (await r.json()).id;
    }),
  );
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.service.runs(undefined, task.id).length, 1);
  assert.equal(f.store.events().filter((e) => e.type === 'run.started').length, 1);
});
test('SSE replays after Last-Event-ID, orders events, streams live changes and cleans listeners', async (t) => {
  const f = await setup(t),
    task = f.task('已有事件'),
    cursor = f.store.events()[0].id;
  const controller = new AbortController();
  const response = await fetch(f.base + `/api/events/stream?projectId=${f.project.id}`, {
    headers: { 'Last-Event-ID': String(cursor) },
    signal: controller.signal,
  });
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /event: change/);
  assert.ok(!first.includes('id: ' + cursor + '\n'));
  assert.ok(first.includes(task.id));
  const last = f.store.events().at(-1)!.id;
  f.service.patchTask(task.id, { version: 1, title: '实时变更' }, 'stream-test');
  const next = decoder.decode((await reader.read()).value);
  assert.ok(next.includes('id: ' + (last + 1)));
  assert.match(next, /实时变更/);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && f.store.changes.listenerCount('event'); i++) await delay(2);
  assert.equal(f.store.changes.listenerCount('event'), 0);
});
test('invalid SSE cursor fails before streaming headers', async (t) => {
  const f = await setup(t);
  const r = await f.request('/events/stream', 'GET', undefined, { 'Last-Event-ID': 'abc' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'VALIDATION_ERROR');
});
