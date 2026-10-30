import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Model,
  MutableModels,
  TextContent,
} from "@earendil-works/pi-ai";
import { config } from "./config.ts";
import type { Db } from "./db/client.ts";
import {
  type PageContext,
  type SendMessageInput,
  type ToolContext,
  type ToolTerminalState,
  type PermissionMode,
} from "./domain.ts";
import { buildMainAgent, modelLabel } from "./agent.ts";
import { RunGuard, assertImageLimits } from "./agent-safety.ts";
import { buildTools } from "./tools/index.ts";
import { assembleSnapshot } from "./memory/snapshot.ts";
import {
  appendMessage,
  buildSystemPrompt,
  compactThread,
  loadThreadState,
  shouldCompact,
} from "./conversation-context.ts";
import { publishEvent } from "./http/sse.ts";
import { newId, sha256 } from "./util/ids.ts";
import { ActiveRunError, NotFoundError } from "./errors.ts";

export { ActiveRunError, NotFoundError };

interface RunRow {
  id: string;
  thread_id: string;
  status: string;
  permission_mode: PermissionMode;
  page_context: PageContext;
}

async function emitRunEvent(
  db: Db,
  runId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  const inserted = await db.query<{ seq: number; created_at: Date }>(
    `INSERT INTO agent_events (run_id, seq, type, payload)
     VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_events WHERE run_id = $1), $2, $3)
     RETURNING seq, created_at`,
    [runId, type, JSON.stringify(payload)],
  );
  const row = inserted.rows[0];
  if (row) {
    publishEvent({
      seq: row.seq,
      runId,
      type,
      payload,
      createdAt: row.created_at.toISOString(),
    });
  }
}

function messageKey(message: AgentMessage): string {
  const timestamp = "timestamp" in message ? message.timestamp : 0;
  const toolCallId = "toolCallId" in message ? message.toolCallId : "";
  return `${message.role}:${timestamp}:${toolCallId}`;
}

async function createEvidence(
  db: Db,
  threadId: string,
  contactId: string | null,
  input: SendMessageInput,
): Promise<string[]> {
  assertImageLimits(input.images);
  const ids: string[] = [];
  const text = input.text?.trim();
  if (text) {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO evidence (thread_id, contact_id, type, content, source_summary)
       VALUES ($1, $2, 'user_note', $3, $4)
       RETURNING id`,
      [threadId, contactId, text, "用户输入"],
    );
    if (inserted.rows[0]) ids.push(inserted.rows[0].id);
  }

  for (const image of input.images) {
    const buffer = Buffer.from(image.dataBase64, "base64");
    const hash = sha256(buffer);
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM evidence WHERE sha256 = $1 LIMIT 1",
      [hash],
    );
    if (existing.rows[0]) {
      ids.push(existing.rows[0].id);
      continue;
    }

    const id = newId();
    const dateDir = new Date().toISOString().slice(0, 10);
    const dir = path.join(config.evidenceDir, dateDir);
    await mkdir(dir, { recursive: true });
    const ext = image.mimeType === "image/png" ? "png" : image.mimeType === "image/webp" ? "webp" : "jpg";
    const storagePath = path.join(dir, `${id}.${ext}`);
    await writeFile(storagePath, buffer);
    const expiresAt = new Date(Date.now() + config.evidenceTtlHours * 60 * 60 * 1000);

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO evidence
         (id, thread_id, contact_id, type, storage_path, mime_type, sha256,
          source_summary, expires_at, metadata)
       VALUES ($1, $2, $3, 'screenshot', $4, $5, $6, $7, $8,
               jsonb_build_object('bytes', $9::int))
       RETURNING id`,
      [id, threadId, contactId, storagePath, image.mimeType, hash, "用户上传截图", expiresAt, buffer.byteLength],
    );
    if (inserted.rows[0]) ids.push(inserted.rows[0].id);
  }

  return ids;
}

function buildUserMessage(input: SendMessageInput): AgentMessage {
  const parts: Array<TextContent | ImageContent> = [];
  const text = input.text?.trim();
  if (text) parts.push({ type: "text", text });
  for (const image of input.images) {
    parts.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
  }
  const content = parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
  return { role: "user", content, timestamp: Date.now() };
}

async function loadPending(
  db: Db,
  terminal: ToolTerminalState | null,
): Promise<{ type: string; payload: unknown } | null> {
  if (!terminal) return null;
  if (terminal.type === "questionnaire") {
    const result = await db.query<{ questions: unknown }>(
      "SELECT questions FROM questionnaires WHERE id = $1",
      [terminal.id],
    );
    return { type: "questionnaire", payload: { questionnaireId: terminal.id, questions: result.rows[0]?.questions ?? [] } };
  }
  if (terminal.type === "permission") {
    const result = await db.query<{ tool_name: string; args: unknown }>(
      "SELECT tool_name, args FROM permission_requests WHERE id = $1",
      [terminal.id],
    );
    return {
      type: "permission_request",
      payload: {
        permissionRequestId: terminal.id,
        toolName: result.rows[0]?.tool_name ?? "",
        args: result.rows[0]?.args ?? {},
      },
    };
  }
  const result = await db.query<{
    id: string;
    type: string;
    payload: unknown;
    rationale: string | null;
    evidence_ids: string[];
    base_version: number | null;
  }>(
    "SELECT id, type, payload, rationale, evidence_ids, base_version FROM actions WHERE id = $1",
    [terminal.id],
  );
  const row = result.rows[0];
  return {
    type: "action_proposed",
    payload: {
      actionId: terminal.id,
      type: row?.type ?? "",
      payload: row?.payload ?? {},
      rationale: row?.rationale ?? "",
      evidenceIds: row?.evidence_ids ?? [],
      baseVersion: row?.base_version ?? null,
    },
  };
}

export interface StartedRun {
  runId: string;
  threadId: string;
  existing: boolean;
}

export interface ModelOverrides {
  streamFn?: StreamFn;
  model?: Model<any>;
  /** 评测时把 faux provider 的 Models 集合也传下去，供洞察/摘要调用。 */
  models?: MutableModels;
}

export async function startMessageRun(
  db: Db,
  options: {
    threadId: string;
    userId: string;
    input: SendMessageInput;
    syntheticText?: string;
    resumedFromRunId?: string;
    grantedPermission?: string | null;
    sourceEvidenceIds?: string[];
    /** 评测时注入 faux provider；生产不传。 */
    streamFn?: StreamFn;
    model?: Model<any>;
    /** 评测需要同步拿到结果；生产走后台。 */
    awaitCompletion?: boolean;
  },
): Promise<StartedRun> {
  const thread = await db.query<{ id: string }>(
    "SELECT id FROM threads WHERE id = $1 AND user_id = $2",
    [options.threadId, options.userId],
  );
  if (!thread.rows[0]) throw new NotFoundError("会话不存在");

  const existing = await db.query<{ id: string }>(
    "SELECT id FROM agent_runs WHERE thread_id = $1 AND request_id = $2",
    [options.threadId, options.input.requestId],
  );
  if (existing.rows[0]) {
    return { runId: existing.rows[0].id, threadId: options.threadId, existing: true };
  }

  const active = await db.query<{ id: string }>(
    `SELECT id FROM agent_runs
     WHERE thread_id = $1 AND status IN ('running', 'waiting_questionnaire', 'waiting_permission')
     LIMIT 1`,
    [options.threadId],
  );
  if (active.rows[0]) throw new ActiveRunError();

  const pageContext = options.input.pageContext ?? {};
  const contactId = pageContext.contactId ?? null;
  const evidenceIds = options.sourceEvidenceIds?.length
    ? options.sourceEvidenceIds
    : await createEvidence(db, options.threadId, contactId, options.input);

  const runId = newId();
  await db.query(
    `INSERT INTO agent_runs
       (id, thread_id, request_id, status, model, prompt_version,
        permission_mode, page_context, resumed_from_run_id)
     VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8)`,
    [
      runId,
      options.threadId,
      options.input.requestId,
      modelLabel(),
      "p2",
      options.input.permissionMode,
      JSON.stringify(pageContext),
      options.resumedFromRunId ?? null,
    ],
  );

  const execution = executeRun(db, {
    runId,
    threadId: options.threadId,
    userId: options.userId,
    input: options.input,
    evidenceIds,
    syntheticText: options.syntheticText,
    grantedPermission: options.grantedPermission ?? null,
    streamFn: options.streamFn,
    model: options.model,
  });

  if (options.awaitCompletion) {
    await execution;
  } else {
    void execution.catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await db.query(
        "UPDATE agent_runs SET status = 'failed', error = $2, ended_at = now() WHERE id = $1",
        [runId, message],
      );
      await emitRunEvent(db, runId, "error", { message });
    });
  }

  return { runId, threadId: options.threadId, existing: false };
}

async function executeRun(
  db: Db,
  options: {
    runId: string;
    threadId: string;
    userId: string;
    input: SendMessageInput;
    evidenceIds: string[];
    syntheticText?: string;
    grantedPermission: string | null;
    streamFn?: StreamFn;
    model?: Model<any>;
  },
): Promise<void> {
  const { runId, threadId, userId, input, evidenceIds } = options;
  const pageContext = input.pageContext ?? {};
  const contactId = pageContext.contactId ?? null;

  await emitRunEvent(db, runId, "run_started", {
    runId,
    threadId,
    permissionMode: input.permissionMode,
  });

  let threadState = await loadThreadState(db, threadId);
  if (shouldCompact(threadState.messages, threadState.totalTokens)) {
    try {
      threadState = await compactThread(db, threadId, threadState);
    } catch (error) {
      // 压缩失败不阻塞主流程；保留旧摘要和最近消息继续跑。
      console.warn("compactThread failed:", (error as Error).message);
    }
  }

  const { snapshot, rendered } = await assembleSnapshot(db, {
    contactId,
    threadId,
    compactionSummary: threadState.summary ?? undefined,
  });

  const systemPrompt = buildSystemPrompt(rendered, threadState.summary);
  const toolCtx: ToolContext = {
    userId,
    threadId,
    runId,
    contactId,
    evidenceIds,
    permissionMode: input.permissionMode,
    grantedPermission: options.grantedPermission,
    db,
    terminal: null,
    maxToolCalls: config.limits.maxToolCalls,
  };
  const tools: AgentTool<any>[] = buildTools(toolCtx);
  const guard = new RunGuard();

  const userMessage: AgentMessage = options.syntheticText
    ? { role: "user", content: options.syntheticText, timestamp: Date.now() }
    : buildUserMessage(input);

  await appendMessage(db, threadId, userMessage);

  const agent = buildMainAgent({
    systemPrompt,
    tools,
    messages: threadState.messages,
    guard,
    sessionId: runId,
    streamFn: options.streamFn,
    model: options.model,
  });

  const seen = new Set<string>();
  const toolCallRows = new Map<string, string>();
  let lastUsage: unknown = null;

  const persist = async (message: AgentMessage): Promise<void> => {
    if (message.role === "system" || message.role === "user") return;
    const key = messageKey(message);
    if (seen.has(key)) return;
    seen.add(key);
    await appendMessage(db, threadId, message);
  };

  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        // 逐 token 只走 SSE，不落 agent_events；否则一轮几百行，回放也没意义。
        // 断线重连后客户端从 /api/threads/:id 重新拉完整消息。
        publishEvent({
          seq: 0,
          runId,
          type: "message_delta",
          payload: { delta: update.delta },
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        lastUsage = (event.message as AssistantMessage).usage;
      }
      await persist(event.message);
      return;
    }

    if (event.type === "tool_execution_start") {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO tool_calls (run_id, tool_name, args, status)
         VALUES ($1, $2, $3, 'running') RETURNING id`,
        [runId, event.toolName, JSON.stringify(event.args)],
      );
      if (inserted.rows[0]) toolCallRows.set(event.toolCallId, inserted.rows[0].id);
      await emitRunEvent(db, runId, "tool_started", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const rowId = toolCallRows.get(event.toolCallId);
      if (rowId) {
        await db.query(
          `UPDATE tool_calls
           SET result = $2, status = $3, error = $4, ended_at = now()
           WHERE id = $1`,
          [
            rowId,
            JSON.stringify(event.result ?? null),
            event.isError ? "failed" : "succeeded",
            event.isError ? JSON.stringify(event.result).slice(0, 2_000) : null,
          ],
        );
      }
      await emitRunEvent(db, runId, "tool_finished", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        durationMs: event.durationMs ?? null,
      });
    }
  });

  const timer = setTimeout(() => {
    agent.abort();
  }, config.limits.maxRunSeconds * 1000);

  let status: "completed" | "waiting_questionnaire" | "waiting_permission" | "proposed" = "completed";
  let pending: { type: string; payload: unknown } | null = null;

  try {
    await agent.prompt(userMessage);
    if (toolCtx.terminal?.type === "questionnaire") status = "waiting_questionnaire";
    else if (toolCtx.terminal?.type === "permission") status = "waiting_permission";
    else if (toolCtx.terminal?.type === "action") status = "proposed";
    pending = await loadPending(db, toolCtx.terminal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(
      "UPDATE agent_runs SET status = 'failed', error = $2, usage = $3, ended_at = now() WHERE id = $1",
      [runId, message, JSON.stringify(lastUsage ?? {})],
    );
    await emitRunEvent(db, runId, "error", { message });
    return;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  await db.query(
    "UPDATE agent_runs SET status = $2, usage = $3, ended_at = now() WHERE id = $1",
    [runId, status, JSON.stringify(lastUsage ?? {})],
  );

  if (pending) {
    await emitRunEvent(db, runId, pending.type, pending.payload);
  }
  await emitRunEvent(db, runId, "run_completed", { status });
}

export async function answerQuestionnaire(
  db: Db,
  questionnaireId: string,
  userId: string,
  answers: Record<string, string | string[]>,
  overrides: ModelOverrides & { awaitCompletion?: boolean } = {},
): Promise<StartedRun> {
  const result = await db.query<{
    id: string;
    run_id: string;
    thread_id: string;
    status: string;
    questions: Array<{ id: string; prompt: string }>;
  }>(
    `SELECT q.id, q.run_id, q.thread_id, q.status, q.questions
     FROM questionnaires q
     JOIN threads t ON t.id = q.thread_id
     WHERE q.id = $1 AND t.user_id = $2`,
    [questionnaireId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("问卷不存在");
  if (row.status !== "pending") throw new ActiveRunError("问卷已经回答过了");

  const run = await db.query<{ page_context: PageContext; permission_mode: PermissionMode }>(
    "SELECT page_context, permission_mode FROM agent_runs WHERE id = $1",
    [row.run_id],
  );
  const pageContext = run.rows[0]?.page_context ?? {};
  const permissionMode = run.rows[0]?.permission_mode ?? "ask";

  await db.query(
    `UPDATE questionnaires
     SET status = 'answered', answers = $2, answered_at = now()
     WHERE id = $1`,
    [questionnaireId, JSON.stringify(answers)],
  );
  await db.query(
    "UPDATE agent_runs SET status = 'completed', ended_at = now() WHERE id = $1",
    [row.run_id],
  );

  const lines = row.questions.map((question) => {
    const answer = answers[question.id];
    const text = Array.isArray(answer) ? answer.join("、") : answer ?? "（未回答）";
    return `- ${question.prompt}: ${text}`;
  });
  const syntheticText = [
    "用户已回答上一轮的问卷：",
    ...lines,
    "",
    "请基于这些回答继续原来的任务；如果仍然缺信息，可以继续追问。不要重复问已经回答过的问题。",
  ].join("\n");

  return startMessageRun(db, {
    threadId: row.thread_id,
    userId,
    input: {
      text: syntheticText,
      images: [],
      pageContext,
      permissionMode,
      requestId: `resume-questionnaire-${questionnaireId}`,
    },
    syntheticText,
    resumedFromRunId: row.run_id,
    streamFn: overrides.streamFn,
    model: overrides.model,
    awaitCompletion: overrides.awaitCompletion,
  });
}

export async function decidePermission(
  db: Db,
  permissionId: string,
  userId: string,
  decision: "granted" | "denied",
  overrides: ModelOverrides & { awaitCompletion?: boolean } = {},
): Promise<StartedRun> {
  const result = await db.query<{
    id: string;
    run_id: string;
    tool_name: string;
    status: string;
    thread_id: string;
  }>(
    `SELECT p.id, p.run_id, p.tool_name, p.status, r.thread_id
     FROM permission_requests p
     JOIN agent_runs r ON r.id = p.run_id
     JOIN threads t ON t.id = r.thread_id
     WHERE p.id = $1 AND t.user_id = $2`,
    [permissionId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("授权请求不存在");
  if (row.status !== "pending") throw new ActiveRunError("授权请求已经处理过了");

  const run = await db.query<{ page_context: PageContext; permission_mode: PermissionMode }>(
    "SELECT page_context, permission_mode FROM agent_runs WHERE id = $1",
    [row.run_id],
  );
  const pageContext = run.rows[0]?.page_context ?? {};
  const permissionMode = run.rows[0]?.permission_mode ?? "ask";

  await db.query(
    "UPDATE permission_requests SET status = $2, decided_at = now() WHERE id = $1",
    [permissionId, decision],
  );
  await db.query(
    "UPDATE agent_runs SET status = 'completed', ended_at = now() WHERE id = $1",
    [row.run_id],
  );

  const syntheticText =
    decision === "granted"
      ? `用户允许本次联网（${row.tool_name}）。请继续原任务，只使用这一次授权。`
      : "用户拒绝本次联网。不要再次请求联网，改用已有信息或追问用户。";

  return startMessageRun(db, {
    threadId: row.thread_id,
    userId,
    input: {
      text: syntheticText,
      images: [],
      pageContext,
      permissionMode,
      requestId: `resume-permission-${permissionId}-${decision}`,
    },
    syntheticText,
    resumedFromRunId: row.run_id,
    grantedPermission: decision === "granted" ? row.tool_name : null,
    streamFn: overrides.streamFn,
    model: overrides.model,
    awaitCompletion: overrides.awaitCompletion,
  });
}

export async function getRun(db: Db, runId: string, userId: string): Promise<{
  run: RunRow;
  events: unknown[];
  pendingQuestionnaire: unknown | null;
  pendingPermission: unknown | null;
  pendingAction: unknown | null;
}> {
  const result = await db.query<RunRow>(
    `SELECT r.id, r.thread_id, r.status, r.permission_mode, r.page_context
     FROM agent_runs r JOIN threads t ON t.id = r.thread_id
     WHERE r.id = $1 AND t.user_id = $2`,
    [runId, userId],
  );
  const run = result.rows[0];
  if (!run) throw new NotFoundError("run 不存在");

  const events = await db.query(
    "SELECT seq, type, payload, created_at FROM agent_events WHERE run_id = $1 ORDER BY seq",
    [runId],
  );
  const questionnaire = await db.query(
    "SELECT id, questions, answers, status FROM questionnaires WHERE run_id = $1 AND status = 'pending' LIMIT 1",
    [runId],
  );
  const permission = await db.query(
    "SELECT id, tool_name, args, status FROM permission_requests WHERE run_id = $1 AND status = 'pending' LIMIT 1",
    [runId],
  );
  const action = await db.query(
    "SELECT id, type, payload, rationale, evidence_ids, base_version, status FROM actions WHERE thread_id = $1 AND status = 'proposed' ORDER BY created_at DESC LIMIT 1",
    [run.thread_id],
  );

  return {
    run,
    events: events.rows,
    pendingQuestionnaire: questionnaire.rows[0] ?? null,
    pendingPermission: permission.rows[0] ?? null,
    pendingAction: action.rows[0] ?? null,
  };
}
