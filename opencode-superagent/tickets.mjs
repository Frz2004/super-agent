#!/usr/bin/env node
/**
 * Local ticket store for the native opencode superagent bundle.
 *
 * This is a small CLI, not a service. The superagent agent invokes it through
 * the shell to create a ticket, add tasks, and record progress. State lives in
 * `.data/opencode-superagent/tickets/` and is intentionally not committed.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_ROOT = '.data/opencode-superagent';
export const TICKET_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'dropped'];
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'failed'];
const TICKET_ID = /^sa-\d{8}-[a-f0-9]{6}$/;
const TASK_ID = /^t\d+$/;

const USAGE = `Usage: node opencode-superagent/tickets.mjs [--root <dir>] <command> [options]

Commands:
  create --title <title> --request <text> [--acceptance <text>]... [--branch <name>]
  list [--status <status>] [--json]
  get <ticket-id> [--json]
  update <ticket-id> [--title <title>] [--status <status>] [--acceptance <text>]...
         [--branch <name>] [--pr <url>] [--note <text>]
  claim <ticket-id>
  complete <ticket-id> [--summary <text>]
  fail <ticket-id> --reason <text>
  task add <ticket-id> --title <title> [--details <text>]
  task update <ticket-id> <task-id> [--status <status>] [--notes <text>]
  task list <ticket-id> [--json]

Ticket statuses: ${TICKET_STATUSES.join(', ')}
Task statuses:   ${TASK_STATUSES.join(', ')}

Options:
  --root <dir>   state directory (default: ${DEFAULT_ROOT}, or $OPENCODE_SUPERAGENT_STATE)
  --json         machine-readable output
  --help, -h     show this help
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function ticketDirectory(root) {
  return join(root, 'tickets');
}

function assertTicketId(id) {
  if (!TICKET_ID.test(id ?? '')) throw new UsageError(`Invalid ticket id: ${id ?? '<missing>'}`);
  return id;
}

function assertTaskId(id) {
  if (!TASK_ID.test(id ?? '')) throw new UsageError(`Invalid task id: ${id ?? '<missing>'}`);
  return id;
}

function requireString(value, option) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`Missing required option ${option}`);
  }
  return value.trim();
}

function requireStatus(value) {
  const status = requireString(value, '--status');
  if (!TICKET_STATUSES.includes(status)) {
    throw new UsageError(`Unsupported ticket status ${JSON.stringify(status)}`);
  }
  return status;
}

function requireTaskStatus(value) {
  const status = requireString(value, '--status');
  if (!TASK_STATUSES.includes(status)) {
    throw new UsageError(`Unsupported task status ${JSON.stringify(status)}`);
  }
  return status;
}

function validateTicket(ticket, source = 'ticket') {
  if (typeof ticket !== 'object' || ticket === null || Array.isArray(ticket)) {
    throw new UsageError(`${source} is not an object`);
  }
  if (!TICKET_ID.test(ticket.id ?? '')) throw new UsageError(`${source} has an invalid id`);
  if (typeof ticket.title !== 'string' || ticket.title === '') {
    throw new UsageError(`${source} has no title`);
  }
  if (!TICKET_STATUSES.includes(ticket.status)) {
    throw new UsageError(`${source} has an invalid status`);
  }
  if (!Array.isArray(ticket.tasks)) throw new UsageError(`${source} has no tasks array`);
  for (const task of ticket.tasks) {
    if (!TASK_ID.test(task?.id ?? '')) throw new UsageError(`${source} has an invalid task id`);
    if (!TASK_STATUSES.includes(task.status)) {
      throw new UsageError(`${source} task ${task.id} has an invalid status`);
    }
  }
  if (!Array.isArray(ticket.events)) throw new UsageError(`${source} has no events array`);
  return ticket;
}

function ticketPath(root, id) {
  return join(ticketDirectory(root), `${assertTicketId(id)}.json`);
}

export function newTicketId(root) {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
  for (;;) {
    const id = `sa-${stamp}-${randomBytes(3).toString('hex')}`;
    if (!existsSync(ticketPath(root, id))) return id;
  }
}

function writeTicket(root, ticket) {
  const directory = ticketDirectory(root);
  mkdirSync(directory, { recursive: true });
  const target = ticketPath(root, ticket.id);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ticket, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
}

function addEvent(ticket, type, detail) {
  const at = nowIso();
  ticket.events.push({ at, type, ...(detail === undefined ? {} : { detail }) });
  ticket.updatedAt = at;
}

export function readTicket(root, id) {
  const path = ticketPath(root, id);
  if (!existsSync(path)) throw new UsageError(`Ticket not found: ${id}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateTicket(parsed, path);
}

export function listTickets(root, status) {
  const directory = ticketDirectory(root);
  if (!existsSync(directory)) return [];
  const tickets = [];
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!TICKET_ID.test(id)) continue;
    const ticket = readTicket(root, id);
    if (status === undefined || ticket.status === status) tickets.push(ticket);
  }
  return tickets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createTicket(root, input) {
  const title = requireString(input.title, '--title');
  const request = requireString(input.request, '--request');
  const at = nowIso();
  const ticket = {
    id: newTicketId(root),
    title,
    request,
    acceptance: Array.isArray(input.acceptance)
      ? input.acceptance.map((item) => item.trim()).filter(Boolean)
      : [],
    status: 'todo',
    tasks: [],
    branch: typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim() : null,
    pr: null,
    createdAt: at,
    updatedAt: at,
    events: [],
  };
  addEvent(ticket, 'created', `requested: ${title}`);
  writeTicket(root, ticket);
  return ticket;
}

export function updateTicket(root, id, changes) {
  const ticket = readTicket(root, id);
  if (changes.title !== undefined) ticket.title = requireString(changes.title, '--title');
  if (changes.status !== undefined) ticket.status = requireStatus(changes.status);
  if (changes.acceptance !== undefined) {
    ticket.acceptance = changes.acceptance.map((item) => item.trim()).filter(Boolean);
  }
  if (changes.branch !== undefined) ticket.branch = changes.branch.trim() || null;
  if (changes.pr !== undefined) ticket.pr = changes.pr.trim() || null;
  if (changes.note !== undefined) addEvent(ticket, 'note', changes.note);
  else addEvent(ticket, 'updated');
  writeTicket(root, ticket);
  return ticket;
}

export function claimTicket(root, id) {
  const ticket = readTicket(root, id);
  if (ticket.status === 'done' || ticket.status === 'dropped') {
    throw new UsageError(`Ticket ${id} is already ${ticket.status}`);
  }
  ticket.status = 'in_progress';
  addEvent(ticket, 'claimed');
  writeTicket(root, ticket);
  return ticket;
}

export function completeTicket(root, id, summary) {
  const ticket = readTicket(root, id);
  ticket.status = 'done';
  addEvent(ticket, 'completed', summary);
  writeTicket(root, ticket);
  return ticket;
}

export function failTicket(root, id, reason) {
  const ticket = readTicket(root, id);
  ticket.status = 'blocked';
  addEvent(ticket, 'blocked', requireString(reason, '--reason'));
  writeTicket(root, ticket);
  return ticket;
}

export function addTask(root, id, input) {
  const ticket = readTicket(root, id);
  const title = requireString(input.title, '--title');
  const next = ticket.tasks.reduce((max, task) => Math.max(max, Number(task.id.slice(1))), 0) + 1;
  const at = nowIso();
  const task = {
    id: `t${next}`,
    title,
    details: typeof input.details === 'string' ? input.details.trim() : '',
    status: 'todo',
    notes: '',
    createdAt: at,
    updatedAt: at,
  };
  ticket.tasks.push(task);
  addEvent(ticket, 'task.added', `${task.id}: ${title}`);
  writeTicket(root, ticket);
  return { ticket, task };
}

export function updateTask(root, id, taskId, changes) {
  const ticket = readTicket(root, id);
  const checkedTaskId = assertTaskId(taskId);
  const task = ticket.tasks.find((entry) => entry.id === checkedTaskId);
  if (!task) throw new UsageError(`Task not found: ${taskId}`);
  if (changes.status !== undefined) task.status = requireTaskStatus(changes.status);
  if (changes.notes !== undefined) task.notes = changes.notes;
  task.updatedAt = nowIso();
  addEvent(ticket, 'task.updated', `${task.id}: ${task.status}`);
  writeTicket(root, ticket);
  return { ticket, task };
}

function formatDate(value) {
  return typeof value === 'string' ? value.replace('T', ' ').slice(0, 19) : '';
}

function printTicket(ticket, json) {
  if (json) console.log(JSON.stringify(ticket, null, 2));
  else console.log(`${ticket.id} ${ticket.status} ${ticket.title}`);
}

function printTickets(tickets, json) {
  if (json) {
    console.log(JSON.stringify(tickets, null, 2));
    return;
  }
  if (tickets.length === 0) {
    console.log('No tickets.');
    return;
  }
  const rows = tickets.map((ticket) => {
    const done = ticket.tasks.filter((task) => task.status === 'done').length;
    return [
      ticket.id,
      ticket.status,
      `${done}/${ticket.tasks.length}`,
      formatDate(ticket.updatedAt),
      ticket.title,
    ];
  });
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  for (const row of rows) {
    console.log(row.map((value, index) => value.padEnd(widths[index])).join('  '));
  }
}

function parseArguments(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        root: { type: 'string' },
        title: { type: 'string' },
        request: { type: 'string' },
        acceptance: { type: 'string', multiple: true },
        status: { type: 'string' },
        note: { type: 'string' },
        details: { type: 'string' },
        summary: { type: 'string' },
        reason: { type: 'string' },
        branch: { type: 'string' },
        pr: { type: 'string' },
        notes: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArguments(argv);
  if (values.help || positionals.length === 0 || positionals[0] === 'help') {
    console.log(USAGE);
    return;
  }
  const root = resolve(values.root ?? process.env.OPENCODE_SUPERAGENT_STATE ?? DEFAULT_ROOT);
  const [command, ...rest] = positionals;

  switch (command) {
    case 'create': {
      const ticket = createTicket(root, {
        title: values.title,
        request: values.request,
        acceptance: values.acceptance,
        branch: values.branch,
      });
      printTicket(ticket, values.json);
      return;
    }
    case 'list': {
      const status = values.status === undefined ? undefined : requireStatus(values.status);
      printTickets(listTickets(root, status), values.json);
      return;
    }
    case 'get': {
      const ticket = readTicket(root, rest[0]);
      printTicket(ticket, true);
      return;
    }
    case 'update': {
      const ticket = updateTicket(root, rest[0], values);
      printTicket(ticket, values.json);
      return;
    }
    case 'claim': {
      const ticket = claimTicket(root, rest[0]);
      printTicket(ticket, values.json);
      return;
    }
    case 'complete': {
      const ticket = completeTicket(root, rest[0], values.summary);
      printTicket(ticket, values.json);
      return;
    }
    case 'fail': {
      const ticket = failTicket(root, rest[0], values.reason);
      printTicket(ticket, values.json);
      return;
    }
    case 'task': {
      const [subcommand, ticketId, taskId] = rest;
      if (subcommand === 'add') {
        const { ticket, task } = addTask(root, ticketId, {
          title: values.title,
          details: values.details,
        });
        if (values.json) printTicket(ticket, true);
        else console.log(`Added task ${task.id} to ${ticket.id}: ${task.title}`);
        return;
      }
      if (subcommand === 'update') {
        const { ticket, task } = updateTask(root, ticketId, taskId, {
          status: values.status,
          notes: values.notes,
        });
        if (values.json) printTicket(ticket, true);
        else console.log(`Updated task ${task.id} (${task.status}) in ${ticket.id}`);
        return;
      }
      if (subcommand === 'list') {
        const ticket = readTicket(root, ticketId);
        if (values.json) {
          console.log(JSON.stringify(ticket.tasks, null, 2));
        } else if (ticket.tasks.length === 0) {
          console.log('No tasks.');
        } else {
          for (const task of ticket.tasks) {
            console.log(`${task.id}  ${task.status.padEnd(12)} ${task.title}`);
          }
        }
        return;
      }
      throw new UsageError(`Unknown task command: ${subcommand ?? '<missing>'}`);
    }
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      console.error('Run with --help for usage.');
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
