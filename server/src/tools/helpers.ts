import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Db } from "../db/client.ts";
import type { ToolContext } from "../domain.ts";

export function textResult(text: string, details: unknown = {}): AgentToolResult {
  return { content: [{ type: "text", text }], details: details as JsonValue };
}

export function errorResult(text: string, details: unknown = {}): AgentToolResult {
  return { content: [{ type: "text", text }], details: details as JsonValue, isError: true };
}

export async function resolveContactRoot(db: Db, contactId: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE up AS (
       SELECT id, merged_into_id FROM contacts WHERE id = $1
       UNION ALL
       SELECT c.id, c.merged_into_id FROM contacts c JOIN up u ON u.merged_into_id = c.id
     )
     SELECT id FROM up WHERE merged_into_id IS NULL LIMIT 1`,
    [contactId],
  );
  return result.rows[0]?.id ?? null;
}

export async function getContactGroupIds(db: Db, contactId: string): Promise<string[]> {
  const root = await resolveContactRoot(db, contactId);
  if (!root) return [];
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE grp AS (
       SELECT id FROM contacts WHERE id = $1
       UNION ALL
       SELECT c.id FROM contacts c JOIN grp g ON c.merged_into_id = g.id
     )
     SELECT id FROM grp`,
    [root],
  );
  return result.rows.map((row) => row.id);
}

export async function requireContactRoot(db: Db, contactId: string): Promise<string> {
  const root = await resolveContactRoot(db, contactId);
  if (!root) throw new Error("联系人不存在");
  return root;
}

export async function assertContactBelongsToGroup(
  db: Db,
  contactId: string,
  groupIds: string[],
): Promise<void> {
  const root = await requireContactRoot(db, contactId);
  if (!groupIds.includes(root)) throw new Error("联系人不在当前范围内");
}

export async function assertEvidenceIds(
  ctx: ToolContext,
  ids: string[],
  contactId: string | null,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new Error("至少需要一个 evidenceId");
  const result = await ctx.db.query<{
    id: string;
    contact_id: string | null;
    thread_id: string | null;
  }>("SELECT id, contact_id, thread_id FROM evidence WHERE id = ANY($1::uuid[])", [unique]);
  if (result.rows.length !== unique.length) throw new Error("引用了不存在的 evidenceId");

  const group = contactId ? await getContactGroupIds(ctx.db, contactId) : [];
  for (const row of result.rows) {
    const belongsToContact = row.contact_id !== null && group.includes(row.contact_id);
    const belongsToThread = row.contact_id === null && row.thread_id === ctx.threadId;
    if (!belongsToContact && !belongsToThread) {
      throw new Error("evidenceId 不属于当前联系人/会话");
    }
  }
}

export function formatLocalTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function iso(date: Date): string {
  return date.toISOString();
}
