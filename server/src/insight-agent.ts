import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import type { Model, MutableModels } from "@earendil-works/pi-ai";
import { getMainModel, getModels } from "./agent.ts";
import type { Db } from "./db/client.ts";
import { insightOutputSchema, type ActionPayload } from "./domain.ts";
import { assembleSnapshot } from "./memory/snapshot.ts";

export interface InsightModelOverrides {
  models?: MutableModels;
  model?: Model<any>;
}

const INSIGHT_PROMPT = readFileSync(
  fileURLToPath(new URL("./prompts/insight.md", import.meta.url)),
  "utf8",
);

interface ActionWithReceipt {
  id: string;
  thread_id: string;
  contact_id: string | null;
  type: string;
  payload: ActionPayload;
  evidence_ids: string[];
  receipt_status: string;
  actual_result: unknown;
}

export interface InsightResult {
  status: "ok" | "failed" | "skipped";
  insightId?: string;
  memoryItemId?: string;
  error?: string;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseJson(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("模型没有返回 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function stripPrefix(id: string): { kind: "evidence" | "action" | "message"; id: string } {
  if (id.startsWith("act_")) return { kind: "action", id: id.slice(4) };
  if (id.startsWith("msg_")) return { kind: "message", id: id.slice(4) };
  if (id.startsWith("ev_")) return { kind: "evidence", id: id.slice(3) };
  return { kind: "evidence", id };
}

async function evidenceBelongsToContact(
  db: Db,
  evidenceId: string,
  contactId: string,
  threadId: string,
): Promise<boolean> {
  const result = await db.query<{ contact_id: string | null; thread_id: string | null }>(
    `WITH RECURSIVE grp AS (
       SELECT id FROM contacts WHERE id = $2
       UNION ALL
       SELECT c.id FROM contacts c JOIN grp g ON c.merged_into_id = g.id
     )
     SELECT e.contact_id, e.thread_id FROM evidence e
     WHERE e.id = $1 AND (e.contact_id IN (SELECT id FROM grp) OR e.thread_id = $3)`,
    [evidenceId, contactId, threadId],
  );
  return Boolean(result.rows[0]);
}

async function validateIds(
  db: Db,
  contactId: string,
  threadId: string,
  evidenceIds: string[],
  sourceIds: string[],
): Promise<string[]> {
  const invalid: string[] = [];

  for (const id of evidenceIds) {
    if (!(await evidenceBelongsToContact(db, id, contactId, threadId))) invalid.push(id);
  }

  for (const raw of sourceIds) {
    const ref = stripPrefix(raw);
    if (ref.kind === "evidence") {
      if (!(await evidenceBelongsToContact(db, ref.id, contactId, threadId))) invalid.push(raw);
    } else if (ref.kind === "action") {
      const result = await db.query(
        `SELECT 1 FROM actions a JOIN threads t ON t.id = a.thread_id
         WHERE a.id = $1 AND t.id = $2`,
        [ref.id, threadId],
      );
      if (!result.rows[0]) invalid.push(raw);
    } else {
      const result = await db.query(
        `SELECT 1 FROM messages m WHERE m.id = $1 AND m.thread_id = $2`,
        [ref.id, threadId],
      );
      if (!result.rows[0]) invalid.push(raw);
    }
  }

  return [...new Set(invalid)];
}

function contactIdsForAction(action: ActionWithReceipt): string[] {
  if (action.type === "create_event") {
    const payload = action.payload as Extract<ActionPayload, { type: "create_event" }>;
    return payload.contactIds;
  }
  if (action.type === "merge_contacts") {
    const payload = action.payload as Extract<ActionPayload, { type: "merge_contacts" }>;
    return [payload.targetContactId];
  }
  return action.contact_id ? [action.contact_id] : [];
}

async function generateForContact(
  db: Db,
  action: ActionWithReceipt,
  contactId: string,
  overrides: InsightModelOverrides = {},
): Promise<InsightResult> {
  const snapshot = await assembleSnapshot(db, {
    contactId,
    threadId: action.thread_id,
  });

  const userPrompt = [
    "# Action",
    JSON.stringify(
      {
        id: action.id,
        type: action.type,
        payload: action.payload,
        evidenceIds: action.evidence_ids,
      },
      null,
      2,
    ),
    "",
    "# Receipt",
    JSON.stringify({ status: action.receipt_status, actualResult: action.actual_result }, null, 2),
    "",
    "# MemorySnapshot（执行前）",
    snapshot.rendered,
  ].join("\n");

  const models = overrides.models ?? getModels();
  const model = overrides.model ?? getMainModel();
  const response = await models.completeSimple(model, {
    systemPrompt: INSIGHT_PROMPT,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  });

  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "Insight 模型调用失败");
  }
  const raw = extractText(response.content as Array<{ type: string; text?: string }>);
  const parsed = insightOutputSchema.parse(parseJson(raw));

  const invalid = await validateIds(
    db,
    contactId,
    action.thread_id,
    parsed.insight?.evidenceIds ?? [],
    parsed.insight?.sourceIds ?? [],
  );
  if (invalid.length) {
    throw new Error(`Insight 引用了不存在或跨人物的来源：${invalid.join(", ")}`);
  }

  const invalidDraft = await validateIds(
    db,
    contactId,
    action.thread_id,
    parsed.memoryDraft?.evidenceIds ?? [],
    [],
  );
  if (invalidDraft.length) {
    throw new Error(`memoryDraft 引用了不存在或跨人物的来源：${invalidDraft.join(", ")}`);
  }

  if (!parsed.insight && !parsed.memoryDraft) return { status: "ok" };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let insightId: string | undefined;
    if (parsed.insight) {
      const recheckAt = parsed.insight.recheckAt
        ? new Date(parsed.insight.recheckAt)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO insights
           (contact_id, action_id, content, confidence, status, evidence_ids, source_ids, recheck_at)
         VALUES ($1, $2, $3, $4, 'active', $5::uuid[], $6::text[], $7)
         ON CONFLICT (action_id, contact_id) WHERE action_id IS NOT NULL
         DO UPDATE SET content = EXCLUDED.content,
                       confidence = EXCLUDED.confidence,
                       evidence_ids = EXCLUDED.evidence_ids,
                       source_ids = EXCLUDED.source_ids,
                       recheck_at = EXCLUDED.recheck_at
         RETURNING id`,
        [
          contactId,
          action.id,
          parsed.insight.content,
          parsed.insight.confidence,
          parsed.insight.evidenceIds,
          parsed.insight.sourceIds,
          recheckAt,
        ],
      );
      insightId = inserted.rows[0]?.id;
    }

    let memoryItemId: string | undefined;
    if (parsed.memoryDraft) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (contact_id, kind, content, status, confidence, evidence_ids, source_insight_id)
         VALUES ($1, 'insight_draft', $2, 'candidate', 'medium', $3::uuid[], $4)
         RETURNING id`,
        [contactId, parsed.memoryDraft.content, parsed.memoryDraft.evidenceIds, insightId ?? null],
      );
      memoryItemId = inserted.rows[0]?.id;
    }

    await client.query("COMMIT");
    return { status: "ok", insightId, memoryItemId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Action 确认、receipt 提交后调用。
 * 失败不回滚 Action；返回 failed 让调用方在回执里标注。
 */
export async function runInsightForAction(
  db: Db,
  actionId: string,
  overrides: InsightModelOverrides = {},
): Promise<InsightResult[]> {
  const result = await db.query<ActionWithReceipt>(
    `SELECT a.id, a.thread_id, a.contact_id, a.type, a.payload, a.evidence_ids,
            r.status AS receipt_status, r.actual_result
     FROM actions a JOIN action_receipts r ON r.action_id = a.id
     WHERE a.id = $1`,
    [actionId],
  );
  const action = result.rows[0];
  if (!action) return [{ status: "skipped", error: "没有回执" }];

  const contacts = contactIdsForAction(action);
  if (!contacts.length) return [{ status: "skipped", error: "Action 没有关联联系人" }];

  const results: InsightResult[] = [];
  for (const contactId of [...new Set(contacts)]) {
    try {
      results.push(await generateForContact(db, action, contactId, overrides));
    } catch (error) {
      results.push({ status: "failed", error: (error as Error).message });
    }
  }
  return results;
}

export async function persistFailedInsight(
  client: PoolClient,
  actionId: string,
  error: string,
): Promise<void> {
  // 预留给“洞察失败也要留痕”的调用方；当前只写日志，不建伪洞察。
  void client;
  void actionId;
  void error;
}
