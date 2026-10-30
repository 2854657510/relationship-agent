import { createEvent, deleteEvent, updateEvent } from "./adapters/calendar.ts";
import { createContact, mergeContacts, updateContact } from "./adapters/contacts.ts";
import type { Db } from "./db/client.ts";
import { actionPayloadSchema, type ActionPayload } from "./domain.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import {
  runInsightForAction,
  type InsightModelOverrides,
  type InsightResult,
} from "./insight-agent.ts";

interface ActionRecord {
  id: string;
  thread_id: string;
  contact_id: string | null;
  type: string;
  payload: unknown;
  status: string;
  version: number;
  base_version: number | null;
  evidence_ids: string[];
}

export interface ReceiptRecord {
  id: string;
  action_id: string;
  status: string;
  actual_result: unknown;
  error: string | null;
  receipt_at: Date;
}

export interface ConfirmActionResult {
  actionId: string;
  status: "executed";
  receipt: ReceiptRecord;
  insight: InsightResult[];
}

async function loadAction(db: Db, actionId: string, userId: string): Promise<ActionRecord> {
  const result = await db.query<ActionRecord>(
    `SELECT a.id, a.thread_id, a.contact_id, a.type, a.payload, a.status,
            a.version, a.base_version, a.evidence_ids
     FROM actions a JOIN threads t ON t.id = a.thread_id
     WHERE a.id = $1 AND t.user_id = $2`,
    [actionId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Action 不存在");
  return row;
}

async function loadReceipt(db: Db, actionId: string): Promise<ReceiptRecord | null> {
  const result = await db.query<ReceiptRecord>(
    `SELECT id, action_id, status, actual_result, error, receipt_at
     FROM action_receipts WHERE action_id = $1`,
    [actionId],
  );
  return result.rows[0] ?? null;
}

export async function confirmAction(
  db: Db,
  actionId: string,
  userId: string,
  overrides: InsightModelOverrides = {},
): Promise<ConfirmActionResult> {
  const action = await loadAction(db, actionId, userId);

  const existing = await loadReceipt(db, actionId);
  if (existing) {
    return { actionId, status: "executed", receipt: existing, insight: [] };
  }
  if (action.status === "rejected") throw new ConflictError("Action 已被拒绝");
  if (!["proposed", "confirmed"].includes(action.status)) {
    throw new ConflictError(`Action 当前状态是 ${action.status}，不能确认`);
  }

  const parsed = actionPayloadSchema.safeParse(action.payload);
  if (!parsed.success) {
    throw new ValidationError(`Action payload 不合法：${parsed.error.issues.map((i) => i.message).join("；")}`);
  }
  const payload: ActionPayload = parsed.data;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<ActionRecord>(
      `SELECT id, thread_id, contact_id, type, payload, status, version,
              base_version, evidence_ids
       FROM actions WHERE id = $1 FOR UPDATE`,
      [actionId],
    );
    const current = locked.rows[0];
    if (!current) throw new NotFoundError("Action 不存在");
    if (current.status === "executed") {
      await client.query("COMMIT");
      const receipt = await loadReceipt(db, actionId);
      if (!receipt) throw new Error("Action 已执行但缺少回执");
      return { actionId, status: "executed", receipt, insight: [] };
    }
    if (current.status === "rejected") throw new ConflictError("Action 已被拒绝");

    let actualResult: Record<string, unknown>;
    let createdContactId: string | null = null;

    switch (payload.type) {
      case "create_contact": {
        const result = await createContact(client, payload, current.evidence_ids);
        actualResult = result;
        createdContactId = result.contactId;
        break;
      }
      case "update_contact": {
        actualResult = await updateContact(client, payload, current.evidence_ids);
        break;
      }
      case "merge_contacts": {
        actualResult = await mergeContacts(client, payload, current.evidence_ids);
        break;
      }
      case "create_event": {
        actualResult = await createEvent(client, payload);
        break;
      }
      case "update_event": {
        actualResult = await updateEvent(client, payload);
        break;
      }
      case "delete_event": {
        actualResult = await deleteEvent(client, payload);
        break;
      }
    }

    if (createdContactId) {
      await client.query("UPDATE actions SET contact_id = $2 WHERE id = $1", [
        actionId,
        createdContactId,
      ]);
    }

    await client.query(
      `UPDATE actions
       SET status = 'executed', decided_at = now(), executed_at = now()
       WHERE id = $1`,
      [actionId],
    );
    const receiptInsert = await client.query<ReceiptRecord>(
      `INSERT INTO action_receipts (action_id, status, actual_result)
       VALUES ($1, 'success', $2)
       RETURNING id, action_id, status, actual_result, error, receipt_at`,
      [actionId, JSON.stringify(actualResult)],
    );
    await client.query("COMMIT");

    const receipt = receiptInsert.rows[0];
    if (!receipt) throw new Error("写回执失败");

    // 洞察在回执提交后同步执行；失败不回滚 Action。
    let insight: InsightResult[] = [];
    try {
      insight = await runInsightForAction(db, actionId, overrides);
    } catch (error) {
      insight = [{ status: "failed", error: (error as Error).message }];
    }

    return { actionId, status: "executed", receipt, insight };
  } catch (error) {
    await client.query("ROLLBACK");
    const isConflict = error instanceof ConflictError;
    await db.query(
      `UPDATE actions
       SET status = $2, decided_at = now()
       WHERE id = $1 AND status IN ('proposed', 'confirmed')`,
      [actionId, isConflict ? "conflict" : "failed"],
    );
    await db.query(
      `INSERT INTO action_receipts (action_id, status, actual_result, error)
       VALUES ($1, 'failed', '{}', $2)
       ON CONFLICT (action_id) DO NOTHING`,
      [actionId, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectAction(
  db: Db,
  actionId: string,
  userId: string,
): Promise<{ actionId: string; status: "rejected" }> {
  const action = await loadAction(db, actionId, userId);
  if (action.status === "executed") throw new ConflictError("Action 已执行，不能拒绝");
  if (action.status !== "proposed") {
    throw new ConflictError(`Action 当前状态是 ${action.status}，不能拒绝`);
  }
  await db.query(
    `UPDATE actions SET status = 'rejected', decided_at = now() WHERE id = $1`,
    [actionId],
  );
  return { actionId, status: "rejected" };
}

export async function getActionForUser(
  db: Db,
  actionId: string,
  userId: string,
): Promise<ActionRecord & { receipt: ReceiptRecord | null }> {
  const action = await loadAction(db, actionId, userId);
  return { ...action, receipt: await loadReceipt(db, actionId) };
}
