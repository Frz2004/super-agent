import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Page, Project, Run, Task, TaskDetail, TaskStatus } from '../shared/types.js';
import { Store } from './db.js';

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
const text = (max: number) => z.string().trim().max(max);
const tags = z
  .array(text(30).min(1))
  .max(8)
  .transform((values) => [...new Set(values)]);
const status = z.enum(['todo', 'in_progress', 'done', 'canceled']);
export const projectInput = z
  .object({ name: text(80).min(1), description: text(2000).default('') })
  .strict();
export const taskInput = z
  .object({
    title: text(160).min(1),
    description: text(10000).default(''),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
    tags: tags.default([]),
    dependencyIds: z.array(z.string().uuid()).max(50).default([]),
  })
  .strict();
export const patchInput = z
  .object({
    title: text(160).min(1).optional(),
    description: text(10000).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    tags: tags.optional(),
    status: status.optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, '至少提供一个修改字段');
export const queryInput = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
    q: text(160).default(''),
    status: status.optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    tag: text(30).optional(),
  })
  .strict();
export type TaskQuery = z.infer<typeof queryInput>;
const transitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'done', 'canceled'],
  in_progress: ['done', 'canceled', 'todo'],
  done: ['todo'],
  canceled: ['todo'],
};
const now = () => new Date().toISOString();
export class Service {
  constructor(readonly store: Store) {}
  private emit(
    type: string,
    projectId: string,
    requestId: string,
    data: Record<string, unknown>,
    taskId: string | null = null,
    runId: string | null = null,
  ) {
    return this.store.event({ type, projectId, requestId, data, taskId, runId });
  }
  project(id: string): Project {
    const row = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw new Problem(404, 'NOT_FOUND', '项目不存在');
    return { ...row, archived: Boolean(row.archived) } as unknown as Project;
  }
  projects(): Project[] {
    return this.store.db
      .prepare('SELECT id FROM projects ORDER BY createdAt,id')
      .all()
      .map((r) => this.project(r.id as string));
  }
  createProject(input: unknown, requestId: string): Project {
    const data = projectInput.parse(input);
    return this.store.atomic(() => {
      const id = randomUUID(),
        at = now();
      this.store.db
        .prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)')
        .run(id, data.name, data.description, 0, at, at);
      this.emit('project.created', id, requestId, { name: data.name });
      return this.project(id);
    });
  }
  patchProject(id: string, input: unknown, requestId: string): Project {
    const data = z
      .object({
        name: text(80).min(1).optional(),
        description: text(2000).optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0)
      .parse(input);
    return this.store.atomic(() => {
      const before = this.project(id),
        after = { ...before, ...data, updatedAt: now() };
      this.store.db
        .prepare('UPDATE projects SET name=?,description=?,archived=?,updatedAt=? WHERE id=?')
        .run(after.name, after.description, +after.archived, after.updatedAt, id);
      this.emit('project.updated', id, requestId, { before, after });
      return after;
    });
  }
  private writableProject(id: string) {
    if (this.project(id).archived) throw new Problem(409, 'PROJECT_ARCHIVED', '项目已归档');
  }
  task(id: string): Task {
    const row = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Problem(404, 'NOT_FOUND', '任务不存在');
    const dependencies = this.store.db
      .prepare(
        'SELECT t.id,t.title,t.status FROM dependencies d JOIN tasks t ON t.id=d.dependencyId WHERE d.taskId=? ORDER BY t.id',
      )
      .all(id);
    return {
      ...row,
      tags: JSON.parse(row.tags as string),
      dependencyIds: dependencies.map((d) => d.id),
      blockedBy: dependencies.filter((d) => d.status !== 'done'),
    } as unknown as Task;
  }
  tasks(projectId: string, query: TaskQuery): Page<Task> {
    this.project(projectId);
    const clauses = ['projectId = ?'],
      params: (string | number)[] = [projectId];
    if (query.status) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.priority) {
      clauses.push('priority = ?');
      params.push(query.priority);
    }
    if (query.tag) {
      clauses.push('EXISTS(SELECT 1 FROM json_each(tasks.tags) WHERE value = ?)');
      params.push(query.tag);
    }
    if (query.q) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const q = '%' + query.q.replace(/[\\%_]/g, '\\$&') + '%';
      params.push(q, q);
    }
    const where = clauses.join(' AND ');
    const total = this.store.db
      .prepare(`SELECT count(*) AS n FROM tasks WHERE ${where}`)
      .get(...params)!.n as number;
    const rows = this.store.db
      .prepare(
        `SELECT id FROM tasks WHERE ${where} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return {
      items: rows.map((r) => this.task(r.id as string)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  detail(id: string): TaskDetail {
    const task = this.task(id);
    return {
      task,
      dependencies: task.dependencyIds.map((id) => this.task(id)),
      dependents: this.store.db
        .prepare('SELECT taskId FROM dependencies WHERE dependencyId=?')
        .all(id)
        .map((r) => this.task(r.taskId as string)),
      runs: this.runs(undefined, id),
    };
  }
  private idempotent<T>(scope: string, key: string | undefined, body: unknown, create: () => T): T {
    if (!key) return create();
    if (key.length > 128 || !/^[\x21-\x7e]+$/.test(key))
      throw new Problem(400, 'INVALID_KEY', 'Idempotency-Key 须为 1—128 个可见 ASCII 字符');
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const existing = this.store.db
      .prepare('SELECT * FROM idempotency WHERE scope=? AND key=?')
      .get(scope, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Problem(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键对应的请求内容不同');
      return JSON.parse(existing.response as string) as T;
    }
    const result = create();
    this.store.db
      .prepare('INSERT INTO idempotency VALUES(?,?,?,?)')
      .run(scope, key, fingerprint, JSON.stringify(result));
    return result;
  }
  createTask(projectId: string, input: unknown, requestId: string, key?: string): Task {
    const data = taskInput.parse(input);
    return this.store.atomic(() =>
      this.idempotent('task:' + projectId, key, data, () => {
        this.writableProject(projectId);
        const id = randomUUID(),
          at = now();
        this.store.db
          .prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(
            id,
            projectId,
            data.title,
            data.description,
            data.priority,
            JSON.stringify(data.tags),
            'todo',
            1,
            at,
            at,
          );
        this.setEdges(id, projectId, data.dependencyIds);
        this.emit(
          'task.created',
          projectId,
          requestId,
          { title: data.title, dependencyIds: data.dependencyIds },
          id,
        );
        return this.task(id);
      }),
    );
  }
  private version(task: Task, version: number) {
    if (task.version !== version)
      throw new Problem(409, 'VERSION_CONFLICT', '任务已被其他操作更新，请刷新后重试', {
        currentVersion: task.version,
      });
  }
  private activeRun(taskId: string) {
    return this.store.db
      .prepare("SELECT id FROM runs WHERE taskId=? AND status IN ('queued','running')")
      .get(taskId);
  }
  private ensureDependencies(task: Task) {
    if (task.blockedBy.length)
      throw new Problem(409, 'DEPENDENCIES_BLOCKED', '请先完成所有前置任务', task.blockedBy);
  }
  private ensureDependentsIdle(taskId: string) {
    const advanced = this.store.db
      .prepare(
        "SELECT t.id FROM dependencies d JOIN tasks t ON t.id=d.taskId WHERE d.dependencyId=? AND (t.status IN ('in_progress','done') OR EXISTS(SELECT 1 FROM runs r WHERE r.taskId=t.id AND r.status IN ('queued','running')))",
      )
      .get(taskId);
    if (advanced)
      throw new Problem(409, 'DEPENDENTS_ACTIVE', '后继任务已开始或完成，不能撤销此前置条件');
  }
  patchTask(id: string, input: unknown, requestId: string): Task {
    const data = patchInput.parse(input);
    return this.store.atomic(() => {
      const before = this.task(id);
      this.writableProject(before.projectId);
      this.version(before, data.version);
      if (this.activeRun(id))
        throw new Problem(409, 'RUN_ACTIVE', '任务执行中，请先取消执行再编辑');
      if (data.status && data.status !== before.status) {
        if (!transitions[before.status].includes(data.status))
          throw new Problem(409, 'INVALID_TRANSITION', '不允许的状态迁移');
        if (data.status === 'in_progress' || data.status === 'done')
          this.ensureDependencies(before);
        if (before.status === 'done') this.ensureDependentsIdle(id);
      }
      const after = { ...before, ...data, version: before.version + 1, updatedAt: now() };
      this.store.db
        .prepare(
          'UPDATE tasks SET title=?,description=?,priority=?,tags=?,status=?,version=?,updatedAt=? WHERE id=?',
        )
        .run(
          after.title,
          after.description,
          after.priority,
          JSON.stringify(after.tags),
          after.status,
          after.version,
          after.updatedAt,
          id,
        );
      this.emit(
        'task.updated',
        before.projectId,
        requestId,
        {
          before: { title: before.title, status: before.status, version: before.version },
          after: { title: after.title, status: after.status, version: after.version },
        },
        id,
      );
      return this.task(id);
    });
  }
  private setEdges(id: string, projectId: string, ids: string[]) {
    if (new Set(ids).size !== ids.length)
      throw new Problem(409, 'DUPLICATE_DEPENDENCY', '不能重复添加依赖');
    for (const dependencyId of ids) {
      if (dependencyId === id)
        throw new Problem(409, 'DEPENDENCY_CYCLE', '任务不能依赖自身', [id, id]);
      if (this.task(dependencyId).projectId !== projectId)
        throw new Problem(409, 'CROSS_PROJECT', '依赖必须属于同一项目');
      // Follow prerequisite edges; a path back to id would close a cycle.
      const visit = (cursor: string, seen: Set<string>): string[] | null => {
        if (cursor === id) return [cursor];
        if (seen.has(cursor)) return null;
        seen.add(cursor);
        for (const edge of this.store.db
          .prepare('SELECT dependencyId FROM dependencies WHERE taskId=?')
          .all(cursor)) {
          const path = visit(edge.dependencyId as string, seen);
          if (path) return [cursor, ...path];
        }
        return null;
      };
      const path = visit(dependencyId, new Set());
      if (path) throw new Problem(409, 'DEPENDENCY_CYCLE', '依赖形成环', [id, ...path]);
    }
    this.store.db.prepare('DELETE FROM dependencies WHERE taskId=?').run(id);
    const insert = this.store.db.prepare('INSERT INTO dependencies VALUES(?,?)');
    for (const dependencyId of ids) insert.run(id, dependencyId);
  }
  dependencies(id: string, input: unknown, requestId: string): Task {
    const data = z
      .object({
        dependencyIds: z.array(z.string().uuid()).max(50),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    return this.store.atomic(() => {
      const before = this.task(id);
      this.writableProject(before.projectId);
      this.version(before, data.version);
      if (!['todo', 'canceled'].includes(before.status) || this.activeRun(id))
        throw new Problem(409, 'DEPENDENCIES_LOCKED', '开始执行后不能修改依赖');
      this.setEdges(id, before.projectId, data.dependencyIds);
      this.store.db
        .prepare('UPDATE tasks SET version=version+1,updatedAt=? WHERE id=?')
        .run(now(), id);
      this.emit(
        'task.dependencies',
        before.projectId,
        requestId,
        { before: before.dependencyIds, after: data.dependencyIds },
        id,
      );
      return this.task(id);
    });
  }
  deleteTask(id: string, version: number, requestId: string) {
    this.store.atomic(() => {
      const task = this.task(id);
      this.writableProject(task.projectId);
      this.version(task, version);
      if (this.store.db.prepare('SELECT 1 FROM dependencies WHERE dependencyId=?').get(id))
        throw new Problem(409, 'TASK_REFERENCED', '其他任务依赖此任务，无法删除');
      if (this.store.db.prepare('SELECT 1 FROM runs WHERE taskId=?').get(id))
        throw new Problem(409, 'RUN_HISTORY_EXISTS', '已有执行历史，请取消任务以保留记录');
      this.store.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      this.emit('task.deleted', task.projectId, requestId, { title: task.title }, id);
    });
  }
  run(id: string): Run {
    const row = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!row) throw new Problem(404, 'NOT_FOUND', '执行记录不存在');
    return {
      ...row,
      steps: JSON.parse(row.steps as string),
      result: row.result ? JSON.parse(row.result as string) : null,
    } as unknown as Run;
  }
  runs(projectId?: string, taskId?: string): Run[] {
    const rows = taskId
      ? this.store.db
          .prepare('SELECT id FROM runs WHERE taskId=? ORDER BY createdAt DESC,id DESC LIMIT 100')
          .all(taskId)
      : projectId
        ? this.store.db
            .prepare(
              'SELECT id FROM runs WHERE projectId=? ORDER BY createdAt DESC,id DESC LIMIT 100',
            )
            .all(projectId)
        : this.store.db
            .prepare('SELECT id FROM runs ORDER BY createdAt DESC,id DESC LIMIT 100')
            .all();
    return rows.map((r) => this.run(r.id as string));
  }
  createRun(taskId: string, input: unknown, requestId: string, key?: string): Run {
    const data = z
      .object({ maxAttempts: z.number().int().min(1).max(5).default(3) })
      .strict()
      .parse(input);
    return this.store.atomic(() =>
      this.idempotent('run:' + taskId, key, data, () => {
        const task = this.task(taskId);
        this.writableProject(task.projectId);
        if (!['todo', 'in_progress'].includes(task.status))
          throw new Problem(409, 'TASK_NOT_RUNNABLE', '只有待办或进行中的任务可以执行');
        this.ensureDependencies(task);
        if (this.activeRun(taskId))
          throw new Problem(409, 'RUN_ACTIVE', '该任务已有排队或执行中的记录');
        const id = randomUUID(),
          at = now();
        this.store.db
          .prepare(
            'INSERT INTO runs(id,taskId,projectId,status,maxAttempts,input,createdAt,availableAt) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            taskId,
            task.projectId,
            'queued',
            data.maxAttempts,
            task.description || task.title,
            at,
            at,
          );
        this.emit('run.queued', task.projectId, requestId, { status: 'queued' }, taskId, id);
        return this.run(id);
      }),
    );
  }
  cancelRun(id: string, requestId: string): Run {
    return this.store.atomic(() => {
      const run = this.run(id);
      if (!['queued', 'running'].includes(run.status))
        throw new Problem(409, 'RUN_TERMINAL', '执行已结束');
      this.store.db
        .prepare("UPDATE runs SET status='canceled',endedAt=?,error=? WHERE id=?")
        .run(now(), '用户取消', id);
      this.store.db
        .prepare(
          "UPDATE tasks SET status='todo',version=version+1,updatedAt=? WHERE id=? AND status='in_progress'",
        )
        .run(now(), run.taskId);
      this.emit('run.canceled', run.projectId, requestId, { status: 'canceled' }, run.taskId, id);
      return this.run(id);
    });
  }
}
