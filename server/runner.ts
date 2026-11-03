import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Run, RunStep } from '../shared/types.js';
import { Service } from './service.js';

export class RetryableError extends Error {}
export type Executor = (
  run: Run,
  signal: AbortSignal,
  step: (name: string, detail?: string) => void,
) => Promise<NonNullable<Run['result']>>;
export function textExecutor(stepMs = 650): Executor {
  return async (run, signal, step) => {
    step('校验输入');
    await delay(stepMs, undefined, { signal });
    if (!run.input.trim()) throw new Error('输入文本不能为空');
    step('规范化文本');
    const normalized = run.input.normalize('NFKC').trim().replace(/\s+/g, ' ');
    await delay(stepMs, undefined, { signal });
    step('统计与 SHA-256 校验');
    const result = {
      normalized,
      words: normalized.split(/\s+/u).length,
      characters: [...normalized].length,
      sha256: createHash('sha256').update(normalized).digest('hex'),
    };
    await delay(stepMs, undefined, { signal });
    return result;
  };
}
export class Runner {
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  readonly concurrency: number;
  constructor(
    readonly service: Service,
    readonly execute: Executor = textExecutor(),
    concurrency = 2,
    readonly retryDelayMs = 500,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error('Concurrency must be an integer from 1 to 8');
    this.concurrency = concurrency;
  }
  recover() {
    const { store } = this.service;
    store.atomic(() => {
      for (const row of store.db.prepare("SELECT id FROM runs WHERE status='running'").all()) {
        const run = this.service.run(row.id as string);
        store.db
          .prepare("UPDATE runs SET status='failed',endedAt=?,error=? WHERE id=?")
          .run(new Date().toISOString(), '进程中断，执行状态已恢复为失败；可手动重新执行', run.id);
        store.db
          .prepare(
            "UPDATE tasks SET status='todo',version=version+1,updatedAt=? WHERE id=? AND status='in_progress'",
          )
          .run(new Date().toISOString(), run.taskId);
        store.event({
          projectId: run.projectId,
          taskId: run.taskId,
          runId: run.id,
          type: 'run.interrupted',
          data: { status: 'failed' },
          requestId: 'recovery:' + run.id,
        });
      }
    });
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.recover();
    this.timer = setInterval(() => this.tick(), 100);
    this.tick();
  }
  tick() {
    if (this.stopping) return;
    const slots = this.concurrency - this.active.size;
    if (slots <= 0) return;
    const rows = this.service.store.db
      .prepare(
        "SELECT id FROM runs WHERE status='queued' AND availableAt<=? ORDER BY createdAt,id LIMIT ?",
      )
      .all(new Date().toISOString(), slots);
    for (const row of rows) {
      const id = row.id as string;
      // A queued retry can become available while its prior attempt is still cleaning up.
      if (this.active.has(id)) continue;
      const controller = new AbortController();
      const promise = this.perform(id, controller.signal).finally(() => this.active.delete(id));
      this.active.set(id, { controller, promise });
    }
  }
  cancel(id: string) {
    this.active.get(id)?.controller.abort();
  }
  get runningCount() {
    return this.active.size;
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const item of this.active.values()) item.controller.abort();
    await Promise.all([...this.active.values()].map((item) => item.promise));
  }
  private async perform(id: string, signal: AbortSignal) {
    const { store } = this.service;
    const at = () => new Date().toISOString();
    const run = store.atomic(() => {
      const current = this.service.run(id);
      if (current.status !== 'queued') return null;
      store.db
        .prepare(
          "UPDATE runs SET status='running',attempt=attempt+1,startedAt=?,steps='[]',error=NULL WHERE id=?",
        )
        .run(at(), id);
      store.db
        .prepare("UPDATE tasks SET status='in_progress',version=version+1,updatedAt=? WHERE id=?")
        .run(at(), current.taskId);
      store.event({
        projectId: current.projectId,
        taskId: current.taskId,
        runId: id,
        type: 'run.started',
        data: { attempt: current.attempt + 1 },
        requestId: 'run:' + id,
      });
      return this.service.run(id);
    });
    if (!run) return;
    try {
      const result = await this.execute(run, signal, (name, detail) => {
        if (this.stopping || signal.aborted) return;
        store.atomic(() => {
          const current = this.service.run(id);
          if (current.status !== 'running') return;
          const steps: RunStep[] = current.steps.map((s) => ({ ...s, state: 'done' as const }));
          steps.push({ name, detail, state: 'running', at: at() });
          store.db.prepare('UPDATE runs SET steps=? WHERE id=?').run(JSON.stringify(steps), id);
          store.event({
            projectId: run.projectId,
            taskId: run.taskId,
            runId: id,
            type: 'run.step',
            data: { name, attempt: run.attempt },
            requestId: 'run:' + id,
          });
        });
      });
      if (this.stopping) return;
      store.atomic(() => {
        const current = this.service.run(id);
        if (current.status !== 'running') return; // Cancellation wins over late completion.
        store.db
          .prepare("UPDATE runs SET status='succeeded',result=?,steps=?,endedAt=? WHERE id=?")
          .run(
            JSON.stringify(result),
            JSON.stringify(current.steps.map((s) => ({ ...s, state: 'done' }))),
            at(),
            id,
          );
        store.db
          .prepare("UPDATE tasks SET status='done',version=version+1,updatedAt=? WHERE id=?")
          .run(at(), run.taskId);
        store.event({
          projectId: run.projectId,
          taskId: run.taskId,
          runId: id,
          type: 'run.succeeded',
          data: { result, attempt: run.attempt },
          requestId: 'run:' + id,
        });
      });
    } catch (error) {
      if (this.stopping) return;
      store.atomic(() => {
        const current = this.service.run(id);
        if (current.status !== 'running') return;
        const retry = error instanceof RetryableError && run.attempt < run.maxAttempts;
        const message = error instanceof Error ? error.message.slice(0, 500) : '执行失败';
        store.db
          .prepare('UPDATE runs SET status=?,error=?,endedAt=?,availableAt=? WHERE id=?')
          .run(
            retry ? 'queued' : 'failed',
            message,
            retry ? null : at(),
            new Date(Date.now() + this.retryDelayMs * 2 ** (run.attempt - 1)).toISOString(),
            id,
          );
        if (!retry)
          store.db
            .prepare("UPDATE tasks SET status='todo',version=version+1,updatedAt=? WHERE id=?")
            .run(at(), run.taskId);
        store.event({
          projectId: run.projectId,
          taskId: run.taskId,
          runId: id,
          type: retry ? 'run.retry_scheduled' : 'run.failed',
          data: { error: message, attempt: run.attempt },
          requestId: 'run:' + id,
        });
      });
    }
  }
}
