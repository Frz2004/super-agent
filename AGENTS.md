# TaskFlow development instructions

## Repository and boundaries

- This repository contains the TaskFlow application, not the Superagent host/plugin.
- Preserve the existing authorized requester `FBI-6` and bot mention `@Frz2004` in the README unless the human explicitly changes them.
- Work on the ticket's isolated `agent/` branch/worktree. Never push directly to main for follow-up tasks, merge a PR or change deployment credentials without explicit human instruction.
- Never commit databases, `.env`, auth tokens, raw Harness sessions, dependency directories or private chat exports.

## Implementation map

- `shared/types.ts`: public API types.
- `server/db.ts`: SQLite schema, transactions, persisted events.
- `server/service.ts`: validation and business invariants.
- `server/runner.ts`: single-process durable queue and executor.
- `server/app.ts`: HTTP and SSE transport.
- `web/`: React UI, API adapter and CSS.
- `tests/`: service, queue and HTTP tests; `tests/browser/`: Chromium acceptance tests.

## Validation and reporting

- Node >=24, npm; install with `npm ci`. Use the committed lockfile.
- Run `npm run check`, `npm run test:e2e` (after installing Chromium if needed), and `git diff --check` for substantial changes.
- Tests use isolated temporary databases. Do not use the developer's `.data` database.
- Add regression tests for changed invariants; do not weaken existing assertions to make failures disappear.
- Keep state transitions, idempotency and audit writes in one database transaction. Publish SSE only after commit.
- Preserve cancellation terminal guards, active-run uniqueness and loopback binding.
- Keep README, API docs, known limitations and validation report aligned with actual behavior.
- Report exact commands, actual results, limitations, commit SHA and PR URL to the originating conversation.

Read `docs/SUPERAGENT_NEXT_TASK.md` only when assigned that task. Do not implement the entire roadmap in unrelated fixes.
