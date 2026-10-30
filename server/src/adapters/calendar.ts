import type { PoolClient } from "pg";
import type { ActionPayload } from "../domain.ts";
import { ConflictError } from "../errors.ts";

type CreateEvent = Extract<ActionPayload, { type: "create_event" }>;
type UpdateEvent = Extract<ActionPayload, { type: "update_event" }>;
type DeleteEvent = Extract<ActionPayload, { type: "delete_event" }>;

export async function createEvent(
  client: PoolClient,
  payload: CreateEvent,
): Promise<{ eventId: string; version: number }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO calendar_events
       (user_id, title, starts_at, ends_at, timezone, location, notes, contact_ids, version)
     VALUES ('local-user', $1, $2, $3, $4, $5, $6, $7::uuid[], 1)
     RETURNING id`,
    [
      payload.title,
      payload.startsAt,
      payload.endsAt,
      payload.timezone,
      payload.location ?? null,
      payload.notes ?? null,
      payload.contactIds,
    ],
  );
  const eventId = inserted.rows[0]?.id;
  if (!eventId) throw new Error("创建日程失败");
  return { eventId, version: 1 };
}

export async function updateEvent(
  client: PoolClient,
  payload: UpdateEvent,
): Promise<{ eventId: string; version: number }> {
  if (payload.baseVersion === undefined) throw new Error("缺少 baseVersion");

  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  const fieldMap: Array<[keyof typeof payload.patch, string]> = [
    ["title", "title"],
    ["startsAt", "starts_at"],
    ["endsAt", "ends_at"],
    ["timezone", "timezone"],
    ["location", "location"],
    ["notes", "notes"],
  ];
  for (const [key, column] of fieldMap) {
    if (payload.patch[key] !== undefined) {
      sets.push(`${column} = $${index++}`);
      values.push(payload.patch[key]);
    }
  }
  if (payload.patch.contactIds !== undefined) {
    sets.push(`contact_ids = $${index++}::uuid[]`);
    values.push(payload.patch.contactIds);
  }
  if (!sets.length) throw new Error("patch 不能为空");

  sets.push("version = version + 1", "updated_at = now()");
  values.push(payload.eventId, payload.baseVersion);

  const updated = await client.query<{ version: number }>(
    `UPDATE calendar_events SET ${sets.join(", ")}
     WHERE id = $${index++} AND version = $${index++}
     RETURNING version`,
    values,
  );
  const row = updated.rows[0];
  if (!row) throw new ConflictError("日程已被修改（version 不匹配），请重新读取后再确认");
  return { eventId: payload.eventId, version: row.version };
}

export async function deleteEvent(
  client: PoolClient,
  payload: DeleteEvent,
): Promise<{ eventId: string; version: number }> {
  if (payload.baseVersion === undefined) throw new Error("缺少 baseVersion");
  const deleted = await client.query<{ id: string }>(
    "DELETE FROM calendar_events WHERE id = $1 AND version = $2 RETURNING id",
    [payload.eventId, payload.baseVersion],
  );
  if (!deleted.rows[0]) {
    throw new ConflictError("日程已被修改或不存在（version 不匹配）");
  }
  return { eventId: payload.eventId, version: payload.baseVersion };
}
