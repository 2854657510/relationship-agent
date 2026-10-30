# 验证记录

只记录实际跑过的命令和结果；没跑的写“未执行”，不写“应该可以”。

## P1 / 2026-10-30

### 通过

| 检查 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `npm install` | 321 packages，无致命错误 |
| 单元测试 | `npm test` | 2 passed（health 200 / DB down 503，假 DB 注入） |
| 类型检查 | `npm run typecheck` | server + web 均通过 |
| Web 构建 | `npm run build` | Vite 构建成功，145 KB JS |
| 忽略规则 | `git check-ignore` | `.env`、`node_modules/`、`web/dist/` 均被忽略 |
| 启动数据库 | `docker compose up -d --wait` | `relationship-agent-db` healthy，5432 映射成功 |
| 迁移 | `npm run db:migrate` | 17 个迁移全部应用 |
| 迁移幂等 | `npm run db:migrate`（第二次） | 17 个全部跳过，新应用 0 个 |
| Seed | `npm run db:seed` | contacts=3 facts=14 events=2 memories=1 |
| Seed 幂等 | `npm run db:seed`（第二次） | 仍是 3 / 14 / 2 / 1 |
| 数据库集成测试 | `npm run test:db` | 5 passed（表、迁移、seed、截图过期、唯一 active 文档） |
| 健康检查（直连） | `GET http://127.0.0.1:8787/api/health` | `200 {"status":"ok","db":"ok","version":"p1"}` |
| Web 首页 | `GET http://localhost:5173/` | 200，返回 Vite HTML |
| Vite 代理 | `GET http://localhost:5173/api/health` | 200，同上 JSON |

> 当前 `npm run dev` 仍在运行：server `127.0.0.1:8787`，web `localhost:5173`。

### 环境备注

1. 第一次 Docker Desktop 起不来：WSL 报 `ERROR_NO_SYSTEM_RESOURCES`，当时只有 4.0 GB 可用内存。释放到 8.6 GB 后重启成功。
2. Docker Hub 首次拉取超时（`registry-1.docker.io` 不可达）。用 DaoCloud 镜像绕过：

```bash
docker pull docker.m.daocloud.io/library/postgres:16-alpine
docker tag docker.m.daocloud.io/library/postgres:16-alpine postgres:16-alpine
docker compose up -d --wait
```

### 未执行

| 检查 | 原因 |
|---|---|
| 浏览器点击级端到端 | P1 只验证 HTTP 200；P7 做完整 UI 与 Playwright/手工 E2E |
| `docker compose down` 全周期 | 只验证了 up；down/up 留到 P2 前回归 |
| DeepSeek 真实模型调用 | P2 才接 Pi Agent |

---

## P2–P8 / 2026-10-30

> P4 新增 `018_thread_compaction_cutoff.sql`，当前共 18 个迁移。

### 通过

| 检查 | 命令 / 方式 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | 2 passed |
| 数据库测试 | `npm run test:db` | 8 passed（表、迁移、seed、约束、压缩、快照隔离、过期清理） |
| 类型检查 | `npm run typecheck` | server + web 通过 |
| Web 构建 | `npm run build` | 34 modules，164 KB JS |
| 40 条评测 | `npx tsx evals/run.ts` | 稳定 40/40；单次 120/120；模拟一致率 97.5% |
| 真实 DeepSeek 调用 | 浏览器 / API | 档案查询、日程空档、问卷追问、Action 提案、确认回执、联网授权恢复均跑通 |
| UI 端到端 | Edge headless（Playwright Core） | 3 个联系人、张三 active 文档、发送消息后 assistant 回复包含张三信息 |
| Docker | `docker compose ps` | `relationship-agent-db` healthy |

### 关键实测

- 问卷暂停 → `POST /questionnaires/:id/answer` → 新 run 继续 → `propose_action`。
- `create_event` 确认后写 `calendar_events` + `action_receipts`，Insight 返回 `ok`。
- `fetch_public_url` 在 `ask` 模式暂停，授权后恢复并成功读取 example.com。
- 伪造 `ev_fake` 的洞察被整条丢弃；`memoryDraft` 伪造来源时洞察和草案一起回滚。
- `baseVersion` 不匹配时 confirm 返回 409，Action 置 `conflict`，联系人未被覆盖。
- 重复 confirm 返回同一个 receipt。

### 未执行

| 检查 | 原因 |
|---|---|
| live 模式评测（真实模型 × 40 × 3） | 默认 mock 控制成本；live 只做了单条手工验证 |
| 多用户 / 鉴权 | 非目标，本地单用户 |
| 真实 iOS Contacts / EventKit | 非目标，Web 替代 |
| 生产部署 / 压测 | 非目标 |

### 环境备注

- 模型：DeepSeek `deepseek-flash`（pi-ai 1.4.0 catalog）。
- Docker Hub 不可达时用 DaoCloud 镜像，命令见 README。
- 评测使用 `relationship_test`，会重置该库；开发库不受影响。
