# API

默认根地址 `http://127.0.0.1:8787/api`。所有时间为 ISO 8601；资源 ID 为 UUID，事件 ID 为递增整数。写入使用 JSON。

错误结构：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "任务已被其他操作更新，请刷新后重试",
    "requestId": "uuid",
    "details": { "currentVersion": 2 }
  }
}
```

## 接口表

| 方法               | 路径                    | 说明                                                                  |
| ------------------ | ----------------------- | --------------------------------------------------------------------- |
| GET                | /health                 | SQLite / 执行并发健康状态                                             |
| GET, POST          | /projects               | 项目列表 / 创建                                                       |
| GET, PATCH         | /projects/:id           | 项目详情 / 更新名称、描述、archived                                   |
| GET, POST          | /projects/:id/tasks     | 任务分页 / 创建                                                       |
| GET, PATCH, DELETE | /tasks/:id              | 详情、编辑、删除                                                      |
| PUT                | /tasks/:id/dependencies | 替换前置集合                                                          |
| POST               | /tasks/:id/runs         | 创建 Run                                                              |
| GET                | /runs                   | 最近 100 次执行，可传 projectId 或 taskId；两者同时传入时 taskId 优先 |
| GET                | /runs/:id               | 执行详情                                                              |
| POST               | /runs/:id/cancel        | 取消 queued/running Run                                               |
| GET                | /events                 | 正序审计分页                                                          |
| GET                | /events/stream          | SSE 回放与实时事件                                                    |

任务分页参数：page（默认 1）、pageSize（1—100，默认 30）、q、status、priority、tag。按 createdAt DESC、id DESC 稳定排序。返回 `{items,total,page,pageSize}`。

创建任务：`{title,description?,priority?,tags?,dependencyIds?}`；title 必填；priority 为 low/medium/high；tags 最多 8 个，单项最多 30 字符；前置依赖最多 50 个。

任务编辑：`{version,title?,description?,priority?,tags?,status?}`。版本必填，至少一个修改字段。依赖编辑：`{version,dependencyIds}`。删除：`DELETE /tasks/:id?version=1`。

状态迁移：todo → in_progress/done/canceled；in_progress → todo/done/canceled；done/canceled → todo。依赖和活跃 Run 会增加限制。带执行历史的任务不可删除，推荐取消以保留审计。

创建 Run：`{maxAttempts?: 1..5}`，默认 3。项目未归档、任务为 todo/in_progress、前置全部 done、没有活跃 Run 时允许。

幂等键：任务创建和 Run 创建可传 `Idempotency-Key`，1—128 位可见 ASCII 字符。同键同体返回首次资源响应；同键异体返回 409。键按项目/任务及端点隔离。

## 可复制示例

先创建项目：

```sh
curl -s http://127.0.0.1:8787/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"我的工作流","description":"本地验收项目"}'
```

将返回的 ID 填入 `PROJECT_ID`：

```sh
curl -s http://127.0.0.1:8787/api/projects/PROJECT_ID/tasks \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-task-001' \
  -d '{"title":"处理文本","description":"  Hello   TaskFlow  ","priority":"high","tags":["演示"]}'
```

将返回的 ID 填入 `TASK_ID`，启动执行：

```sh
curl -s http://127.0.0.1:8787/api/tasks/TASK_ID/runs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-run-001' \
  -d '{"maxAttempts":3}'
```

SSE 续传与审计：

```sh
curl -N http://127.0.0.1:8787/api/events/stream -H 'Last-Event-ID: 0'
curl -s 'http://127.0.0.1:8787/api/events?after=0&limit=200'
```

事件参数：after 非负整数、projectId 可选、limit 1—1000（默认 200）。HTTP 查询持续把最后一个事件 ID 作为 after 即可向前分页。SSE 忽略 limit 的分页截断，持续补收并发送新事件。示例：

```text
id: 7
event: change
data: {"id":7,"type":"run.started",...}
```

404 为资源不存在；400 为校验/JSON 错误；409 为版本、依赖、状态、幂等或活跃执行冲突；403 为本地来源限制；413 为请求过大。
