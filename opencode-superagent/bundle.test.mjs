import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, 'file has no frontmatter');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    fields[line.slice(0, index).trim()] = line
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return { fields, body: match[2] };
}

test('superagent is a primary agent with the orchestration contract', () => {
  const { fields, body } = frontmatter(read('../.opencode/agent/superagent.md'));
  assert.equal(fields.mode, 'primary');
  assert.match(fields.description, /ticket/i);
  assert.match(body, /opencode-superagent\/tickets\.mjs/);
  assert.match(body, /\bsubagent\b/);
  assert.match(body, /This is by an automated agent, not a human\./);
  assert.match(body, /Do not merge/);
  assert.match(body, /If the request asks for a pull request/);
  assert.match(body, /If the request does not ask for a pull request/);
});

test('worker is a subagent with a bounded task contract', () => {
  const { fields, body } = frontmatter(read('../.opencode/agent/superagent-worker.md'));
  assert.equal(fields.mode, 'subagent');
  assert.match(body, /Do not spawn subagents/);
  assert.match(body, /Do not commit/);
  assert.match(body, /exact commands run and their results/);
});

test('command selects the superagent agent and forwards the request', () => {
  const { fields, body } = frontmatter(read('../.opencode/command/superagent.md'));
  assert.equal(fields.agent, 'superagent');
  assert.match(body, /\$ARGUMENTS/);
  assert.match(body, /ask the user for one/);
  assert.match(body, /Do not create a pull request unless the request asks for one/);
});
