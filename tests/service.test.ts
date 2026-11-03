import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Problem, queryInput } from '../server/service.js';
import { fixture } from './helpers.js';
import { Store } from '../server/db.js';
import { Service } from '../server/service.js';
const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof Problem && e.code === code);
function setup(t: TestContext) {
  const f = fixture();
  t.after(() => f.store.close());
  return f;
}

test('SQLite data and audit survive closing and reopening a real database', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(join(dir, 'test.sqlite')),
    task = f.task('持久化');
  f.store.close();
  const store = new Store(join(dir, 'test.sqlite'));
  t.after(() => store.close());
  assert.equal(new Service(store).task(task.id).title, '持久化');
  assert.equal(store.events().length, 2);
});
test('project update, archive and restore', (t) => {
  const f = setup(t);
  assert.equal(
    f.service.patchProject(f.project.id, { name: '更新', archived: true }, 'test').archived,
    true,
  );
  rejects(() => f.task('禁止创建'), 'PROJECT_ARCHIVED');
  f.service.patchProject(f.project.id, { archived: false }, 'test');
  assert.equal(f.task('允许创建').title, '允许创建');
});
test('same-project dependencies block and unlock tasks', (t) => {
  const f = setup(t),
    a = f.task('前置'),
    b = f.task('后继', { dependencyIds: [a.id] });
  assert.equal(b.blockedBy[0].id, a.id);
  rejects(() => f.service.createRun(b.id, {}, 'test'), 'DEPENDENCIES_BLOCKED');
  f.service.patchTask(a.id, { version: 1, status: 'done' }, 'test');
  assert.deepEqual(f.service.task(b.id).blockedBy, []);
  assert.equal(f.service.createRun(b.id, {}, 'test').status, 'queued');
});
test('canceled prerequisite never counts as completed', (t) => {
  const f = setup(t),
    a = f.task('前置'),
    b = f.task('后继', { dependencyIds: [a.id] });
  f.service.patchTask(a.id, { status: 'canceled', version: 1 }, 'test');
  rejects(
    () => f.service.patchTask(b.id, { status: 'in_progress', version: 1 }, 'test'),
    'DEPENDENCIES_BLOCKED',
  );
});
test('cross-project dependency rolls back entire task creation', (t) => {
  const f = setup(t),
    p2 = f.service.createProject({ name: '另一个项目' }, 'test'),
    a = f.task('A');
  const count = f.store.events().length;
  rejects(
    () => f.service.createTask(p2.id, { title: '非法任务', dependencyIds: [a.id] }, 'test'),
    'CROSS_PROJECT',
  );
  assert.equal(f.service.tasks(p2.id, queryInput.parse({})).total, 0);
  assert.equal(f.store.events().length, count);
});
test('self dependency is rejected', (t) => {
  const f = setup(t),
    a = f.task('A');
  rejects(
    () => f.service.dependencies(a.id, { version: 1, dependencyIds: [a.id] }, 'test'),
    'DEPENDENCY_CYCLE',
  );
});
test('duplicate dependency is rejected', (t) => {
  const f = setup(t),
    a = f.task('A'),
    b = f.task('B');
  rejects(
    () => f.service.dependencies(b.id, { version: 1, dependencyIds: [a.id, a.id] }, 'test'),
    'DUPLICATE_DEPENDENCY',
  );
});
test('multi-node cycle returns cycle path and leaves old edges intact', (t) => {
  const f = setup(t),
    a = f.task('A'),
    b = f.task('B', { dependencyIds: [a.id] }),
    c = f.task('C', { dependencyIds: [b.id] });
  assert.throws(
    () => f.service.dependencies(a.id, { version: 1, dependencyIds: [c.id] }, 'test'),
    (e: unknown) =>
      e instanceof Problem &&
      e.code === 'DEPENDENCY_CYCLE' &&
      JSON.stringify(e.details) === JSON.stringify([a.id, c.id, b.id, a.id]),
  );
  assert.deepEqual(f.service.task(a.id).dependencyIds, []);
});
test('completed tasks cannot change their dependency set', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.service.patchTask(a.id, { version: 1, status: 'done' }, 'test');
  rejects(
    () => f.service.dependencies(a.id, { version: 2, dependencyIds: [] }, 'test'),
    'DEPENDENCIES_LOCKED',
  );
});
test('cannot invalidate a prerequisite used by active or completed dependent', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.service.patchTask(a.id, { version: 1, status: 'done' }, 'test');
  const b = f.task('B', { dependencyIds: [a.id] });
  f.service.createRun(b.id, {}, 'test');
  rejects(
    () => f.service.patchTask(a.id, { version: 2, status: 'todo' }, 'test'),
    'DEPENDENTS_ACTIVE',
  );
});
test('optimistic lock rejects stale edit without extra success event', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.service.patchTask(a.id, { title: 'winner', version: 1 }, 'first');
  const count = f.store.events().length;
  rejects(
    () => f.service.patchTask(a.id, { title: 'loser', version: 1 }, 'second'),
    'VERSION_CONFLICT',
  );
  assert.equal(f.service.task(a.id).title, 'winner');
  assert.equal(f.store.events().length, count);
});
test('invalid transition is rejected', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.service.patchTask(a.id, { version: 1, status: 'done' }, 'test');
  rejects(
    () => f.service.patchTask(a.id, { version: 2, status: 'canceled' }, 'test'),
    'INVALID_TRANSITION',
  );
});
test('referenced tasks cannot be deleted', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.task('B', { dependencyIds: [a.id] });
  rejects(() => f.service.deleteTask(a.id, 1, 'test'), 'TASK_REFERENCED');
});
test('deletion preserves durable audit and removes prerequisite edges', (t) => {
  const f = setup(t),
    a = f.task('A'),
    b = f.task('B', { dependencyIds: [a.id] });
  f.service.deleteTask(b.id, 1, 'test');
  assert.equal(f.service.detail(a.id).dependents.length, 0);
  assert.equal(f.store.events().at(-1)?.type, 'task.deleted');
});
test('tasks with execution history cannot be deleted', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.service.createRun(a.id, {}, 'test');
  rejects(() => f.service.deleteTask(a.id, 1, 'test'), 'RUN_HISTORY_EXISTS');
});
test('idempotent creation replays one response without extra event', (t) => {
  const f = setup(t);
  const first = f.service.createTask(f.project.id, { title: 'A' }, 'first', 'same');
  const second = f.service.createTask(f.project.id, { title: 'A' }, 'second', 'same');
  assert.deepEqual(first, second);
  assert.equal(f.service.tasks(f.project.id, queryInput.parse({})).total, 1);
  assert.equal(f.store.events().length, 2);
});
test('same key with different request body conflicts', (t) => {
  const f = setup(t);
  f.service.createTask(f.project.id, { title: 'A' }, 'first', 'same');
  rejects(
    () => f.service.createTask(f.project.id, { title: 'B' }, 'second', 'same'),
    'IDEMPOTENCY_CONFLICT',
  );
});
test('task and run keys are independently scoped', (t) => {
  const f = setup(t),
    a = f.service.createTask(f.project.id, { title: 'A' }, 'test', 'same');
  const first = f.service.createRun(a.id, {}, 'test', 'same');
  assert.equal(f.service.createRun(a.id, {}, 'test', 'same').id, first.id);
});
test('duplicate active run is rejected and active task cannot be edited', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.service.createRun(a.id, {}, 'test');
  rejects(() => f.service.createRun(a.id, {}, 'test'), 'RUN_ACTIVE');
  rejects(() => f.service.patchTask(a.id, { version: 1, title: 'X' }, 'test'), 'RUN_ACTIVE');
});
test('archived projects cannot start new runs', (t) => {
  const f = setup(t),
    a = f.task('A');
  f.service.patchProject(f.project.id, { archived: true }, 'test');
  rejects(() => f.service.createRun(a.id, {}, 'test'), 'PROJECT_ARCHIVED');
});
test('canceling queued run is terminal and audited', (t) => {
  const f = setup(t),
    a = f.task('A'),
    run = f.service.createRun(a.id, {}, 'test');
  assert.equal(f.service.cancelRun(run.id, 'cancel').status, 'canceled');
  rejects(() => f.service.cancelRun(run.id, 'again'), 'RUN_TERMINAL');
});
test('filtering, literal search, stable pagination and tags', (t) => {
  const f = setup(t);
  f.task('100% literal', { priority: 'high', tags: ['后端'] });
  f.task('1000 other');
  f.task("SQL ' OR 1=1 --");
  assert.equal(f.service.tasks(f.project.id, queryInput.parse({ q: '100%' })).total, 1);
  assert.equal(
    f.service.tasks(f.project.id, queryInput.parse({ priority: 'high', tag: '后端' })).total,
    1,
  );
  const a = f.service.tasks(f.project.id, queryInput.parse({ pageSize: 2 })),
    b = f.service.tasks(f.project.id, queryInput.parse({ pageSize: 2, page: 2 }));
  assert.equal(new Set([...a.items, ...b.items].map((t) => t.id)).size, 3);
});
test('rolled back events are never broadcast to subscribers', (t) => {
  const f = setup(t);
  const received: unknown[] = [];
  f.store.changes.on('event', (event) => received.push(event));
  assert.throws(() =>
    f.store.atomic(() => {
      f.store.event({
        projectId: f.project.id,
        taskId: null,
        runId: null,
        type: 'rollback',
        data: {},
        requestId: 'test',
      });
      throw new Error('rollback');
    }),
  );
  assert.equal(received.length, 0);
  assert.equal(f.store.events().length, 1);
});
