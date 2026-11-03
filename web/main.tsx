import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownUp,
  ArrowRight,
  Archive,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  FolderKanban,
  GitBranch,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  Radio,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type {
  AuditEvent,
  Page,
  Priority,
  Project,
  Run,
  Task,
  TaskDetail,
  TaskStatus,
} from '../shared/types.js';
import { api, ApiError } from './api.js';
import './style.css';

const statuses: TaskStatus[] = ['todo', 'in_progress', 'done', 'canceled'];
const statusNames: Record<string, string> = {
  todo: '待开始',
  in_progress: '进行中',
  done: '已完成',
  canceled: '已取消',
  queued: '排队中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
};
const priorityNames = { high: '高优先级', medium: '普通', low: '低优先级' };
const time = (at: string) =>
  new Date(at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const eventNames: Record<string, string> = {
  'project.created': '创建项目',
  'project.updated': '更新项目',
  'task.created': '创建任务',
  'task.updated': '更新任务',
  'task.dependencies': '调整依赖',
  'task.deleted': '删除任务',
  'run.queued': '执行入队',
  'run.started': '开始执行',
  'run.step': '步骤更新',
  'run.succeeded': '执行成功',
  'run.failed': '执行失败',
  'run.retry_scheduled': '等待重试',
  'run.canceled': '执行取消',
  'run.interrupted': '中断恢复',
};
function Badge({ status }: { status: string }) {
  return <span className={'status ' + status}>{statusNames[status] ?? status}</span>;
}
function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState('');
  const [pageData, setPageData] = useState<Page<Task>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 30,
  });
  const [allTasks, setAllTasks] = useState<Task[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [events, setEvents] = useState<AuditEvent[]>([]);
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState(''),
    [priority, setPriority] = useState(''),
    [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true),
    [connection, setConnection] = useState('连接中'),
    [revision, setRevision] = useState(0);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'project' | 'task' | null>(null),
    [selectedTask, setSelectedTask] = useState(''),
    [detail, setDetail] = useState<TaskDetail | null>(null);
  const [selectedRun, setSelectedRun] = useState(''),
    [edit, setEdit] = useState(false),
    [deleting, setDeleting] = useState(false);
  const requestSeq = useRef(0);
  const project = projects.find((p) => p.id === projectId);
  const refreshProjects = useCallback(async () => {
    const data = await api<Project[]>('/projects');
    setProjects(data);
    setProjectId((prev) => (data.some((p) => p.id === prev) ? prev : (data[0]?.id ?? '')));
    setLoading(false);
  }, []);
  useEffect(() => {
    void refreshProjects().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, [refreshProjects]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setSelectedTask('');
    setDetail(null);
    setPage(1);
    setFilter('');
    setPriority('');
    setQuery('');
  }, [projectId]);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const seq = ++requestSeq.current;
    const params = new URLSearchParams({ page: String(page), pageSize: '30', q: search });
    if (filter) params.set('status', filter);
    if (priority) params.set('priority', priority);
    const [tasks, list, currentRuns, audit] = await Promise.all([
      api<Page<Task>>(`/projects/${projectId}/tasks?${params}`),
      api<Page<Task>>(`/projects/${projectId}/tasks?pageSize=100`),
      api<Run[]>(`/runs?projectId=${projectId}`),
      api<AuditEvent[]>(`/events?projectId=${projectId}&limit=1000`),
    ]);
    if (seq !== requestSeq.current) return;
    setPageData(tasks);
    setAllTasks(list.items);
    setRuns(currentRuns);
    setEvents(audit);
    setLoading(false);
  }, [projectId, page, search, filter, priority]);
  useEffect(() => {
    if (projectId) {
      setLoading(true);
      void refresh().catch((e) => {
        setError(e.message);
        setLoading(false);
      });
    }
  }, [refresh, revision, projectId]);
  useEffect(() => {
    if (!projectId) return;
    setConnection('连接中');
    const stream = new EventSource(`/api/events/stream?projectId=${projectId}`);
    let cursor = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    stream.onopen = () => setConnection('实时连接');
    stream.onerror = () => setConnection('正在重连');
    stream.addEventListener('change', (event) => {
      const message = event as MessageEvent,
        id = Number(message.lastEventId);
      if (id <= cursor) return;
      cursor = id;
      clearTimeout(timer);
      timer = setTimeout(() => {
        setRevision((n) => n + 1);
        void refreshProjects().catch((e) => setError(e.message));
      }, 100);
    });
    return () => {
      clearTimeout(timer);
      stream.close();
    };
  }, [projectId, refreshProjects]);
  useEffect(() => {
    if (!selectedTask) return;
    let alive = true;
    void api<TaskDetail>('/tasks/' + selectedTask)
      .then((data) => {
        if (alive) setDetail(data);
      })
      .catch((e) => {
        if (alive) {
          setDetail(null);
          setError(e.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedTask, revision]);
  useEffect(() => {
    setEdit(false);
    setDeleting(false);
    setSelectedRun('');
  }, [selectedTask]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(t);
  }, [notice]);
  async function action(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setRevision((n) => n + 1);
      await refreshProjects();
      setNotice(message);
    } catch (e) {
      const problem = e as ApiError;
      setError(
        problem.message +
          (problem.code === 'VERSION_CONFLICT' ? '（已刷新最新数据，请重新编辑）' : ''),
      );
      setRevision((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }
  function openTask(task: Task) {
    setDetail(null);
    setSelectedTask(task.id);
  }
  const active = runs.filter((r) => ['queued', 'running'].includes(r.status));
  const completed = allTasks.filter((t) => t.status === 'done').length,
    blocked = allTasks.filter((t) => t.blockedBy.length && t.status === 'todo').length;
  const chosenRun = detail?.runs.find((r) => r.id === selectedRun) ?? detail?.runs[0];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="TaskFlow 首页">
          <span className="brand-icon">
            <Layers3 size={22} />
          </span>
          TaskFlow<span className="version">0.1</span>
        </a>
        <div className="workspace-label">
          工作空间<span>LOCAL</span>
        </div>
        <div className="sidebar-nav selected">
          <LayoutDashboard size={17} />
          工作流控制台
          <ChevronRight size={14} />
        </div>
        <div className="section-label">
          项目{' '}
          <button className="icon-button" aria-label="新建项目" onClick={() => setModal('project')}>
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="项目列表">
          {projects.map((p) => (
            <button
              key={p.id}
              className={'project-link ' + (p.id === projectId ? 'active' : '')}
              onClick={() => setProjectId(p.id)}
            >
              <FolderKanban size={16} />
              <span>{p.name}</span>
              {p.archived && <Archive size={13} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="mini-label">为可追溯的协作而建</span>
          <p>
            任务有依赖，执行有记录。
            <br />
            每一次变更都可以回看。
          </p>
          <div className="local-indicator">
            <span />
            本地 SQLite · 数据持久化
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            工作空间
            <ChevronRight size={13} />
            <b>{project?.name ?? '项目总览'}</b>
          </div>
          <span className={'connection ' + (connection === '实时连接' ? 'online' : '')}>
            <Radio size={14} />
            {connection}
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">PROJECT WORKSPACE</div>
              <h1>
                {project?.name ?? '创建你的第一个项目'}
                {project?.archived && <Badge status="canceled" />}
              </h1>
              <p>{project?.description || '把复杂目标拆成清晰任务，让每一步交付都有迹可循。'}</p>
            </div>
            <div className="heading-actions">
              {project && (
                <button
                  className="button subtle"
                  disabled={busy}
                  onClick={() =>
                    void action(
                      () => api('/projects/' + projectId, 'PATCH', { archived: !project.archived }),
                      project.archived ? '项目已恢复' : '项目已归档',
                    )
                  }
                >
                  <Archive size={15} />
                  {project.archived ? '恢复项目' : '归档'}
                </button>
              )}
              <button
                className="button primary"
                disabled={!!project?.archived}
                onClick={() => setModal(project ? 'task' : 'project')}
              >
                <Plus size={17} />
                {project ? '新建任务' : '新建项目'}
              </button>
            </div>
          </div>
          {error && (
            <div className="alert" role="alert">
              <span>{error}</span>
              <button aria-label="关闭错误" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              <CheckCircle2 size={17} />
              {notice}
            </div>
          )}
          {project && (
            <>
              <section className="stats-grid" aria-label="项目概览">
                <Metric
                  label="项目任务"
                  value={allTasks.length === 100 ? '100+' : String(allTasks.length)}
                  icon={<FolderKanban size={19} />}
                  note="按目标组织工作"
                />
                <Metric
                  label="执行中 / 排队"
                  value={String(active.length)}
                  icon={<Zap size={19} />}
                  note="持久化队列 · 并发执行"
                  accent
                />
                <Metric
                  label="已经完成"
                  value={String(completed)}
                  icon={<CheckCircle2 size={19} />}
                  note="前置条件已就绪"
                />
                <Metric
                  label="等待前置任务"
                  value={String(blocked)}
                  icon={<GitBranch size={19} />}
                  note="依赖完成后解锁"
                />
              </section>
              <div className="board-top">
                <div className="board-title">
                  <LayoutDashboard size={17} />
                  <h2>任务看板</h2>
                  <span className="count">{pageData.total}</span>
                </div>
                <div className="filters">
                  <label className="search-box">
                    <Search size={15} />
                    <input
                      aria-label="搜索任务"
                      placeholder="搜索任务内容…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="筛选任务状态"
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">全部状态</option>
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {statusNames[s]}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="筛选优先级"
                    value={priority}
                    onChange={(e) => {
                      setPriority(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">全部优先级</option>
                    {Object.entries(priorityNames).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {loading ? (
                <div className="loading">
                  <LoaderCircle className="spin" size={24} />
                  正在读取项目…
                </div>
              ) : (
                <div className="kanban">
                  {statuses.map((s) => {
                    const tasks = pageData.items.filter((t) => t.status === s);
                    return (
                      <section
                        className={'column col-' + s}
                        key={s}
                        aria-label={statusNames[s] + '列'}
                      >
                        <div className="column-heading">
                          <span className="column-dot" />
                          <h3>{statusNames[s]}</h3>
                          <span>{tasks.length}</span>
                          <button
                            className="icon-button"
                            aria-label={'在' + statusNames[s] + '列新建任务'}
                            disabled={!!project.archived}
                            onClick={() => setModal('task')}
                          >
                            <Plus size={15} />
                          </button>
                        </div>
                        <div className="column-cards">
                          {tasks.map((task) => (
                            <button
                              key={task.id}
                              className="task-card"
                              data-testid="task-card"
                              onClick={() => openTask(task)}
                            >
                              <div className="card-top">
                                <span className={'priority priority-' + task.priority}>
                                  <ArrowDownUp size={12} />
                                  {priorityNames[task.priority]}
                                </span>
                                <span className="task-code">
                                  {task.id.slice(0, 6).toUpperCase()}
                                </span>
                              </div>
                              <h4>{task.title}</h4>
                              <p>{task.description || '尚未添加任务说明'}</p>
                              <div className="tags">
                                {task.tags.map((t) => (
                                  <span key={t}>{t}</span>
                                ))}
                              </div>
                              <div className="card-bottom">
                                {task.blockedBy.length > 0 && task.status !== 'done' ? (
                                  <span className="blocked">
                                    <GitBranch size={13} />
                                    {task.blockedBy.length} 个前置待完成
                                  </span>
                                ) : (
                                  <span>
                                    <Check size={13} />
                                    {task.status === 'done' ? '任务已完成' : '依赖已就绪'}
                                  </span>
                                )}
                                <ChevronRight size={14} />
                              </div>
                            </button>
                          ))}
                          {tasks.length === 0 && (
                            <div className="column-empty">
                              <Circle size={19} />
                              <span>
                                {search || filter || priority ? '没有匹配的任务' : '此列暂无任务'}
                              </span>
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
              <div className="pagination">
                <span>
                  第 {page} 页 · 共 {pageData.total} 个任务
                  {allTasks.length === 100 ? ' · 概览统计仅计最近 100 项' : ''}
                </span>
                <button
                  className="button small"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </button>
                <button
                  className="button small"
                  disabled={page * 30 >= pageData.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
              <section className="activity-panel">
                <div className="panel-heading">
                  <div>
                    <Activity size={17} />
                    <h2>最近活动</h2>
                    <span className="muted">已持久化的变更记录</span>
                  </div>
                  <span className="live-label">
                    <span />
                    LIVE
                  </span>
                </div>
                {events.length ? (
                  [...events]
                    .reverse()
                    .slice(0, 6)
                    .map((event) => (
                      <div className="activity-row" key={event.id}>
                        <span
                          className={
                            'event-icon ' + (event.type.endsWith('succeeded') ? 'success' : '')
                          }
                        >
                          {event.type.startsWith('run.') ? (
                            <Terminal size={14} />
                          ) : (
                            <GitBranch size={14} />
                          )}
                        </span>
                        <div>
                          <b>{eventNames[event.type] ?? event.type}</b>
                          <span>
                            {typeof event.data.name === 'string'
                              ? event.data.name
                              : typeof event.data.title === 'string'
                                ? event.data.title
                                : event.runId
                                  ? 'Run ' + event.runId.slice(0, 8)
                                  : '事件 #' + event.id}
                          </span>
                        </div>
                        <time>{time(event.at)}</time>
                      </div>
                    ))
                ) : (
                  <div className="empty-small">创建一个任务，开始记录项目的每一步。</div>
                )}
              </section>
              <footer>
                TaskFlow · 本地工作流实验室<span>SQLite / SSE / 可追溯执行</span>
              </footer>
            </>
          )}
          {!project && !loading && (
            <div className="welcome">
              <FolderKanban size={42} />
              <h2>从一个项目开始</h2>
              <p>创建项目、拆解任务、连接依赖，然后启动一次真实执行。</p>
              <button className="button primary" onClick={() => setModal('project')}>
                <Plus size={16} />
                创建项目
              </button>
            </div>
          )}
        </div>
      </main>
      {modal && (
        <Modal title={modal === 'project' ? '新建项目' : '创建任务'} onClose={() => setModal(null)}>
          {modal === 'project' ? (
            <ProjectForm
              busy={busy}
              onSave={(data) =>
                void action(async () => {
                  const p = await api<Project>('/projects', 'POST', data);
                  setModal(null);
                  setProjectId(p.id);
                }, '项目已创建')
              }
            />
          ) : (
            <TaskForm
              tasks={allTasks}
              busy={busy}
              onSave={(data) =>
                void action(async () => {
                  await api('/projects/' + projectId + '/tasks', 'POST', data);
                  setModal(null);
                }, '任务已创建')
              }
            />
          )}
        </Modal>
      )}
      {selectedTask && (
        <div
          className="drawer-backdrop"
          onClick={() => {
            setSelectedTask('');
            setDetail(null);
          }}
        >
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="任务详情"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-top">
              <span>
                <FolderKanban size={17} />
                任务详情
              </span>
              <button
                className="icon-button"
                aria-label="关闭任务详情"
                onClick={() => {
                  setSelectedTask('');
                  setDetail(null);
                }}
              >
                <X size={20} />
              </button>
            </div>
            {detail ? (
              <>
                <div className="detail-heading">
                  <div className="detail-meta">
                    <Badge status={detail.task.status} />
                    <span className={'priority priority-' + detail.task.priority}>
                      {priorityNames[detail.task.priority]}
                    </span>
                    <span className="muted">v{detail.task.version}</span>
                  </div>
                  <h2>{detail.task.title}</h2>
                  <p>{detail.task.description || '暂无说明'}</p>
                  <div className="tags">
                    {detail.task.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                </div>
                <div className="detail-actions">
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !!project?.archived ||
                      detail.task.blockedBy.length > 0 ||
                      !['todo', 'in_progress'].includes(detail.task.status) ||
                      detail.runs.some((r) => ['queued', 'running'].includes(r.status))
                    }
                    onClick={() =>
                      void action(
                        () => api('/tasks/' + selectedTask + '/runs', 'POST', {}),
                        '已加入执行队列',
                      )
                    }
                  >
                    <Zap size={15} />
                    开始执行
                  </button>
                  <button
                    className="button"
                    disabled={
                      busy ||
                      !!project?.archived ||
                      detail.runs.some((r) => ['queued', 'running'].includes(r.status))
                    }
                    onClick={() => setEdit(!edit)}
                  >
                    编辑任务
                  </button>
                  <select
                    aria-label="更改任务状态"
                    disabled={busy || !!project?.archived}
                    value={detail.task.status}
                    onChange={(e) =>
                      void action(
                        () =>
                          api('/tasks/' + selectedTask, 'PATCH', {
                            version: detail.task.version,
                            status: e.target.value,
                          }),
                        '状态已更新',
                      )
                    }
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {statusNames[s]}
                      </option>
                    ))}
                  </select>
                </div>
                {edit && (
                  <div className="edit-panel">
                    <TaskForm
                      task={detail.task}
                      tasks={allTasks}
                      busy={busy}
                      onSave={(data) =>
                        void action(async () => {
                          const { dependencyIds, ...fields } = data;
                          let task = await api<Task>('/tasks/' + selectedTask, 'PATCH', {
                            ...fields,
                            version: detail.task.version,
                          });
                          if (
                            ['todo', 'canceled'].includes(task.status) &&
                            JSON.stringify([...dependencyIds].sort()) !==
                              JSON.stringify([...task.dependencyIds].sort())
                          )
                            task = await api<Task>(
                              '/tasks/' + selectedTask + '/dependencies',
                              'PUT',
                              { dependencyIds, version: task.version },
                            );
                          setEdit(false);
                        }, '任务已保存')
                      }
                    />
                    <p className="form-hint">
                      基本信息与依赖分步保存；如依赖校验失败，已保存的基本信息会保留。
                    </p>
                  </div>
                )}
                <section className="detail-section">
                  <h3>
                    <GitBranch size={16} />
                    前置依赖 <span>{detail.dependencies.length}</span>
                  </h3>
                  {detail.dependencies.map((t) => (
                    <button className="dependency-row" key={t.id} onClick={() => openTask(t)}>
                      <span>
                        {t.status === 'done' ? <CheckCircle2 size={15} /> : <Circle size={15} />}{' '}
                        {t.title}
                      </span>
                      <Badge status={t.status} />
                    </button>
                  ))}
                  {!detail.dependencies.length && <p className="muted">此任务可以独立执行。</p>}
                  {detail.task.blockedBy.length > 0 && (
                    <div className="blocked-note">
                      需要先完成：{detail.task.blockedBy.map((t) => t.title).join('、')}
                    </div>
                  )}
                  {detail.dependents.length > 0 && (
                    <p className="form-hint">
                      后继任务：{detail.dependents.map((t) => t.title).join('、')}
                    </p>
                  )}
                </section>
                <section className="detail-section">
                  <h3>
                    <Terminal size={16} />
                    执行记录 <span>{detail.runs.length}</span>
                  </h3>
                  {!detail.runs.length && (
                    <p className="muted">点击「开始执行」运行文本规范化、统计与校验流程。</p>
                  )}
                  {detail.runs.map((run) => (
                    <button
                      className={'run-row ' + (chosenRun?.id === run.id ? 'selected-run' : '')}
                      key={run.id}
                      onClick={() => setSelectedRun(run.id)}
                    >
                      <code>{run.id.slice(0, 8)}</code>
                      <Badge status={run.status} />
                      <span>
                        尝试 {run.attempt}/{run.maxAttempts}
                      </span>
                      <time>{time(run.createdAt)}</time>
                    </button>
                  ))}
                  {chosenRun && (
                    <div className="run-detail">
                      <div className="run-summary">
                        <span>Run {chosenRun.id.slice(0, 8)}</span>
                        {['queued', 'running'].includes(chosenRun.status) && (
                          <button
                            className="button small danger"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                () => api('/runs/' + chosenRun.id + '/cancel', 'POST', {}),
                                '执行已取消',
                              )
                            }
                          >
                            <Square size={12} />
                            取消执行
                          </button>
                        )}
                      </div>
                      <ol className="steps">
                        {chosenRun.steps.map((s, i) => (
                          <li key={i}>
                            {s.state === 'done' ? (
                              <CheckCircle2 size={15} />
                            ) : (
                              <LoaderCircle className="spin" size={15} />
                            )}
                            <span>{s.name}</span>
                            <time>{time(s.at)}</time>
                          </li>
                        ))}
                      </ol>
                      {chosenRun.error && <div className="blocked-note">{chosenRun.error}</div>}
                      {chosenRun.result && (
                        <>
                          <div className="result-stats">
                            <span>
                              字符 <b>{chosenRun.result.characters}</b>
                            </span>
                            <span>
                              空白分词 <b>{chosenRun.result.words}</b>
                            </span>
                          </div>
                          <pre>{JSON.stringify(chosenRun.result, null, 2)}</pre>
                        </>
                      )}
                    </div>
                  )}
                </section>
                <section className="detail-section">
                  <h3>
                    <Clock3 size={16} />
                    任务审计时间线
                  </h3>
                  {events
                    .filter((e) => e.taskId === selectedTask)
                    .reverse()
                    .slice(0, 20)
                    .map((e) => (
                      <div className="audit-row" key={e.id}>
                        <span className="audit-dot" />
                        <div>
                          <b>{eventNames[e.type] ?? e.type}</b>
                          <small>
                            #{e.id} · {time(e.at)} · {e.requestId.slice(0, 16)}
                          </small>
                        </div>
                      </div>
                    ))}
                </section>
                <div className="delete-area">
                  {deleting ? (
                    <>
                      <span>确认删除此任务？已有执行历史或被依赖的任务无法删除。</span>
                      <button
                        className="button small danger"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api(
                              '/tasks/' + selectedTask + '?version=' + detail.task.version,
                              'DELETE',
                            );
                            setSelectedTask('');
                            setDetail(null);
                          }, '任务已删除')
                        }
                      >
                        确认删除
                      </button>
                      <button className="button small" onClick={() => setDeleting(false)}>
                        保留
                      </button>
                    </>
                  ) : (
                    <button
                      className="button subtle danger"
                      disabled={!!project?.archived}
                      onClick={() => setDeleting(true)}
                    >
                      <Trash2 size={14} />
                      删除任务
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="loading">
                <LoaderCircle className="spin" />
                正在读取任务…
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  icon,
  accent = false,
}: {
  label: string;
  value: string;
  note: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={'metric ' + (accent ? 'accent-metric' : '')}>
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <strong>{value}</strong>
      <span>{note}</span>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const focusable = () => [
      ...ref.current!.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input,textarea,select,[tabindex="0"]',
      ),
    ];
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const nodes = focusable(),
          first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      before?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function ProjectForm({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (data: { name: string; description: string }) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        onSave({ name: String(data.get('name')), description: String(data.get('description')) });
      }}
    >
      <label>
        项目名称
        <input name="name" required maxLength={80} placeholder="例如：产品交付工作流" />
      </label>
      <label>
        项目说明
        <textarea name="description" rows={3} maxLength={2000} placeholder="这个项目要实现什么？" />
      </label>
      <button className="button primary full" disabled={busy} type="submit">
        {busy ? '正在创建…' : '创建项目'}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
type TaskFormData = {
  title: string;
  description: string;
  priority: Priority;
  tags: string[];
  dependencyIds: string[];
};
function TaskForm({
  task,
  tasks,
  busy,
  onSave,
}: {
  task?: Task;
  tasks: Task[];
  busy: boolean;
  onSave: (data: TaskFormData) => void;
}) {
  return (
    <form
      key={task?.id ?? 'new'}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        onSave({
          title: String(data.get('title')),
          description: String(data.get('description')),
          priority: data.get('priority') as Priority,
          tags: String(data.get('tags'))
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
          dependencyIds: data.getAll('dependencies').map(String),
        });
      }}
    >
      <label>
        任务标题
        <input
          name="title"
          required
          maxLength={160}
          defaultValue={task?.title}
          placeholder="写下一个具体、可验收的目标"
        />
      </label>
      <label>
        任务说明
        <textarea
          name="description"
          rows={4}
          maxLength={10000}
          defaultValue={task?.description}
          placeholder="执行器会对这段文本进行规范化、统计和 SHA-256 校验。"
        />
      </label>
      <div className="form-grid">
        <label>
          优先级
          <select name="priority" defaultValue={task?.priority ?? 'medium'}>
            {Object.entries(priorityNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          标签
          <input
            name="tags"
            defaultValue={task?.tags.join(', ')}
            placeholder="用逗号分隔，最多 8 个"
          />
        </label>
      </div>
      <fieldset disabled={!!task && !['todo', 'canceled'].includes(task.status)}>
        <legend>前置依赖</legend>
        <div className="dependency-options">
          {task?.dependencyIds
            .filter((id) => !tasks.some((t) => t.id === id))
            .map((id) => (
              <input key={id} type="hidden" name="dependencies" value={id} />
            ))}
          {tasks
            .filter((t) => t.id !== task?.id)
            .map((t) => (
              <label key={t.id} className="checkbox-label">
                <input
                  type="checkbox"
                  name="dependencies"
                  value={t.id}
                  defaultChecked={task?.dependencyIds.includes(t.id)}
                />
                <span>{t.title}</span>
                <Badge status={t.status} />
              </label>
            ))}
          {!tasks.length && <span className="muted">暂无可选任务，可以先独立创建。</span>}
        </div>
        <p className="form-hint">最多展示最近 100 个任务；禁止跨项目和循环依赖。</p>
      </fieldset>
      <button className="button primary full" disabled={busy} type="submit">
        {busy ? '正在保存…' : task ? '保存修改' : '创建任务'}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
