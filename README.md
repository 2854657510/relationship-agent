# Relationship Agent

人际关系管家 Agent 的同构复现：**TypeScript + Pi Agent + PostgreSQL + React**。

> 按公开设计文档重写，不是原项目源码。**第一次启动看 [START_HERE.md](./START_HERE.md)（[PowerShell 版](./START_HERE_POWERSHELL.md)）**。设计边界见 [SPEC.md](./SPEC.md)，实现细节见 [AGENT_DESIGN.md](./AGENT_DESIGN.md)。

## 已实现

- **主 Agent**：Pi Agent loop、DeepSeek `deepseek-flash`、工具调用、预算、SSE 流。
- **证据优先**：文字/截图先入库；截图 24h 后删原图、留摘要。
- **MemorySnapshot**：按联系人组装配事实、候选、冲突、目标、洞察、长期文档、Action。
- **结构化追问**：`questionnaire` 暂停，回答后恢复同一任务。
- **Action Card**：创建/更新/合并联系人，创建/修改/删除日程；未确认零写入。
- **回执与并发**：receipt、requestId 幂等、confirm 幂等、`baseVersion` CAS。
- **长期记忆**：候选记忆确认、文档草案与版本、批准时 CAS。
- **压缩恢复**：40k tokens / 40 条消息触发摘要，`compaction_until_seq` 防重复压缩。
- **Insight Agent**：回执后复盘，`ev_/act_/msg_` 来源校验，失败不回滚 Action。
- **评测**：40 条用例 × 3 复跑，faux provider，模拟校准报告。
- **Web**：聊天、Action、问卷、联网授权、记忆审核、联系人。

## 界面

![Relationship Agent UI](docs/screenshots/ui.png)

## 前置

- Node.js 22+
- Docker Desktop（要启动）
- DeepSeek key 放在系统环境变量 `DEEPSEEK_API_KEY`（不要写进 `.env`）

## 启动

```bash
npm install
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

打开：

- Web：<http://localhost:5173>
- 健康检查：<http://127.0.0.1:8787/api/health>

健康检查：

```json
{ "status": "ok", "db": "ok", "version": "p8", "time": "..." }
```

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 同时起 server（8787）和 web（5173） |
| `npm run dev:server` | 只起服务端 |
| `npm run dev:web` | 只起 Vite |
| `npm run db:migrate` | 应用 18 个迁移，已应用的跳过 |
| `npm run db:seed` | 3 联系人 / 14 事实 / 2 日程 / 1 记忆 |
| `npm test` | 单元测试（不连库） |
| `npm run test:db` | 数据库集成测试（会重置测试库） |
| `npm run eval` | 40 条评测 × 3 复跑，写 `evals/runs/` |
| `npm run typecheck` | server + web 类型检查 |
| `npm run build` | 构建 Web |

重置开发库（**会删 public schema**，只用于本地）：

```bash
npm run db:migrate --workspace @relationship-agent/server -- --reset
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/threads` | 新建会话 |
| GET | `/api/threads/:id` | 会话 + 最近消息 + 待处理项 |
| POST | `/api/threads/:id/messages` | 发消息，立即返回 runId |
| GET | `/api/runs/:id` | run 状态 + 事件 + 待处理项 |
| GET | `/api/runs/:id/events` | SSE；支持 `?after=seq` 回放 |
| POST | `/api/questionnaires/:id/answer` | 回答问卷并恢复 |
| POST | `/api/permissions/:id/decide` | 允许/拒绝联网并恢复 |
| GET | `/api/actions/:id` | Action + receipt |
| POST | `/api/actions/:id/confirm` | 执行 + receipt + insight |
| POST | `/api/actions/:id/reject` | 拒绝 |
| GET | `/api/contacts` | 联系人列表 |
| GET | `/api/contacts/:id` | 联系人快照 |
| GET | `/api/contacts/:id/memory` | 候选/已确认/文档草案/active |
| POST | `/api/contacts/:id/memory-drafts` | 生成长期文档草案 |
| POST | `/api/memory-drafts/:id/approve` | 批准（CAS） |
| POST | `/api/memory-drafts/:id/reject` | 驳回 |
| POST | `/api/memory-items/:id/confirm` | 确认候选记忆 |
| POST | `/api/memory-items/:id/reject` | 拒绝候选记忆 |
| GET | `/api/evidence/:id` | 取未过期截图；过期 410 |

SSE 事件：`run_started`、`message_delta`、`tool_started`、`tool_finished`、`questionnaire`、`permission_request`、`action_proposed`、`run_completed`、`error`。

## 评测

```bash
npm run eval
```

输出：`evals/runs/<timestamp>/report.json`、`report.md`、`traces/*.json`。

当前结果：

- 40 条用例，每条 3 次复跑，共 120 run。
- 稳定通过 40/40，单次通过 120/120。
- `calibration: "simulated"`，模拟一致率 97.5%——这只是校准管线，不是人工一致率。

## 数据库

- 开发库：`postgres://relationship:relationship@localhost:5432/relationship`
- 测试库：`relationship_test`，由 `docker/init/01-test-db.sql` 首次初始化。
- 18 个迁移，`017_text_memory_documents.sql` 保留原项目文件名。

## 目录

```text
server/
  migrations/            18 个 SQL 迁移
  src/agent-service.ts   一轮请求编排
  src/agent.ts           Pi Agent + DeepSeek
  src/agent-safety.ts    预算
  src/conversation-context.ts 消息/压缩
  src/domain.ts          领域协议
  src/memory/snapshot.ts MemorySnapshot
  src/text-memory.ts     记忆/文档/CAS
  src/insight-agent.ts   行动后洞察
  src/action-service.ts  Action 执行
  src/adapters/          联系人/日历
  src/tools/             13 个工具
  src/http/              路由/SSE
web/src/                 React UI
evals/                   40 条用例与 runner
```

## 故障排查

- **Docker 连不上**：先启动 Docker Desktop。WSL 报 `ERROR_NO_SYSTEM_RESOURCES` 是内存不够，关掉占内存的应用或重启后再试。
- **拉不到 `postgres:16-alpine`**（Docker Hub 超时）：

  ```bash
  docker pull docker.m.daocloud.io/library/postgres:16-alpine
  docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine
  docker compose up -d --wait
  ```

- **端口 5432 被占用**：改 `compose.yaml` 的宿主端口，并同步改 `.env` 的 `DATABASE_URL`。
- **`DEEPSEEK_API_KEY` 没读到**：确认启动服务的同一个 shell/系统环境里有这个变量。
- **评测报测试库不存在**：`docker compose down -v` 后重新 `up`，init 脚本会建 `relationship_test`（会删开发数据，确认后再做）。

## 说明

- `.env`、`data/`、`evals/runs/`、`node_modules/` 不入库。
- 不配远程、不 push。
- 当前限制：Insight 同步执行、无 scheduler、无真实 EventKit/Contacts、评测默认 mock。
