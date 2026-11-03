# TaskFlow · 本地工作流实验室

一个可以直接运行、继续开发的全栈任务工作台，也是 DeepSeek Harness Superagent 的代码任务验收仓库。支持项目管理、依赖任务、持久化后台执行、实时事件和可追溯审计。

## 快速开始

需要 **Node.js 24 或更高版本**、npm。建议使用 `.nvmrc` 指定的 Node 24。

```sh
npm ci
npm run seed
npm run dev
```

开发界面：<http://127.0.0.1:5173>；API：<http://127.0.0.1:8787/api/health>。

生产构建与本地启动：

```sh
npm run build
npm start
```

打开 <http://127.0.0.1:8787>。生产模式由同一 Node 进程提供静态页面和 API。数据默认保存在 `.data/taskflow.sqlite`，重启后保留；仓库不会上传数据库或个人测试数据。空数据库会自动建表，`npm run seed` 只在没有项目时填充演示数据。

可通过进程环境变量配置：

```sh
PORT=3187 TASKFLOW_DB=.data/demo.sqlite TASKFLOW_CONCURRENCY=2 npm start
```

`.env.example` 只记录变量示例，应用不自动加载 `.env`。

## 已实现的功能

- 中文响应式任务看板、项目创建/修改/归档、任务增删改查。
- 状态与优先级筛选、关键词搜索、稳定分页、标签数据与 API 筛选。
- 同项目依赖、自依赖/重复依赖/循环检测及冲突路径。
- 前置任务未完成时阻止后继执行；已开始的后继可保护已完成的前置条件。
- 乐观锁版本号、创建任务及执行的幂等键、关键变更事务与审计。
- SQLite 持久化队列、1—8 并发配置、有限重试、取消和重启恢复。
- 真实文本执行：Unicode NFKC 规范化、空白分词、字符统计、SHA-256 校验。
- Run 步骤、错误、结果和历史；SSE 实时更新及 Last-Event-ID 续传。
- 单元/数据库/HTTP/队列/SSE 测试、真实 Chromium 端到端测试、GitHub Actions。

任务描述是文本执行器的输入，不会被当作代码或 shell 命令执行。中文字符计数使用 Unicode code point 数；“空白分词”按空白拆分，并非中文分词模型。

## 体验一次完整流程

1. 执行 `npm run seed`，打开「Superagent 实验室」。
2. 「端到端交付验收」依赖两个前置任务，最初无法开始执行。
3. 打开「构建持久化执行流程」并开始执行，观察三个步骤及结果。
4. 执行「完善中文任务工作台」，两个前置完成后，验收任务解除阻塞。
5. 执行验收任务，在详情里查看执行结果和关联审计记录。
6. 刷新页面或重启服务，数据仍然保留。

这里执行的是确定性的文本流程；种子任务名称用于展示依赖关系，不会自动实现其文字描述中的功能。

## 验证

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

`npm run check` 汇总类型检查、核心测试及构建。浏览器测试前需先构建；测试启动独立服务（8798）并使用临时数据库，不会修改 `.data` 中的演示数据。

详细内容见 [验收报告](docs/VALIDATION.md)、[架构说明](docs/ARCHITECTURE.md)、[API](docs/API.md) 和 [后续路线图](docs/ROADMAP.md)。

## 交给 Superagent 继续完善

下一轮任务已经写在 [SUPERAGENT_NEXT_TASK.md](docs/SUPERAGENT_NEXT_TASK.md)。在飞书私聊机器人发送：

```text
请在 Frz2004/super-agent 仓库中执行 docs/SUPERAGENT_NEXT_TASK.md 定义的 TaskFlow 第二阶段任务。先读取 AGENTS.md、README.md 和架构说明，在独立 agent/ 分支完成实现和测试，推送后创建 Draft PR，不要合并。在当前飞书话题回复真实测试结果、提交 SHA、PR 链接及对应工单/Worker Session。
```

### 提交任务

使用已授权的 GitHub 账号 `FBI-6`，在本仓库的 Issue 或新评论中 `@Frz2004`，写明目标、范围和验收标准；也可以通过已经配置的飞书机器人私聊发起。

每个后续任务使用独立的 `agent/` 分支和 worktree，明确要求时创建 Draft PR，由人检查后决定是否合并。报告实际执行的检查和未完成事项。

## 当前边界

本项目适合本机单用户运行。只绑定回环地址，检查 Host 与 Origin；没有用户登录、角色权限、TLS、多实例租约或公网部署支持。不要直接暴露到公网。

运行恢复策略：已有 queued 作业继续调度；遗留 running 作业标记为 failed 并恢复任务为 todo，用户可显式重新执行。重试仅针对执行器标记的暂时错误；不承诺 exactly-once。当前文本执行器默认不会主动制造重试错误，失败/重试/竞态通过隔离的测试执行器验证。

界面概览和依赖选择暂时读取最近 100 个任务；活动面板读取最早 1000 条项目事件后倒序显示，并非无限历史下的全量统计/最新活动。API 支持事件向前游标分页和 SSE 全量续传。解决这些限制是下一阶段的明确任务。
