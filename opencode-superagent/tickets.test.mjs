import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  addTask,
  claimTicket,
  completeTicket,
  createTicket,
  failTicket,
  listTickets,
  readTicket,
  updateTask,
  updateTicket,
} from './tickets.mjs';

const cli = fileURLToPath(new URL('./tickets.mjs', import.meta.url));
const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'opencode-superagent-tickets-'));
  roots.push(root);
  return root;
}

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('creates a ticket with a stable id and empty state', () => {
  const root = tempRoot();
  const ticket = createTicket(root, {
    title: 'Add a health check',
    request: 'Expose a health endpoint and test it.',
    acceptance: ['GET /health returns 200'],
    branch: 'agent/sa-test',
  });
  assert.match(ticket.id, /^sa-\d{8}-[a-f0-9]{6}$/);
  assert.equal(ticket.status, 'todo');
  assert.deepEqual(ticket.acceptance, ['GET /health returns 200']);
  assert.equal(ticket.branch, 'agent/sa-test');
  assert.equal(ticket.events[0].type, 'created');
  assert.deepEqual(readTicket(root, ticket.id), ticket);
  assert.deepEqual(listTickets(root), [ticket]);
});

test('updates fields and records events', () => {
  const root = tempRoot();
  const ticket = createTicket(root, { title: 'Update docs', request: 'Fix the README.' });
  const updated = updateTicket(root, ticket.id, {
    title: 'Update README',
    status: 'in_progress',
    acceptance: ['README command works'],
    branch: 'agent/sa-readme',
    pr: 'https://github.com/o/r/pull/1',
    note: 'started',
  });
  assert.equal(updated.title, 'Update README');
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.pr, 'https://github.com/o/r/pull/1');
  assert.equal(updated.events.at(-1).type, 'note');
  assert.equal(listTickets(root, 'todo').length, 0);
  assert.equal(listTickets(root, 'in_progress').length, 1);
});

test('tracks tasks from todo to done', () => {
  const root = tempRoot();
  const ticket = createTicket(root, { title: 'Refactor', request: 'Split the module.' });
  const first = addTask(root, ticket.id, { title: 'Extract helper', details: 'src/a.ts' });
  assert.equal(first.task.id, 't1');
  const second = addTask(root, ticket.id, { title: 'Add tests' });
  assert.equal(second.task.id, 't2');

  const finished = updateTask(root, ticket.id, 't1', {
    status: 'done',
    notes: 'npm test passed',
  }).ticket;
  assert.equal(finished.tasks[0].status, 'done');
  assert.equal(finished.tasks[0].notes, 'npm test passed');
  assert.equal(finished.tasks[1].status, 'todo');
});

test('claims, completes and blocks tickets', () => {
  const root = tempRoot();
  const ticket = createTicket(root, { title: 'Ship it', request: 'Implement the thing.' });
  assert.equal(claimTicket(root, ticket.id).status, 'in_progress');
  assert.equal(completeTicket(root, ticket.id, 'done').status, 'done');
  assert.throws(() => claimTicket(root, ticket.id), /already done/);

  const other = createTicket(root, { title: 'Blocked', request: 'Needs a decision.' });
  const blocked = failTicket(root, other.id, 'Need the API shape');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.events.at(-1).detail, 'Need the API shape');
});

test('rejects malformed ids and statuses', () => {
  const root = tempRoot();
  assert.throws(() => readTicket(root, '../../etc/passwd'), /Invalid ticket id/);
  const ticket = createTicket(root, { title: 'Valid', request: 'Valid request.' });
  assert.throws(
    () => updateTicket(root, ticket.id, { status: 'nope' }),
    /Unsupported ticket status/,
  );
  assert.throws(() => updateTask(root, ticket.id, '../t1', { status: 'done' }), /Invalid task id/);
  assert.throws(() => addTask(root, ticket.id, { title: '' }), /Missing required option/);
});

test('CLI creates, lists and reads tickets as JSON', () => {
  const root = tempRoot();
  const created = JSON.parse(
    run([
      '--root',
      root,
      'create',
      '--title',
      'CLI ticket',
      '--request',
      'Created through the CLI.',
      '--acceptance',
      'it works',
      '--json',
    ]),
  );
  assert.equal(created.title, 'CLI ticket');
  assert.equal(created.acceptance[0], 'it works');

  const listed = JSON.parse(run(['--root', root, 'list', '--json']));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const read = JSON.parse(run(['--root', root, 'get', created.id, '--json']));
  assert.equal(read.id, created.id);

  const help = run(['--help']);
  assert.match(help, /Usage: node opencode-superagent\/tickets\.mjs/);
});

test('CLI rejects unknown commands without a stack trace', () => {
  const root = tempRoot();
  assert.throws(
    () => run(['--root', root, 'nope']),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /error: Unknown command: nope/);
      assert.doesNotMatch(String(error.stderr), /at main/);
      return true;
    },
  );
});
