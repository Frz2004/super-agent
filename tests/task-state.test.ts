import assert from 'node:assert/strict';
import test from 'node:test';
import type { Run, Task } from '../shared/types.js';
import { canRunTask } from '../web/task-state.js';

const task = (
  status: Task['status'],
  blockedBy: Task['blockedBy'] = [],
): Pick<Task, 'status' | 'blockedBy'> => ({ status, blockedBy });
const run = (status: Run['status']): Pick<Run, 'status'> => ({ status });
const idle = { archived: false, busy: false };

test('canRunTask allows runnable tasks when no run is active', () => {
  assert.equal(canRunTask(task('todo'), [], idle), true);
  assert.equal(
    canRunTask(task('in_progress'), [run('succeeded'), run('failed'), run('canceled')], idle),
    true,
  );
});

test('canRunTask blocks unfinished dependencies', () => {
  assert.equal(
    canRunTask(task('todo', [{ id: 't1', title: '前置任务', status: 'todo' }]), [], idle),
    false,
  );
});

test('canRunTask blocks terminal tasks and archived projects', () => {
  assert.equal(canRunTask(task('done'), [], idle), false);
  assert.equal(canRunTask(task('canceled'), [], idle), false);
  assert.equal(canRunTask(task('todo'), [], { archived: true, busy: false }), false);
});

test('canRunTask blocks an active run and an in-flight request', () => {
  assert.equal(canRunTask(task('in_progress'), [run('queued')], idle), false);
  assert.equal(canRunTask(task('in_progress'), [run('running')], idle), false);
  assert.equal(canRunTask(task('todo'), [], { archived: false, busy: true }), false);
});
