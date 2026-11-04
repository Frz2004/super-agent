# opencode-superagent（原生 agent 版）

这是一个**不新增常驻服务**的 opencode 原生 superagent。它由三部分组成：

- `superagent` 主 agent：把一次请求变成一张 ticket，拆成任务，派发给 worker，最后核对证据并汇报。
- `superagent-worker` 子 agent：只执行一个任务，返回改动、文件和实际运行的检查结果。
- `/superagent` 命令 + 本地 ticket CLI：让主 agent 持久化记录 ticket、任务和进度。

它适合“我在 opencode 里发一个请求，希望它自己拆活、派活、验证，而不是把所有上下文塞进一个会话”的场景。它**不监听** GitHub 或飞书，也**不会**在没人发起会话时自动接单；这些能力需要另外的常驻服务设计。

## 组成

| 路径                                   | 作用                                                             |
| -------------------------------------- | ---------------------------------------------------------------- |
| `.opencode/agent/superagent.md`        | 主 agent 的系统提示词，定义工单、派发、验证和交付流程            |
| `.opencode/agent/superagent-worker.md` | worker 子 agent 的系统提示词                                     |
| `.opencode/command/superagent.md`      | `/superagent <请求>` 命令                                        |
| `opencode-superagent/tickets.mjs`      | 本地 ticket CLI，状态保存在 `.data/opencode-superagent/tickets/` |
| `opencode-superagent/tickets.test.mjs` | ticket CLI 的测试                                                |
| `opencode-superagent/bundle.test.mjs`  | agent/command frontmatter 与关键契约的测试                       |

ticket 状态默认不提交：`.data/opencode-superagent/tickets/` 位于已忽略的 `.data/` 下。它是本机工作状态，不是仓库内容。

## 使用

在仓库根目录启动 opencode（需要 opencode v2；本仓库的 `.opencode/agent` 和 `.opencode/command` 会被自动发现），然后：

```text
/superagent 给任务列表增加一个按标签筛选的接口，并补测试
```

或者手动选择 `superagent` agent，再输入请求。

主 agent 会：

1. 阅读 `AGENTS.md`、README 和相关代码，写清验收标准；
2. 创建 ticket，例如 `sa-20261104-a1b2c3`；
3. 把工作拆成 2–6 个任务，按依赖排序；
4. 对上下文重的任务调用 `subagent`（`agent: superagent-worker`），对简单任务直接处理；
5. 检查 worker 的 diff、运行检查、更新任务状态；
6. 汇总 ticket id、改动、实际运行的检查和未完成项。

它**只有**在请求明确要求时才创建分支和 Draft PR。默认只改工作区，不提交、不推送。

## ticket CLI

```sh
node opencode-superagent/tickets.mjs create --title "..." --request "..." \
  --acceptance "可观察的验收标准" --acceptance "另一条"
node opencode-superagent/tickets.mjs claim <ticket-id>
node opencode-superagent/tickets.mjs task add <ticket-id> --title "..." --details "文件、验收、检查"
node opencode-superagent/tickets.mjs task update <ticket-id> <task-id> --status done --notes "tests: ..."
node opencode-superagent/tickets.mjs task list <ticket-id>
node opencode-superagent/tickets.mjs list
node opencode-superagent/tickets.mjs get <ticket-id>
node opencode-superagent/tickets.mjs complete <ticket-id> --summary "..."
node opencode-superagent/tickets.mjs fail <ticket-id> --reason "..."
```

状态：

- ticket：`todo`、`in_progress`、`blocked`、`done`、`dropped`
- task：`todo`、`in_progress`、`done`、`failed`

所有写操作都是临时文件加原子 rename；ticket id 和 task id 都会校验，避免路径穿越。可以用 `--root <dir>` 或 `OPENCODE_SUPERAGENT_STATE` 改变状态目录。

## 验证

```sh
npm run test:superagent
```

该命令只测试 ticket CLI（创建、列表、更新、任务、状态、错误处理）。agent 提示词本身不启动模型，因此不会消耗 API 额度。

完整仓库检查仍然使用：

```sh
npm run check
```

`check` 已包含 `test:superagent`。

## 设计边界

这是 B 方案（opencode 原生 agent/plugin），不是 A 方案的常驻服务：

- **没有事件源**：不会轮询 GitHub Issue、PR 评论或飞书消息，也不会自动创建 ticket。
- **没有守护进程**：opencode 会话结束，工作就停止；ticket 文件留在本机。
- **没有独立 worktree**：worker 和主 agent 共享同一个工作区，所以主 agent 必须串行处理会改同一批文件的任务；并行只适合只读调研。
- **没有 web 面板**：进度通过 ticket CLI、opencode 会话和最终汇报查看。
- **提示词面向 opencode v2**：v2 的子 agent 工具叫 `subagent`；v1 使用 `task`，前端字段也不同。若要在 v1 使用，需要改提示词和 agent frontmatter。

## 安全

- agent 会在你的机器上读写文件、运行命令；请只在受信任的仓库和分支使用。
- 不要把密钥、`.env`、私有聊天内容交给 worker；提示词明确禁止外泄，但这只是行为约束，不是沙箱。
- 子 agent 共享工作区，不会提供操作系统级隔离。
- 自动生成的 GitHub 评论和 PR 描述都以 `This is by an automated agent, not a human.` 开头；不要把 agent 的输出当作人工确认。
- 不要在没有人工复核的情况下合并 agent 创建的 PR。

## 与 TaskFlow 的关系

TaskFlow 仍然是本仓库的主应用，未修改其 API、数据库或执行器。`opencode-superagent/` 是一个独立的可选 agent bundle；它不参与 `npm run dev` / `npm start`，也不改变 TaskFlow 的“不执行任务描述”的边界。

如果之后需要 A 方案的完整能力（GitHub/飞书触发、常驻队列、每 ticket 独立 worktree、面板），应作为独立任务重新设计，而不是在这个 bundle 上偷偷扩成服务。
