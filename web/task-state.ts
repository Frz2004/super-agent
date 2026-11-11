import type { Run, Task } from '../shared/types.js';

/**
 * The detail view's "开始执行" button keeps the UI in step with the server rule:
 * no run while a dependency is unfinished, the task is terminal, another run is
 * active, the project is archived, or a request is already in flight.
 */
export function canRunTask(
  task: Pick<Task, 'status' | 'blockedBy'>,
  runs: readonly Pick<Run, 'status'>[],
  context: { archived: boolean; busy: boolean },
): boolean {
  return (
    !context.busy &&
    !context.archived &&
    task.blockedBy.length === 0 &&
    (task.status === 'todo' || task.status === 'in_progress') &&
    !runs.some((run) => run.status === 'queued' || run.status === 'running')
  );
}
