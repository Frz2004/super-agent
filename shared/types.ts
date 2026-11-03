export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'canceled';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type Priority = 'low' | 'medium' | 'high';
export interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  tags: string[];
  status: TaskStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  dependencyIds: string[];
  blockedBy: { id: string; title: string; status: TaskStatus }[];
}
export interface RunStep {
  name: string;
  state: 'running' | 'done';
  at: string;
  detail?: string;
}
export interface Run {
  id: string;
  taskId: string;
  projectId: string;
  status: RunStatus;
  attempt: number;
  maxAttempts: number;
  input: string;
  steps: RunStep[];
  result: { normalized: string; words: number; characters: number; sha256: string } | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  availableAt: string;
}
export interface AuditEvent {
  id: number;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  type: string;
  data: Record<string, unknown>;
  requestId: string;
  at: string;
}
export interface TaskDetail {
  task: Task;
  dependencies: Task[];
  dependents: Task[];
  runs: Run[];
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
