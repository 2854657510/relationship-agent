# Relationship Agent 架构与实现

> 对应代码：`main` 分支 P8。
> 这份文档讲“为什么这样拆”，SPEC.md 讲“要做成什么样”，README 讲“怎么跑”。

## 1. 目标与非目标

**目标**：用 Pi Agent 做一条可验证的私人关系管家链路：

- 证据先入库，再推理。
- 记忆按联系人隔离，按版本演进。
- 写操作必须经过 Action Card 和用户确认。
- 行动后由独立 Insight Agent 复盘，洞察必须可溯源。
- 40 条用例能重复跑，报告不冒充人工。

**非目标**：iOS 客户端、真实 EventKit/Contacts、多用户、生产部署。

## 2. 组件

| 组件 | 文件 | 职责 |
|---|---|---|
| HTTP 入口 | `server/src/index.ts` | Fastify、CORS、静态资源、清理定时器 |
| 路由 | `server/src/http/routes.ts` | 会话、消息、问卷、授权、Action、记忆、证据 |
| SSE | `server/src/http/sse.ts` | run 事件推送与断线回放 |
| 单次请求编排 | `server/src/agent-service.ts` | 幂等、证据、快照、Agent 生命周期、终态 |
| 主 Agent | `server/src/agent.ts` | Pi `Agent`、DeepSeek 模型、工具注册、预算钩子 |
| 预算 | `server/src/agent-safety.ts` | 工具次数、耗时上限 |
| 会话 | `server/src/conversation-context.ts` | 消息持久化、压缩 cutoff、摘要注入 |
| 领域 | `server/src/domain.ts` | 类型、zod schema、Action/问卷/洞察协议 |
| 记忆 | `server/src/text-memory.ts` | 候选记忆、文档草案、CAS 批准 |
| 快照 | `server/src/memory/snapshot.ts` | 按联系人组装配 MemorySnapshot |
| 工具 | `server/src/tools/*` | 读、证据、研究、追问、行动提案 |
| Action 执行 | `server/src/action-service.ts` + `adapters/*` | 确认、CAS、回执、幂等 |
| Insight | `server/src/insight-agent.ts` | 回执后复盘、来源校验、事务 |
| 清理 | `server/src/cleanup.ts` | 过期截图删原图、留摘要 |
| Web | `web/src/*` | 聊天、Action、问卷、授权、记忆审核 |

## 3. 一轮请求

1. `POST /api/threads/:id/messages`。
2. `startMessageRun` 先查 `(thread_id, request_id)` 是否已有 run → 幂等直接返回。
3. 检查同一 thread 是否有 `running / waiting_*` 的 run → 有则 409，避免并发跑同一会话。
4. 把文字写成 `user_note` evidence；图片落盘、算 sha256、设 24h 过期，写成 `screenshot` evidence。
5. 建 `agent_runs`，状态 `running`，把 `pageContext` 和 `permissionMode` 存下来。
6. 后台 `executeRun`（评测时可同步等待）：
   - 加载 thread 消息；超过阈值先压缩。
   - 按 `pageContext.contactId` 装配 MemorySnapshot。
   - 构造 system prompt + per-run 工具闭包。
   - `Agent.prompt(userMessage)`，事件写 SSE / 数据库。
7. 终态：
   - 正常回答 → `completed`
   - `questionnaire` → `waiting_questionnaire`
   - 联网未授权 → `waiting_permission`
   - `propose_action` → `proposed`
8. 问卷/授权恢复：把回答写成 synthetic user message，新建 run，`resumed_from_run_id` 指回原 run。
9. Action 确认：`POST /api/actions/:id/confirm` → 事务执行 → 写 receipt → commit → 同步 Insight。

### 状态机

```
running ──normal──▶ completed
   ├──questionnaire──▶ waiting_questionnaire ──answer──▶ running
   ├──web in ask────▶ waiting_permission ──decide──▶ running
   ├──propose_action▶ proposed ──confirm──▶ executed + insight
   └──budget/abort──▶ failed / aborted
```

## 4. 主 Agent 与工具

### 4.1 构造

`buildMainAgent` 使用：

- `initialState.systemPrompt`：主 prompt + MemorySnapshot 渲染。
- `initialState.tools`：本次 run 的工具闭包，带 `contactId / threadId / evidenceIds / permissionMode`。
- `streamFn`：生产用 `pi-ai` 的 DeepSeek provider；评测注入 faux provider。
- `toolExecution="sequential"`：保证终态工具之后没有并行调用。
- `beforeToolCall`：扣预算；超限返回 `{block:true,terminate:true}`。

### 4.2 工具

| 工具 | 类型 | 关键约束 |
|---|---|---|
| `search_contacts` | 读 | 只搜 active 联系人 |
| `get_contact_profile` | 读 | 走联系人组，含 version |
| `list_calendar_events` | 读 | 返回 event version |
| `find_free_slots` | 读 | 工作日 09–18，最多 14 天 |
| `generate_meeting_brief` | 读 | 汇总事实/目标/洞察/证据 |
| `list_meet_intents` | 读 | 只读当前联系人 |
| `record_screenshot_understanding` | 证据 | 只写截图摘要，不当事实 |
| `record_candidate_memory` | 候选 | 必须带 evidenceId |
| `record_meet_intent` | 候选 | 带 evidenceId |
| `web_research` | 研究 | ask 模式暂停授权 |
| `fetch_public_url` | 研究 | SSRF 防护 + ask 模式暂停 |
| `questionnaire` | 终态 | 1–4 题，每题 ≤4 选项 |
| `propose_action` | 终态 | 只建 Action，不执行 |

### 4.3 权限

- `ask`：联网工具暂停；写入最终仍要确认。
- `full`：联网放宽，**写入不放宽**。
- 写联系人/日历没有直接工具；只能 `propose_action`。

## 5. Action / receipt / CAS

`action-service.ts`：

1. 加载 Action，校验属于当前用户。
2. 已有 receipt → 直接返回（幂等）。
3. `SELECT ... FOR UPDATE` 锁 Action。
4. 校验 status 和 payload。
5. Adapter 执行：
   - `update_contact / update_event / delete_event / merge_contacts` 用 `base_version` 做 CAS。
   - 0 行受影响 → `ConflictError`。
6. 写 `action_receipts`，状态 `executed`，commit。
7. 调 `runInsightForAction`；失败不回滚 Action。

失败路径：rollback 后把 Action 置 `failed` 或 `conflict`，并写失败回执。

## 6. 记忆

### 分层

- Evidence：原始材料，不等于事实。
- ContactFact：结构化字段，candidate/confirmed/rejected/superseded。
- MemoryItem：一条偏好/印象/关系信号。
- MemoryDocument：按联系人、按版本的长期背景。
- Insight：推断，不是事实。
- RelationshipGoal：当前关系目标。
- ConversationHistory：消息与压缩摘要。

### Snapshot

`assembleSnapshot` 按 `contactGroupIds` 聚合：

- 事实、候选、冲突。
- 活跃目标、有效洞察、已确认记忆。
- 当前 active 长期文档。
- 本 thread 最近 evidence 和 Action。
- 渲染成紧凑 Markdown，超预算按优先级截断。

### 版本与并发

- `memory_documents`：`(contact_id, version)` 唯一；每个联系人最多一份 active。
- 批准草案时锁 active 行，比较 `based_on_version` 和请求 `baseVersion`；不一致 409。
- `contacts.version / calendar_events.version` 供 Action CAS。

### 压缩

- `threads.compaction_until_seq` 记录已压进摘要的最后一条消息。
- 超过 40k tokens 或 40 条消息触发。
- 旧消息 → 模型摘要 → 写 `compaction_summary`，`compaction_version` CAS。
- 摘要必须保留未完成 Action、待答问卷、关键 evidence ID、用户目标。

### 过期

- screenshot 24h 过期。
- 定时清理删原图，保留 `source_summary / sha256 / 元数据`。

## 7. Insight Agent

- 触发：receipt commit 后同步执行。
- 输入：Action + receipt + 执行前快照 + 关联 evidence。
- 输出：0/1 条 insight + 可选 memoryDraft，严格 JSON。
- 校验：
  - `evidenceIds` 必须是该联系人或该 thread 的 evidence。
  - `sourceIds` 支持 `ev_ / act_ / msg_`，逐类查表。
  - `memoryDraft.evidenceIds` 同样校验。
- 事务：insight + memoryDraft 同一事务；draft 失败整条回滚。
- 多联系人：每个联系人单独评估，绝不把 B 的事实写进 A。
- 失败：Action 已完成，不回滚；返回 `insightStatus=failed`。

## 8. 评测

- 40 条用例，5 条主线 × 8。
- `fauxProvider` 按脚本返回工具调用，不花 API 钱。
- 每条 3 次复跑，共 120 run。
- 硬断言：工具、状态、写入、CAS、幂等、跨人物、来源。
- 报告分开写稳定通过率 / 单次通过率。
- 校准是 `calibration: "simulated"`，用夹具模拟复核员，不写人工一致率。

## 9. 安全

- 未确认零写入。
- 工具参数服务端二次校验。
- 联网 SSRF：拒绝私网/回环/链路本地，限 2MB、15s。
- 网页正文标为不可信材料。
- requestId 幂等；confirm 幂等；CAS 防覆盖。
- 截图 24h 过期；密钥只走环境变量。

## 10. 取舍

**Pi Agent vs LangGraph**：Pi 提供 tool loop、`beforeToolCall`、`transformContext`、`abort/waitForIdle`，权限和中断恢复是现成钩子；LangGraph 更适合显式图和多角色编排，但这里的状态机很窄，用图反而重。

**结构化记忆 vs 纯 RAG**：RAG 适合“找相似文本”，不适合“某人的电话以哪个版本为准”。这里事实、候选、冲突、版本、证据 ID 都是结构化字段；向量库可以作为后续召回补充，不能替代事实层。

**Web vs iOS**：复现重点是 Agent 机制，不是 SwiftUI；Web 能在 Windows 上完整验证。iOS 的 EventKit/Contacts 只保留 Adapter 语义。

## 11. 已知限制

- Insight 在 confirm 请求里同步跑，回执会慢。
- `mergeContacts` 没有设备回执，设备端语义未复现。
- 没有 scheduler，不会主动扫描关系变化。
- 记忆审核仍需要人判断。
- 评测默认 mock，live 模式未做 3×40 成本控制。

## 12. 文件地图

```text
server/src/
  agent-service.ts     一轮请求编排
  agent.ts             Pi Agent + 模型
  agent-safety.ts      预算
  conversation-context.ts 消息/压缩
  domain.ts            领域协议
  memory/snapshot.ts   快照
  text-memory.ts       记忆/文档/CAS
  insight-agent.ts     洞察
  action-service.ts    Action 执行
  adapters/            联系人/日历
  tools/               工具
  http/                路由/SSE
```
