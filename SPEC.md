# Relationship Agent 同构复现设计（SPEC）

> 状态：已实现（P8，2026-10-30）
> 日期：2026-10-30
> 范围：方案 A —— 服务端 + 最小 Web 端
> 模型：DeepSeek `deepseek-flash`（text+image）
> 性质：独立重写，不是原项目源码的复制
>
> 公开仓库只包含生产版；学习版、面试题库和 4 周学习计划为本地私有内容，不随仓库发布。

---

## 0. 一句话

在 Windows 上用 **TypeScript + Pi Agent + PostgreSQL + React** 复现一套“人际关系管家”：用户发文字/截图，Agent 先存证据、再读记忆、缺信息就结构化追问，涉及联系人和日历的修改一律生成 Action Card，用户确认后才执行；执行后由独立 Insight Agent 做复盘，产出可溯源的洞察和待审核的长期记忆。

---

## 1. 背景与目标

### 1.1 材料

- 16 页原始设计文档中的 7 页截图（1/2/3/6/9/10/11 页），右侧有裁切。
- 1 份 4 句话的视频转写稿。
- 3 张 VS Code 截图：目录结构、`AGENTS.md`、`AppPreferencesTests.swift`。
- 未找到公开源码仓库；GitHub 代码搜索 `RelationshipAgent.xcodeproj`、`record_candidate_memory`、`agent honeycomb` 等特征串均无对应结果。

### 1.2 原项目的四个技术方向

1. 主 Agent 执行链路：Pi Agent loop、tool calling、工具权限、运行预算。
2. 信息不完整时的 questionnaire 结构化追问 + Action Card 确认执行。
3. 长期记忆：MemorySnapshot、证据溯源、Pi 原生 compaction、版本控制。
4. 独立 Insight Agent + 40 条核心评测用例。

### 1.3 复现目标

- 四个方向都能在代码里找到对应实现，并能演示。
- Windows 本机一条命令起服务，一条命令起 Web，端到端可用。
- 关键安全性质可验证：**未确认零写入、证据可溯源、跨人物不泄漏、旧版本不被覆盖**。
- 40 条评测用例可重复运行，输出稳定通过率与单次通过率。
- 项目用 Git 管理，按阶段提交；`.env`、截图、报告不入库。
- 交付两份：`relationship-agent`（生产注释）和 `relationship-agent-learning`（桌面学习版，复杂处有中文注释 + 学习文档）。
- 配一份可执行的 4 周学习计划，学完能通过模拟面试。

### 1.4 成功标准

1. `docker compose up -d` + `npm run db:migrate` + `npm run seed` + `npm run dev` 后，浏览器能完成一轮“输入 → 追问/提案 → 确认 → 回执 → 洞察 → 记忆审核”。
2. 未确认的 Action 执行次数为 0。
3. 并发更新同一条记忆文档时，旧版本写入被拒绝（409）。
4. `npm run eval` 跑完 40 条 mock 用例并生成报告。
5. `README.md` 能让第三人在 Windows 上从零复现。
6. `git log` 能看到 P1–P8 的阶段提交；`git status` 干净。
7. 桌面学习版能独立启动，7 个核心文件有逐段中文注释。
8. 学习计划的 10 个实验全部跑过，面试题库能脱稿讲 15 题以上。

---

## 2. 复现边界

| 类别 | 内容 |
|---|---|
| 原文档确认 | 主 Agent 链路、工具分类与约束、questionnaire/action proposal 终态、MemorySnapshot 组成、记忆分层、Insight 触发与失败边界、评测三层结构、7 个服务端文件名 |
| 截图确认 | iOS SwiftUI 工程、`AppShell/Data/Features/Resources/System`、`AppPreferencesTests`、`AgentToolAccessMode`、中英双语、fixture/remote 双 BackendClient |
| 本设计决定 | 数据库表结构、HTTP API、工具 JSON schema、prompt、Web UI、mock 模型、评测用例正文、17 个迁移文件 |
| 原项目未知 | 原 prompt 原文、原 DB schema、原 API 路径、原 40 条用例正文、原 UI 细节、原模型提供商 |
| 明确不复现 | iOS 客户端、EventKit/Contacts 真机写入、Apple 账号体系、原项目品牌与文案 |

**结论**：交付“同构版”。行为对齐文档，接口和数据结构是本设计自己的。

---

## 3. 非目标与反目标

### 非目标

- 不做 iOS App；Web 端替代。
- 不做多用户、登录、权限系统；本地单用户 `local-user`。
- 不做真实 Apple 通讯录/日历同步；服务端用本地表 + Adapter 模拟设备回执。
- 不做生产级部署、监控、限流。
- 不做像素级 UI 还原。
- 不追求与原项目 prompt/用例逐字一致。

### 反目标（出现即视为失败）

- 模型可以直接改联系人/日历，绕过 Action Card。
- 不同联系人的记忆进入同一个快照。
- Insight 引用不存在的 evidence 或伪造 sourceID。
- 旧记忆/旧文档覆盖新版本。
- 评测把 LLM Judge 自评当作人工一致率。
- 把“模拟校准”写成“人工一致率”；模拟数据必须标注 `calibration: simulated`。
- 注释只复述代码“做了什么”，不写“为什么这么做、失败会怎样”。
- 截图过期后仍被当作可读原图使用。

---

## 4. 约束

- 开发机：Windows 10，Docker Desktop，Node.js 22+，npm。
- 无 Xcode，因此不编译 Swift。
- 服务端：TypeScript strict、ESM、Fastify 5、PostgreSQL 16、Drizzle 不引入，使用 `pg` + 原生 SQL 迁移。
- Agent：`@earendil-works/pi-agent-core@1.4.0`、`@earendil-works/pi-ai@1.4.0`，**锁定精确版本**。
- 模型：DeepSeek `deepseek-flash`（V4.1 Flash，支持 text+image，1M context），通过 `DEEPSEEK_API_KEY` 读取系统环境变量；不在 `.env` 里重复写 key。
- Web：React 18 + Vite + TypeScript，纯 CSS，不引入 UI 框架；只做中文。
- 测试：Vitest；集成测试用独立 `TEST_DATABASE_URL`。
- 代码注释用中文；变量/函数 camelCase，类型 PascalCase。
- 注释分两层：生产版只写“为什么/边界/坑”；学习版在 7 个核心文件里加 `// 学习注:` 逐段解释。生产版不塞教学废话。
- 不写死密钥；全部走 `.env` 或系统环境变量。
- 不自动格式化整个文件；只格式改动行。
- 单次请求最多 4 张图；单张解码后 ≤ 8MB；只接受 `image/jpeg|png|webp`。
- Git：`main` 分支按阶段提交；不配置远程、不 push，除非你明确要求。
- 学习版：`C:\path\to\relationship-agent-learning`，从主仓库导出，独立可运行。

---

## 5. 方案取舍

| 方案 | 内容 | 取舍 | 结论 |
|---|---|---|---|
| **A. 服务端 + 最小 Web** | TS + Pi + Postgres + React | Windows 可完整跑通；覆盖四个方向；不含 iOS | **已选** |
| B. A + SwiftUI 源码 | 补 `RelationshipAgent.xcodeproj` | 最接近原项目；无 Mac 无法编译验证，工作量翻倍 | 放弃 |
| C. 纯 Python 重写 | FastAPI + 自写 loop | 贴合用户主力语言；失去 Pi 的 loop/compaction/权限钩子，工作量更大 | 放弃 |

选 A 的理由：复现的重点是 Agent 机制，不是 iOS 外壳；Web 端足以演示追问、Action Card、记忆审核和 SSE 轨迹。

---

## 6. 总体架构

```
┌──────────────┐      HTTP/SSE       ┌──────────────────────────────┐
│  web (React) │ ──────────────────▶ │  Fastify (server/src/index.ts)│
└──────────────┘                     └──────────────┬───────────────┘
                                                    │
                                     ┌──────────────▼───────────────┐
                                     │ agent-service.ts             │
                                     │ 单次请求编排 / 幂等 / 恢复    │
                                     └──┬───────────┬───────────┬───┘
                                        │           │           │
                          ┌─────────────▼──┐  ┌─────▼──────┐  ┌─▼─────────────┐
                          │ agent.ts       │  │ domain.ts  │  │ conversation- │
                          │ 主 Agent/工具  │  │ 领域/装配  │  │ context.ts    │
                          └──┬─────────────┘  └─────┬──────┘  └─┬─────────────┘
                             │                      │           │
                    ┌────────▼────────┐   ┌─────────▼──────┐    │
                    │ Pi Agent loop   │   │ text-memory.ts │    │
                    │ beforeToolCall  │   │ 记忆/版本      │    │
                    └────────┬────────┘   └─────────┬──────┘    │
                             │                      │           │
        ┌────────────────────▼──────────────────────▼───────────▼─────┐
        │ PostgreSQL（业务表） + 本地 evidence 文件（截图 24h）        │
        └──────────────────────────────────────────────────────────────┘
                             │
                    ┌────────▼─────────┐
                    │ insight-agent.ts │  receipt 后同步评估
                    └──────────────────┘
```

---

## 7. 目录结构

```text
relationship-agent/
├─ compose.yaml
├─ .env.example
├─ package.json                      # npm workspaces: server, web
├─ SPEC.md
├─ README.md
├─ AGENT_DESIGN.md
├─ VERIFICATION.md
├─ server/
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ migrations/                    # 见第 9 节，共 17 个
│  │  ├─ 001_extensions.sql
│  │  ├─ ...
│  │  └─ 017_text_memory_documents.sql
│  ├─ src/
│  │  ├─ index.ts                    # Fastify 入口 + 静态 Web
│  │  ├─ config.ts                   # env 解析
│  │  ├─ agent-service.ts            # 单次请求编排（保留原名）
│  │  ├─ agent.ts                    # 主 Agent、prompt、工具注册（保留原名）
│  │  ├─ agent-safety.ts             # 预算、权限、循环上限（保留原名）
│  │  ├─ insight-agent.ts            # 行动后洞察（保留原名）
│  │  ├─ domain.ts                   # 领域类型、Action/receipt/memory 装配（保留原名）
│  │  ├─ text-memory.ts              # 记忆项/文档/版本（保留原名）
│  │  ├─ conversation-context.ts     # 会话恢复与压缩（保留原名）
│  │  ├─ http/
│  │  │  ├─ routes.ts
│  │  │  └─ sse.ts
│  │  ├─ db/
│  │  │  ├─ client.ts
│  │  │  ├─ migrate.ts
│  │  │  └─ seed.ts
│  │  ├─ memory/
│  │  │  └─ snapshot.ts              # MemorySnapshot 装配
│  │  ├─ tools/
│  │  │  ├─ index.ts
│  │  │  ├─ read.ts
│  │  │  ├─ evidence.ts
│  │  │  ├─ research.ts
│  │  │  ├─ questionnaire.ts
│  │  │  └─ action.ts
│  │  ├─ prompts/
│  │  │  ├─ main-agent.md
│  │  │  └─ insight.md
│  │  ├─ adapters/
│  │  │  ├─ contacts.ts              # LocalContactsAdapter
│  │  │  └─ calendar.ts              # LocalCalendarAdapter
│  │  └─ util/
│  │     ├─ ids.ts
│  │     ├─ tokens.ts
│  │     └─ ssrf.ts
│  └─ test/
│     ├─ domain.test.ts
│     ├─ safety.test.ts
│     ├─ memory.test.ts
│     └─ api.test.ts
├─ web/
│  ├─ package.json
│  ├─ vite.config.ts
│  ├─ index.html
│  └─ src/
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ api.ts
│     ├─ styles.css
│     └─ components/
│        ├─ Chat.tsx
│        ├─ ActionCard.tsx
│        ├─ Questionnaire.tsx
│        ├─ PermissionCard.tsx
│        ├─ MemoryReview.tsx
│        └─ ContactList.tsx
└─ evals/
   ├─ cases/                         # 40 个 JSON
   ├─ run.ts
   ├─ judge.ts
   ├─ mock-model.ts
   └─ runs/                          # 报告与 trace（gitignore）
```

**严格保留的文件名**：`agent-service.ts`、`agent.ts`、`agent-safety.ts`、`insight-agent.ts`、`domain.ts`、`text-memory.ts`、`conversation-context.ts`、`017_text_memory_documents.sql`。其余是本设计新增。

---

## 8. 领域模型

### 8.1 枚举

```ts
type EvidenceType = "user_note" | "screenshot" | "web_page" | "action_receipt";
type FactStatus = "candidate" | "confirmed" | "rejected" | "superseded";
type MemoryStatus = "candidate" | "confirmed" | "rejected" | "superseded";
type InsightStatus = "active" | "refuted" | "superseded";
type ActionType = "create_contact" | "update_contact" | "merge_contacts"
                | "create_event" | "update_event" | "delete_event";
type ActionStatus = "proposed" | "confirmed" | "rejected"
                  | "executed" | "failed" | "conflict";
type RunStatus = "running" | "waiting_questionnaire" | "waiting_permission"
               | "completed" | "proposed" | "failed" | "aborted";
```

### 8.2 对象

| 对象 | 关键字段 |
|---|---|
| `Contact` | id, displayName, version, status(active/merged), mergedIntoId?, mergedAt?, createdAt, updatedAt |
| `ContactFact` | id, contactId, field, value, status, confidence, evidenceIds[], supersededBy |
| `Evidence` | id, threadId?, contactId?, type, content?, storagePath?, mimeType?, sha256, sourceSummary, metadata, capturedAt, expiresAt? |
| `MemoryItem` | id, contactId, kind, content, status, confidence, evidenceIds[], confirmedAt?, supersededBy? |
| `MemoryDocument` | id, contactId, version, contentMarkdown, status(draft/active/archived), evidenceIds[], approvedAt? |
| `Insight` | id, contactId, actionId?, content, confidence(low/medium/high), status, evidenceIds[], sourceIds[], recheckAt? |
| `RelationshipGoal` | id, contactId, description, status(active/archived), evidenceIds[] |
| `Thread` | id, userId, title, compactionSummary?, compactionVersion, updatedAt |
| `Message` | id, threadId, seq, role, payload(JSONB), createdAt |
| `AgentRun` | id, threadId, requestId(unique), status, model, promptVersion, budget, usage, error? |
| `ToolCall` | id, runId, toolName, args, result, status, error?, startedAt, endedAt |
| `Action` | id, threadId, contactId?, type, payload, status, version, baseVersion?, evidenceIds[], rationale |
| `ActionReceipt` | id, actionId(unique), status(success/failed), actualResult, error?, receiptAt |
| `Questionnaire` | id, runId, questions[], answers?, status(pending/answered/cancelled) |
| `PermissionRequest` | id, runId, toolName, args, status(pending/granted/denied) |

### 8.3 Action payload

```ts
type ActionPayload =
  | { type: "create_contact"; displayName: string; company?: string; title?: string;
      phone?: string; email?: string; notes?: string }
  | { type: "update_contact"; contactId: string; patch: Partial<ContactFields>; baseVersion?: number }
  | { type: "merge_contacts"; sourceContactIds: string[]; targetContactId: string;
      fieldChoices: Record<string, string>; baseVersion?: number }
  | { type: "create_event"; title: string; startsAt: string; endsAt: string;
      timezone: string; location?: string; notes?: string; contactIds?: string[] }
  | { type: "update_event"; eventId: string; patch: Partial<EventFields>; baseVersion?: number }
  | { type: "delete_event"; eventId: string; baseVersion?: number };
```

`baseVersion` 走 CAS，但**由谁填写**有明确规则：

- 模型可以不填；`propose_action` 落库时由服务端盖上目标对象**当前** `version`，并记 `base_version_source="server"`。
- 模型若填写，服务端先校验；与当前版本不一致则拒绝提案（`stale_base_version`），不建 Action。
- 确认执行时再比一次：`UPDATE ... WHERE version = $baseVersion`，影响 0 行则 Action 置 `conflict`，返回 409，要求重新读取后再提案。
- 这样 CAS 保护的是“提案 → 确认”这段窗口，不依赖模型准确抄写版本号；Action Card 始终显示 `baseVersion`。

### 8.4 合并联系人语义

`merge_contacts` 不是物理搬运，而是“逻辑归并 + 组内读取”：

- 源联系人：`status="merged"`、`mergedIntoId=target`、`mergedAt=now`；不删除。
- 目标联系人：保持 `active`，`version + 1`。
- **读取按组**：`contactGroupIds(target)` 返回 target + 所有直接/间接 merged 源；快照、档案、搜索、证据读取都用这个组。
- **数据不搬家**：`contact_facts`、`memory_items`、`insights`、`goals`、`evidence.contact_id` 保持原归属，保留溯源；组内聚合时再按 `field` 去重。
- **冲突处理**：合并 Action 的 `fieldChoices` 决定每个字段以谁为准；被覆盖的源事实置 `superseded`，目标上写一条新的 `confirmed` 事实，带原 evidence。
- **记忆文档**：源联系人的 active 文档置 `archived`；目标联系人生成一份新的 `draft`，合并各方内容，仍需用户审核，不自动 active。
- **洞察归属**：合并后新洞察一律挂 target；源联系人不再产生新洞察。
- **搜索**：默认排除 `status="merged"`；`get_contact_profile` 命中源时返回 target 档案，并附 `mergedFrom` 列表。
- **禁止**：把 B 的私有事实写进 A 的洞察；合并场景视为“同一个人”，按 target 组处理。

---

## 9. 数据模型

### 9.1 迁移文件（18 个）

| 文件 | 内容 |
|---|---|
| `001_extensions.sql` | `pgcrypto`（`gen_random_uuid()`） |
| `002_contacts.sql` | contacts |
| `003_contact_facts.sql` | contact_facts |
| `004_evidence.sql` | evidence |
| `005_threads.sql` | threads |
| `006_messages.sql` | messages |
| `007_agent_runs.sql` | agent_runs |
| `008_agent_events.sql` | agent_events |
| `009_tool_calls.sql` | tool_calls |
| `010_calendar.sql` | calendar_events + meet_intents |
| `011_actions.sql` | actions |
| `012_action_receipts.sql` | action_receipts |
| `013_questionnaires.sql` | questionnaires + permission_requests |
| `014_insights.sql` | insights |
| `015_relationship_goals.sql` | relationship_goals |
| `016_memory_items.sql` | memory_items |
| `017_text_memory_documents.sql` | memory_documents（保留原文件名） |
| `018_thread_compaction_cutoff.sql` | threads.compaction_until_seq（P4 新增，防重复压缩） |

### 9.2 关键约定

- 主键统一 `uuid default gen_random_uuid()`。
- 所有时间 `timestamptz`，服务端存 UTC，展示用用户时区。
- `contact_facts` 是“当前结构化事实”的来源；`contacts` 只保留身份与 `display_name` 投影，两者同一事务更新，`contacts.version` 做 CAS。
- `evidence.sha256` 去重；`expires_at` 只对 screenshot 设置（默认 +24h）。
- `memory_documents` 每次批准新增一行 `version`，旧行 `archived`；`(contact_id, version)` 唯一。
- `agent_runs.request_id` 唯一，用于请求幂等。
- `actions.version` 与 `base_version` 分开：前者是 Action 自身版本，后者是目标对象版本。
- `contacts.status` 只有 `active`/`merged`；merged 行必须带 `merged_into_id`，且不能作为新 Action 的目标。
- 所有删除均为软删/状态迁移，不物理删事实与记忆。
- `insights` 增加唯一约束 `(action_id, contact_id)`：一个 Action 对同一个人最多一条洞察。

### 9.3 索引

`agent_runs(thread_id, started_at)`、`messages(thread_id, seq)`、`agent_events(run_id, seq)`、`evidence(contact_id, captured_at)`、`evidence(expires_at)`、`actions(thread_id, status)`、`insights(contact_id, status)`、`memory_items(contact_id, status)`、`memory_documents(contact_id, status)`。

---

## 10. 请求生命周期

1. 客户端 `POST /api/threads/:id/messages`，带 `text`、`images[]`、`pageContext`、`permissionMode`、`requestId`。
2. `agent-service` 先查 `requestId`：已存在则直接返回旧 run（幂等）。
3. 创建 `user_note` evidence（文字）和每条 `screenshot` evidence（图片落到 `EVIDENCE_DIR`，算 sha256，设 24h 过期）。
4. 按 `pageContext.contactId` 装配 `MemorySnapshot`。
5. `conversation-context` 恢复历史消息；超阈值先压缩。
6. 构造 Pi Agent：system prompt + 工具 + `beforeToolCall` 权限钩子。
7. 进入 tool loop，事件写 `agent_events`/`tool_calls`，同时推 SSE。
8. 三种终态：
   - 正常回答 → `completed`。
   - `questionnaire` → 落库、`waiting_questionnaire`、结束本轮。
   - `propose_action` → 建 Action、`proposed`、结束本轮。
9. 恢复：
   - 问卷回答 `POST /api/questionnaires/:id/answer` → 补 toolResult → `agent.continue()`。
   - 联网授权 `POST /api/permissions/:id/decide` → 补 toolResult → `agent.continue()`。
   - 若 Pi 不允许挂起中的 tool call 续跑，则新建 run 并注入“已答问卷/已授权”作为 toolResult；trace 标 `resumedFromRunId`，行为等价。
10. Action confirm：`POST /api/actions/:id/confirm` → 校验 → Adapter 执行 → 写 receipt → 调 `insight-agent.ts` → 返回 receipt + insight。
11. Action reject：只改状态，不执行。
12. 任何一步失败都写 `agent_runs.error` 并推 `error` SSE；不把失败写成成功。

### 10.1 运行状态机

```
running ──normal──▶ completed
   │
   ├──questionnaire──▶ waiting_questionnaire ──answer──▶ running
   ├──web tool in ask──▶ waiting_permission ──decide──▶ running
   ├──propose_action──▶ proposed ──confirm──▶ (execution + insight)
   └──limit/abort──▶ failed / aborted
```

`proposed` 之后主 run 不再调用任何工具；执行属于确认接口的新事务。

---

## 11. MemorySnapshot

### 11.1 结构

```ts
interface MemorySnapshot {
  now: string;
  timezone: string;
  contact: {
    id: string;
    displayName: string;
    version: number;
    facts: Array<{ field: string; value: string; status: FactStatus; evidenceIds: string[] }>;
    mergedFrom?: Array<{ id: string; displayName: string }>;
  } | null;
  evidence: Array<{ id: string; type: EvidenceType; summary: string; capturedAt: string; expired: boolean }>;
  candidates: Array<{ id: string; kind: string; content: string; evidenceIds: string[] }>;
  conflicts: Array<{ field: string; values: string[]; evidenceIds: string[] }>;
  goals: Array<{ id: string; description: string; evidenceIds: string[] }>;
  insights: Array<{ id: string; content: string; confidence: string; evidenceIds: string[] }>;
  confirmedMemories: Array<{ id: string; kind: string; content: string; evidenceIds: string[] }>;
  memoryDocument: { version: number; contentMarkdown: string } | null;
  actions: Array<{ id: string; type: ActionType; status: ActionStatus; summary: string }>;
  thread: { id: string; compactionSummary?: string };
}
```

### 11.2 装配规则

- 只装配当前 `contactId` 所在**联系人组**的数据（target + merged 源）；没有 `contactId` 时 `contact=null`，不注入任何联系人专属资料。
- 组内同一字段出现多个 confirmed 值 → 进 `conflicts`，不擅自选一个。
- 已过期截图只保留摘要/hash，`expired=true`，不提供原图路径。
- 事实按 `field` 分组，多个 `confirmed` 且值不同 → 进 `conflicts`。
- 只带 `status=active` 且未被否定的 Insight。
- 优先级（超预算时从后往前截断）：confirmed facts > active goals > confirmed memories > memory document > insights > candidates > evidence summaries。
- 渲染成紧凑 Markdown 注入 system prompt，保留 evidence ID 原文，便于模型引用。

---

## 12. 工具与权限

### 12.1 工具清单

| # | 工具名 | 类别 | 作用 |
|---|---|---|---|
| 1 | `search_contacts` | 只读 | 按姓名/公司搜索 |
| 2 | `get_contact_profile` | 只读 | 读事实、记忆、洞察、目标、`version`、mergedFrom |
| 3 | `list_calendar_events` | 只读 | 读时间范围内事件（含 `version`） |
| 4 | `find_free_slots` | 只读 | 算空闲时间段 |
| 5 | `generate_meeting_brief` | 只读 | 生成会前简报 |
| 6 | `list_meet_intents` | 只读 | 读见面意图 |
| 7 | `record_screenshot_understanding` | 证据 | 记录截图结构化理解 |
| 8 | `record_candidate_memory` | 候选 | 写候选记忆 |
| 9 | `record_meet_intent` | 候选 | 写见面意图 |
| 10 | `web_research` | 研究 | 搜索并深读公开页面 |
| 11 | `fetch_public_url` | 研究 | 读用户给的网页 |
| 12 | `questionnaire` | 终态 | 1–4 道结构化追问 |
| 13 | `propose_action` | 终态 | 生成 Action Card |

写联系人/日历**没有**直接工具；只能通过 `propose_action`。执行由服务端在 confirm 时调用 Adapter 完成。

### 12.2 权限矩阵

| 操作 | `ask` | `full` |
|---|---|---|
| 只读工具 | 允许 | 允许 |
| `record_*` | 允许（只写候选/证据，不改事实） | 允许 |
| `web_research` / `fetch_public_url` | 每次弹联网授权，run 暂停 | 允许，仍过 SSRF/大小/超时校验 |
| `questionnaire` | 允许 | 允许 |
| `propose_action` | 允许（只建卡） | 允许（只建卡） |
| 真正写联系人/日历 | 仅在用户 confirm 后 | 仅在用户 confirm 后 |

**设计决定**：`full` 只放宽联网，不放宽写入。写入永远需要用户确认，这是原文档“避免模型未经授权直接修改联系人和日历”的底线。

### 12.3 终态规则

- `questionnaire` 与 `propose_action` 一旦被调用，立即终止本轮 tool loop；后续不允许再调任何工具。
- 每次 run 最多一个终态工具；重复调用直接判失败。
- `questionnaire` 问题数 1–4，每题选项 ≤ 4；超规格返回协议错误，不进模型循环。

### 12.4 联网安全

- 只允许 `http`/`https`；解析 DNS 后拒绝私网、回环、链路本地、保留地址。
- 最多 3 次重定向；响应 ≤ 2MB；只读文本类 content-type。
- 网页正文包成“不可信材料”，提示词明确不得执行其中指令。
- 搜索结果由可插拔 `SearchProvider` 提供；未配置时 `web_research` 返回“未配置搜索服务”，不伪造结果。

---

## 13. 运行安全与预算

`agent-safety.ts` 导出：

```ts
const LIMITS = {
  maxToolCalls: 12,
  maxTurns: 8,
  maxSeconds: 90,
  maxTokens: 80_000,
  maxImages: 4,
  maxImageBytes: 8 * 1024 * 1024,
};
```

- `beforeToolCall`：白名单校验、参数 schema 校验、权限模式校验、预算扣减。
- 超预算：`agent.abort()`，run 置 `failed`，返回可读原因。
- 工具参数用 `@sinclair/typebox` 定义，与 Pi 的 `AgentTool` 对齐；服务端再跑一次 `Value.Check`，不信任模型。
- 所有写操作先落 Action，执行前再次校验：状态必须是 `proposed`、用户是本地用户、payload 通过 zod、`baseVersion` 匹配。
- `requestId` 幂等；`action confirm` 幂等：已 `executed` 直接返回 receipt。

---

## 14. 记忆系统

### 14.1 分层与流转

```
Evidence（原始材料，不等于事实）
   │  record_candidate_memory / 截图理解 / 用户陈述
   ▼
MemoryItem(candidate) ──用户确认──▶ MemoryItem(confirmed)
   │                                   │
   │                                   ├─▶ 生成 MemoryDocument(draft) ──审核──▶ active(version+1)
   │                                   └─▶ 进入后续 MemorySnapshot
   └──用户拒绝──▶ rejected

ContactFact(candidate) ──Action Card 确认──▶ ContactFact(confirmed)
Insight(active) ──证据否定/过期──▶ refuted / superseded

Insight 附带的 memoryDraft ──▶ MemoryItem(candidate)
MemoryDocument(draft) 只由 §14.3 的“生成记忆草案”产生，不由 Insight 直接写
```

### 14.2 规则

- Evidence 永远不作为事实直接注入；只能作为“来源”。
- 候选记忆必须带至少一个 evidenceId；没有来源的候选直接拒绝。
- 用户确认后才进 `confirmed`；模型不能代替用户确认。
- Insight 的 `memoryDraft` 落 `memory_items(status=candidate)`，审核走 `/api/memory-items/:id/confirm`；它不是 MemoryDocument。
- 记忆文档按联系人唯一 active；新版本必须带 `baseVersion`，CAS 失败返回 409。
- 旧版本归档，不物理删除；快照只读 active。
- 跨人物隔离在 SQL 层强制 `contact_id` 条件；读取统一走 `contactGroupIds(contactId)`，合并组视为同一个人。
- 截图 24h 到期：清理任务删原图、保留 `sourceSummary`/`sha256`/候选字段/来源关系。

### 14.3 记忆文档生成

`POST /api/contacts/:id/memory-drafts` 触发：读取该联系人 confirmed facts + confirmed memories + active insights + 上一版文档 → 让模型生成 Markdown 草案 → 存 `status=draft`。用户审核后才切 active。

---

## 15. Insight Agent

### 15.1 触发

- Action confirm 成功写 receipt 后，同步调用（文档承认这会增加回执延迟；持久化队列列为后续演进）。
- 失败隔离：Insight 超时/协议错误/持久化失败，不回滚已完成的 Action；receipt 仍返回，附带 `insightStatus=failed`。
- **多联系人 Action**（`create_event` 的 `contactIds[]`）：按每个联系人各评估一次，各自使用该联系人的快照与证据；每人最多 1 条，绝不把 B 的事实写进 A 的洞察。
- **merge_contacts**：把合并组当作一个逻辑人，只对 target 评估。
- `Insight` 唯一约束 `(action_id, contact_id)`；同一 Action 对同一人重复执行只更新原记录。

### 15.2 输入

- 执行前 Action + MemorySnapshot 摘要
- Action payload + receipt（实际结果）
- 关联 evidence（含 sourceID）

### 15.3 输出（严格 JSON）

```json
{
  "insight": null,
  "memoryDraft": null
}
```

或：

```json
{
  "insight": {
    "content": "……",
    "confidence": "low|medium|high",
    "recheckAt": "2026-11-15T00:00:00Z",
    "evidenceIds": ["ev_..."],
    "sourceIds": ["ev_..."]
  },
  "memoryDraft": { "content": "……", "evidenceIds": ["ev_..."] }
}
```

规则：
- 每个联系人最多 1 条 insight；没有新信号就返回 `null`，不许硬凑。
- `evidenceIds` 只允许 `ev_` 前缀，必须存在且属于该联系人（或合并组）。
- `sourceIds` 允许 `ev_` / `act_` / `msg_` 三种前缀，分别校验 evidence、action、message 存在且归属一致；伪造或跨人物则整条丢弃并记评测失败。
- Insight 永远是推断，不是事实；不自动升级为 ContactFact。
- `memoryDraft` 落 `memory_items(status=candidate)`，与 insight 同一事务保存；draft 失败则两者一起回滚。它不是 `memory_documents`。
- `recheckAt` 默认 7 天后；`confidence` 必须给。

---

## 16. 会话压缩与恢复

- 触发：估算 token 超模型上下文 60%，或消息数 > 40。
- 先调 Pi 的 `transformContext`；Pi 未提供现成 compaction 时，用“摘要旧消息 + 保留最近 6 轮”的确定性实现，摘要写 `threads.compaction_summary`，`compaction_version` 做 CAS。
- 摘要必须保留：未完成 Action、待答问卷、关键 evidence ID、用户明确目标。
- 恢复时：system prompt + 摘要 + 最近消息 + 当前 MemorySnapshot。
- 压缩失败不阻塞对话；降级为截断最旧消息并在 trace 标记。
- 并发压缩用 `compaction_version` 防止旧摘要覆盖新摘要。

---

## 17. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/threads` | 新建会话 |
| GET | `/api/threads/:id` | 会话 + 最近消息 |
| POST | `/api/threads/:id/messages` | 发消息，返回 `runId` |
| GET | `/api/runs/:id` | run 状态 + 待处理项 |
| GET | `/api/runs/:id/events` | SSE |
| POST | `/api/questionnaires/:id/answer` | 提交问卷，恢复 |
| POST | `/api/permissions/:id/decide` | 允许/拒绝联网，恢复 |
| POST | `/api/actions/:id/confirm` | 执行 + receipt + insight |
| POST | `/api/actions/:id/reject` | 拒绝 |
| GET | `/api/contacts` | 联系人列表 |
| GET | `/api/contacts/:id` | 事实/记忆/洞察/目标 |
| POST | `/api/contacts/:id/memory-drafts` | 生成记忆草案 |
| GET | `/api/memory-drafts?contactId=` | 草案列表 |
| POST | `/api/memory-drafts/:id/approve` | 审核通过（CAS） |
| POST | `/api/memory-drafts/:id/reject` | 驳回 |
| POST | `/api/memory-items/:id/confirm` | 确认候选记忆 |
| POST | `/api/memory-items/:id/reject` | 拒绝候选记忆 |
| GET | `/api/evidence/:id` | 取未过期原图 |

SSE 事件：`run_started`、`message_delta`、`tool_started`、`tool_finished`、`questionnaire`、`permission_request`、`action_proposed`、`run_completed`、`error`。

请求体（发消息）：

```json
{
  "text": "帮我约她下周三喝咖啡",
  "images": [{ "mimeType": "image/jpeg", "dataBase64": "..." }],
  "pageContext": { "contactId": "uuid", "insightId": null, "calendarEventId": null, "revision": 3 },
  "permissionMode": "ask",
  "requestId": "uuid"
}
```

---

## 18. Web 端

最小但完整：

- **聊天页**：消息流、输入框、最多 4 张图、`permissionMode` 切换。
- **Action Card**：展示类型、字段 diff、理由、证据链接；确认/拒绝。
- **Questionnaire**：1–4 题，单选/多选/文本/日期；提交后恢复。
- **Permission Card**：显示工具名和目标 URL；允许/拒绝。
- **Memory Review**：候选记忆确认/拒绝；记忆文档草案预览与批准。
- **Contacts**：列表 + 详情（事实、记忆、洞察、目标）。
- 全部中文；不做 i18n。
- SSE 断线重连；刷新后按 `threadId` 恢复。

---

## 19. 评测

### 19.1 40 条用例

5 条主线 × 8 条：

| 前缀 | 主线 | 示例关注点 |
|---|---|---|
| `E01–E08` | 证据与人物上下文 | 证据入库、截图候选、图片数量边界、人物隔离、截图过期 |
| `Q01–Q08` | 问卷与会话恢复 | 日期缺口、协议边界、重启续答、未答问卷、重复回答 |
| `A01–A08` | Action/receipt/权限 | 未确认写入、重复确认、CAS 冲突、合并联系人无回执、删除事件 |
| `I01–I08` | Insight 与记忆 | 证据溯源、伪造 sourceID、空洞察、草稿审核、失败不回滚 |
| `M01–M08` | 主 Agent 工具选择 | 只读/联网/追问/提案的选择、终态后无额外调用、预算上限 |

### 19.2 case 字段

`case_id`、`category`、`user_input`、`personID`、`threadID`、`requestID`、`permission_mode`、`PageContext`、`evidence`、`initial_state`、`expected_tools`、`expected_state`、`forbidden_effects`、`judge_rubric`。

### 19.3 三层判分

1. **接口/状态硬断言**：字段、工具名、参数、权限、Action version、receipt、sourceIDs、记忆状态。越权、未确认写入、跨人物泄漏、伪造来源、重复执行、事务边界错误 → 直接 Fail。
2. **轨迹**：用户输入 → 工具调用 → 返回值 → 问卷恢复 → Action → 设备回执串成 Trace；检查终态后无额外调用、错误不触发重复执行。
3. **语义 Judge**：只评证据一致性、新增价值、建议可执行性、边界表达，各 0/1/2；≥7/8 且证据一致性=2 才通过。纯接口用例只用硬断言。

### 19.4 运行方式

- 默认 `mock`：`evals/mock-model.ts` 实现 Pi 的 `streamFn`，按 case 脚本返回工具调用/文本，确定性、零 API 成本。
- 可选 `live`：真实模型，3 次复跑，40 × 3 = 120 次；报告分别给“稳定通过率（3/3 的 case 数 / 40）”和“单次通过率（通过 run 数 / 120）”。
- 产物：`evals/runs/<timestamp>/report.json`、`report.md`、`traces/*.json`。
- Judge 校准：**用模拟数据做模拟校准**，不冒充人工。
  - 从语义用例抽 20 条，人工预先写好 `evals/fixtures/simulated-review.json`（作为测试夹具，不是真人评分）。
  - 用第二个 `fauxProvider` 或固定脚本扮演“复核员”，按夹具给 0/1/2 分。
  - 报告里分开写：`judgeSelfScore`、`simulatedAgreement`、`calibration: "simulated"`。
  - 禁止出现 `humanAgreement` 字段；模拟校准只验证“评分管线是否跑通”，不证明 Judge 与真人一致。
- P6 验收 = 40 条用例 + 校准管线可跑 + 报告字段正确；不依赖真人评分。

---

## 20. 配置

`.env.example`：

```dotenv
DATABASE_URL=postgres://relationship:relationship@localhost:5432/relationship
TEST_DATABASE_URL=postgres://relationship:relationship@localhost:5432/relationship_test
PORT=8787
HOST=127.0.0.1
PI_PROVIDER=deepseek
PI_MODEL=deepseek-flash
PI_VISION_MODEL=deepseek-flash
# DEEPSEEK_API_KEY 由系统环境变量提供，不写进 .env
PI_BASE_URL=
EVIDENCE_DIR=./data/evidence
EVIDENCE_TTL_HOURS=24
SEARCH_PROVIDER=none
SEARCH_API_KEY=
MAX_TOOL_CALLS=12
MAX_RUN_SECONDS=90
EVAL_MODE=mock
CALIBRATION_MODE=simulated
```

- `deepseek-flash` 是 pi-ai 目录里的模型 ID（V4.1 Flash，支持 text+image，1M context）；P2 启动时用 `models.getModel("deepseek", "deepseek-flash")` 自检，失败就报错而不是静默降级。
- 没有 `DEEPSEEK_API_KEY` 时，服务端进入 mock 模式，仍可跑通 UI 与评测。
- 不把密钥写进代码、日志、trace。

---

## 21. 阶段计划与验收

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0** | 本 SPEC | 你确认 |
| P1 | Git 初始化、目录骨架、compose、17 个迁移、seed、health | `git log` 有首个提交；`docker compose up -d`；迁移可 up/down；`GET /api/health` 200 |
| P2 | 主 loop、只读工具、证据、Snapshot、SSE | 纯文本问答；4 图入库；未确认零写入；终态后无额外工具 |
| P3 | questionnaire、联网授权、Action/receipt、Adapter | 暂停/恢复；重复确认幂等；CAS 冲突 409 |
| P4 | 记忆项/文档/版本、24h 清理、压缩 | 候选→确认；文档 version+1；跨人物隔离；过期不可读 |
| P5 | Insight Agent | 伪造 sourceID 被拒；draft 不自动 confirmed；失败不回滚 Action |
| P6 | 40 条评测 + 报告 | mock 全跑通；报告含硬断言/轨迹/Judge 三层 |
| P7 | Web 端 | 浏览器端到端演示 |
| P8 | README/AGENT_DESIGN/VERIFICATION + 学习版导出 + 核心文件逐段注释 + 面试题库 | 第三人按文档从零跑通；桌面学习版可独立启动 |

每阶段结束跑 `npm test`，并做一次 Git 提交；不通过不进下一阶段。

---

## 22. 风险与未知

| 风险 | 影响 | 应对 |
|---|---|---|
| Pi 1.4.0 API 与文档有差异 | loop/恢复写不出来 | 锁版本；P2 先写 20 行 spike 验证 `Agent`/`beforeToolCall`/`continue` |
| 模型不支持 vision 或 tool calling | 截图/工具链失效 | 启动时用 `models.getModel("deepseek", "deepseek-flash")` 自检；失败即报错，不静默换模型 |
| `deepseek-flash` 的 API ID 与 pi-ai 目录不一致 | P2 起不来 | 先查 pi-ai catalog 再配置；以 API 实际返回为准，记入 VERIFICATION |
| 挂起中的 tool call 无法续跑 | 问卷恢复失败 | 降级为“新建 run + 注入已回答内容”，trace 标注 |
| Postgres/Windows 文件路径 | 迁移/截图存储失败 | 统一 `path.posix` 与 Docker volume |
| 原文档只有 7 页 | 机制理解偏差 | 所有推断写进 SPEC；不把推断说成原设计 |
| 评测 live 成本高 | 预算超支 | 默认 mock；live 需显式 `EVAL_MODE=live` |
| 无 iOS | 真机 Contacts/EventKit 行为无法复现 | 明确非目标；Adapter 只保证 receipt 语义 |

---

## 23. 已确认的决定

| 事项 | 决定 |
|---|---|
| 模型 | DeepSeek `deepseek-flash`（V4.1 Flash，text+image，1M context）；key 走系统环境变量 `DEEPSEEK_API_KEY` |
| Web 语言 | 只做中文 |
| 评测校准 | 用模拟数据做模拟校准，报告标注 `calibration: "simulated"`，不写“人工一致率” |
| Git | 主项目 `git init`，按阶段提交，不配远程、不 push |
| 注释 | 生产版写“为什么/边界/坑”；学习版核心文件加 `// 学习注:` 逐段解释 |
| 学习版 | `C:\path\to\relationship-agent-learning`，独立可运行 |
| 主项目位置 | 保留在 `新建文件夹 (2)\relationship-agent\`；学习版单独放桌面 |

当前无阻塞 P1 的待确认项。若 P2 发现 `deepseek-flash` 的 API ID 与目录不一致，我会先停下来报告，不静默换模型。

---

## 24. Git 工作流

### 24.1 Git 工作流

- 仓库根：`C:\path\to\relationship-agent`
- `main` = 生产版；每个阶段一个 commit，消息用中文写清“做了什么、为什么”。
- 提交前跑 `npm test`；不通过不提交。
- `.gitignore` 至少包含：`node_modules/`、`.env`、`data/`、`evals/runs/`、`dist/`、`*.log`、`.DS_Store`。
- 不配 remote、不 push，除非你明确要求。
- 不提交密钥、截图原图、模型输出报告。


---

## 附：与原文档的对应关系

| 原文档 | 本设计 |
|---|---|
| 主 Agent 执行链路 | `agent-service.ts` + `agent.ts` + `agent-safety.ts` |
| 工具权限/预算 | `beforeToolCall` + `agent-safety.ts` |
| questionnaire / Action Card | `tools/questionnaire.ts` + `tools/action.ts` + `actions` 表 |
| MemorySnapshot | `memory/snapshot.ts` + `domain.ts` |
| 长期记忆/版本 | `text-memory.ts` + `memory_documents` + CAS |
| Pi compaction | `conversation-context.ts` + `threads.compaction_summary` |
| Insight Agent | `insight-agent.ts` |
| 40 条评测 | `evals/` |
| iOS 客户端 | 不复现，Web 替代 |
