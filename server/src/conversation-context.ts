import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Db } from "./db/client.ts";
import { estimateMessagesTokens } from "./util/tokens.ts";
import { completeText } from "./util/llm.ts";

const BASE_PROMPT = readFileSync(
  fileURLToPath(new URL("./prompts/main-agent.md", import.meta.url)),
  "utf8",
);
const COMPACTION_PROMPT = readFileSync(
  fileURLToPath(new URL("./prompts/compaction.md", import.meta.url)),
  "utf8",
);

export const COMPACTION_THRESHOLD_TOKENS = 40_000;
export const KEEP_RECENT_MESSAGES = 12;

export interface ThreadItem {
  seq: number;
  message: AgentMessage;
}

export interface LoadedThread {
  items: ThreadItem[];
  messages: AgentMessage[];
  summary: string | null;
  untilSeq: number;
  version: number;
  totalTokens: number;
}

export async function loadThreadState(db: Db, threadId: string): Promise<LoadedThread> {
  const thread = await db.query<{
    compaction_summary: string | null;
    compaction_until_seq: number;
    compaction_version: number;
  }>(
    `SELECT compaction_summary, compaction_until_seq, compaction_version
     FROM threads WHERE id = $1`,
    [threadId],
  );

  const cutoff = thread.rows[0]?.compaction_until_seq ?? 0;
  const result = await db.query<{ seq: number; payload: AgentMessage }>(
    `SELECT seq, payload FROM messages
     WHERE thread_id = $1 AND seq > $2 ORDER BY seq ASC`,
    [threadId, cutoff],
  );

  const items = result.rows.map((row) => ({ seq: row.seq, message: row.payload }));
  const messages = items.map((item) => item.message);

  return {
    items,
    messages,
    summary: thread.rows[0]?.compaction_summary ?? null,
    untilSeq: cutoff,
    version: thread.rows[0]?.compaction_version ?? 0,
    totalTokens: estimateMessagesTokens(
      messages.map((message) => ({
        role: message.role,
        content: "content" in message ? message.content : "",
      })),
    ),
  };
}

export async function appendMessage(db: Db, threadId: string, message: AgentMessage): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // 同一 thread 串行分配 seq，避免并发写撞 unique(thread_id, seq)。
    await client.query("SELECT id FROM threads WHERE id = $1 FOR UPDATE", [threadId]);
    const next = await client.query<{ seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = $1",
      [threadId],
    );
    await client.query(
      "INSERT INTO messages (thread_id, seq, role, payload) VALUES ($1, $2, $3, $4)",
      [threadId, next.rows[0]?.seq ?? 1, message.role, JSON.stringify(message)],
    );
    await client.query("UPDATE threads SET updated_at = now() WHERE id = $1", [threadId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function buildSystemPrompt(snapshotRendered: string, summary: string | null): string {
  const parts = [BASE_PROMPT, "", "## MemorySnapshot", snapshotRendered];
  if (summary) {
    parts.push("", "## 更早会话的压缩摘要", summary);
  }
  return parts.join("\n");
}

export function shouldCompact(messages: AgentMessage[], totalTokens: number): boolean {
  return totalTokens > COMPACTION_THRESHOLD_TOKENS || messages.length > 40;
}

function messageToText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "toolCall") return `[tool ${part.name} ${JSON.stringify(part.arguments)}]`;
    if (part.type === "image") return "[图片]";
    if (part.type === "thinking") return "";
    return "";
  });
  return parts.filter(Boolean).join(" ");
}

/**
 * 用模型把较早的消息压成摘要，并把 cutoff 写回 threads。
 * CAS 用 compaction_version：两个并发压缩只有一个能成功。
 */
export async function compactThread(
  db: Db,
  threadId: string,
  state: LoadedThread,
  summarize: (text: string) => Promise<string> = (text) =>
    completeText(COMPACTION_PROMPT, text),
): Promise<LoadedThread> {
  if (!shouldCompact(state.messages, state.totalTokens) || state.items.length <= KEEP_RECENT_MESSAGES) {
    return state;
  }

  const older = state.items.slice(0, -KEEP_RECENT_MESSAGES);
  const recent = state.items.slice(-KEEP_RECENT_MESSAGES);
  const transcript = older
    .map((item) => `${item.message.role}: ${messageToText(item.message)}`)
    .join("\n")
    .slice(-20_000);

  const input = [
    state.summary ? `# 已有摘要\n${state.summary}` : "",
    `# 需要压缩的对话\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const summary = await summarize(input);
  const cutoff = older.at(-1)?.seq ?? state.untilSeq;

  const updated = await db.query(
    `UPDATE threads
     SET compaction_summary = $2,
         compaction_until_seq = $3,
         compaction_version = compaction_version + 1,
         updated_at = now()
     WHERE id = $1 AND compaction_version = $4`,
    [threadId, summary, cutoff, state.version],
  );

  if (updated.rowCount === 0) {
    // 另一个 run 已经压缩过；重新读，不覆盖它的结果。
    return loadThreadState(db, threadId);
  }

  const messages = recent.map((item) => item.message);
  return {
    items: recent,
    messages,
    summary,
    untilSeq: cutoff,
    version: state.version + 1,
    totalTokens: estimateMessagesTokens(
      messages.map((message) => ({
        role: message.role,
        content: "content" in message ? message.content : "",
      })),
    ),
  };
}
