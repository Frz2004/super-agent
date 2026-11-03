import { Store } from '../server/db.js';
import { Service } from '../server/service.js';
import type { Run } from '../shared/types.js';
export function fixture(path = ':memory:') {
  const store = new Store(path),
    service = new Service(store);
  const project = service.createProject({ name: '测试项目' }, 'test');
  const task = (title: string, extra: Record<string, unknown> = {}) =>
    service.createTask(project.id, { title, description: 'hello workflow', ...extra }, 'test');
  return { store, service, project, task };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export function waitRun(
  service: Service,
  id: string,
  terminal = ['succeeded', 'failed', 'canceled'],
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Run did not reach expected state: ' + JSON.stringify(service.run(id))));
    }, 4000);
    function cleanup() {
      clearTimeout(timer);
      service.store.changes.off('event', check);
    }
    function check() {
      const run = service.run(id);
      if (terminal.includes(run.status)) {
        cleanup();
        resolve(run);
      }
    }
    service.store.changes.on('event', check);
    check();
  });
}
