import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AuditEvent } from '../shared/types.js';

export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  private pending: AuditEvent[] | null = null;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')), tags TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('todo','in_progress','done','canceled')), version INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dependencies(taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, dependencyId TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(taskId, dependencyId), CHECK(taskId <> dependencyId));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), projectId TEXT NOT NULL REFERENCES projects(id), status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')), attempt INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL, input TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', result TEXT, error TEXT, createdAt TEXT NOT NULL, startedAt TEXT, endedAt TEXT, availableAt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(taskId) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(projectId, createdAt DESC, id);
      CREATE INDEX IF NOT EXISTS runs_queue ON runs(status, availableAt);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT NOT NULL, taskId TEXT, runId TEXT, type TEXT NOT NULL, data TEXT NOT NULL, requestId TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(projectId, id);
      CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key));
      INSERT OR IGNORE INTO migrations VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    this.changes.setMaxListeners(100);
  }
  atomic<T>(fn: () => T): T {
    if (this.pending) throw new Error('Nested transactions are not supported');
    this.db.exec('BEGIN IMMEDIATE');
    this.pending = [];
    let result: T;
    let committed: AuditEvent[];
    try {
      result = fn();
      committed = this.pending;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.pending = null;
    }
    // Publish only after COMMIT, so SSE cannot observe rolled-back changes.
    for (const event of committed) this.changes.emit('event', event);
    return result;
  }
  event(event: Omit<AuditEvent, 'id' | 'at'>) {
    if (!this.pending) throw new Error('Audit events must be written inside a transaction');
    const at = new Date().toISOString();
    const result = this.db
      .prepare(
        'INSERT INTO events(projectId,taskId,runId,type,data,requestId,at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        event.projectId,
        event.taskId,
        event.runId,
        event.type,
        JSON.stringify(event.data),
        event.requestId,
        at,
      );
    const entry = { ...event, id: Number(result.lastInsertRowid), at };
    this.pending.push(entry);
    return entry;
  }
  events(after = 0, projectId?: string, limit = 200): AuditEvent[] {
    const rows = projectId
      ? this.db
          .prepare('SELECT * FROM events WHERE id > ? AND projectId = ? ORDER BY id LIMIT ?')
          .all(after, projectId, limit)
      : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit);
    return rows.map(
      (row) => ({ ...row, data: JSON.parse(row.data as string) }) as unknown as AuditEvent,
    );
  }
  close() {
    this.changes.removeAllListeners();
    this.db.close();
  }
}
