import { resolve } from 'node:path';
import { Store } from './db.js';
import { Service } from './service.js';
const store = new Store(resolve(process.env.TASKFLOW_DB ?? '.data/taskflow.sqlite'));
try {
  const service = new Service(store);
  if (service.projects().length) {
    console.log('已有项目，跳过种子数据。');
  } else {
    const project = service.createProject(
      { name: 'Superagent 实验室', description: '从需求到交付，用可追溯的任务与执行记录协作。' },
      'seed',
    );
    const spec = service.createTask(
      project.id,
      {
        title: '梳理任务输入与验收标准',
        description: '明确任务边界、输入文本和可重复的验收步骤。',
        priority: 'high',
        tags: ['准备', '文档'],
      },
      'seed',
    );
    service.patchTask(spec.id, { version: spec.version, status: 'done' }, 'seed');
    const backend = service.createTask(
      project.id,
      {
        title: '构建持久化执行流程',
        description: 'TaskFlow stores durable jobs, audit events, and deterministic text results.',
        priority: 'high',
        tags: ['后端'],
        dependencyIds: [spec.id],
      },
      'seed',
    );
    const frontend = service.createTask(
      project.id,
      {
        title: '完善中文任务工作台',
        description: '创建清晰的任务看板，呈现依赖、状态和实时进度。',
        tags: ['前端'],
        dependencyIds: [spec.id],
      },
      'seed',
    );
    service.createTask(
      project.id,
      {
        title: '端到端交付验收',
        description: '验证前后端协作、运行恢复与审计记录。',
        priority: 'high',
        tags: ['验收'],
        dependencyIds: [backend.id, frontend.id],
      },
      'seed',
    );
    service.createTask(
      project.id,
      {
        title: '整理下一阶段的演进方案',
        description: '增加依赖图可视化、更多执行器和可观测性导出。',
        priority: 'low',
        tags: ['规划'],
      },
      'seed',
    );
    const canceled = service.createTask(
      project.id,
      { title: '移除过时的试验路线', priority: 'low', tags: ['历史'] },
      'seed',
    );
    service.patchTask(canceled.id, { version: canceled.version, status: 'canceled' }, 'seed');
    console.log('已创建演示项目与 6 个任务。');
  }
} finally {
  store.close();
}
