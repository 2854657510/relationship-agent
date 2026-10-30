import type { PoolClient } from "pg";
import type { ActionPayload } from "../domain.ts";
import { ConflictError } from "../errors.ts";

type CreateContact = Extract<ActionPayload, { type: "create_contact" }>;
type UpdateContact = Extract<ActionPayload, { type: "update_contact" }>;
type MergeContacts = Extract<ActionPayload, { type: "merge_contacts" }>;

const FACT_FIELDS = ["company", "title", "phone", "email", "notes"] as const;

async function replaceFact(
  client: PoolClient,
  contactId: string,
  field: string,
  value: string,
  evidenceIds: string[],
): Promise<void> {
  await client.query(
    `UPDATE contact_facts
     SET status = 'superseded', updated_at = now()
     WHERE contact_id = $1 AND field = $2 AND status = 'confirmed'`,
    [contactId, field],
  );
  await client.query(
    `INSERT INTO contact_facts (contact_id, field, value, status, confidence, evidence_ids)
     VALUES ($1, $2, $3, 'confirmed', 'medium', $4::uuid[])`,
    [contactId, field, value, evidenceIds],
  );
}

export async function createContact(
  client: PoolClient,
  payload: CreateContact,
  evidenceIds: string[],
): Promise<{ contactId: string; version: number }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO contacts (display_name, version, status)
     VALUES ($1, 1, 'active') RETURNING id`,
    [payload.displayName],
  );
  const contactId = inserted.rows[0]?.id;
  if (!contactId) throw new Error("创建联系人失败");

  for (const field of FACT_FIELDS) {
    const value = payload[field];
    if (value) {
      await client.query(
        `INSERT INTO contact_facts (contact_id, field, value, status, confidence, evidence_ids)
         VALUES ($1, $2, $3, 'confirmed', 'medium', $4::uuid[])`,
        [contactId, field, value, evidenceIds],
      );
    }
  }
  return { contactId, version: 1 };
}

export async function updateContact(
  client: PoolClient,
  payload: UpdateContact,
  evidenceIds: string[],
): Promise<{ contactId: string; version: number }> {
  const baseVersion = payload.baseVersion;
  if (baseVersion === undefined) throw new Error("缺少 baseVersion");

  const updated = await client.query<{ version: number }>(
    `UPDATE contacts
     SET display_name = COALESCE($2, display_name),
         version = version + 1,
         updated_at = now()
     WHERE id = $1 AND version = $3 AND status = 'active'
     RETURNING version`,
    [payload.contactId, payload.patch.displayName ?? null, baseVersion],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new ConflictError(
      "联系人已被修改（version 不匹配），请重新读取后再确认",
    );
  }

  for (const field of FACT_FIELDS) {
    const value = payload.patch[field];
    if (value !== undefined) {
      await replaceFact(client, payload.contactId, field, value, evidenceIds);
    }
  }

  return { contactId: payload.contactId, version: row.version };
}

export async function mergeContacts(
  client: PoolClient,
  payload: MergeContacts,
  evidenceIds: string[],
): Promise<{ contactId: string; version: number; mergedCount: number }> {
  const baseVersion = payload.baseVersion;
  if (baseVersion === undefined) throw new Error("缺少 baseVersion");
  if (payload.sourceContactIds.includes(payload.targetContactId)) {
    throw new Error("不能把联系人合并到自己");
  }

  const target = await client.query<{ version: number }>(
    `UPDATE contacts SET version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2 AND status = 'active'
     RETURNING version`,
    [payload.targetContactId, baseVersion],
  );
  if (!target.rows[0]) {
    throw new ConflictError("目标联系人已被修改（version 不匹配），请重新读取后再确认");
  }

  const merged = await client.query<{ id: string }>(
    `UPDATE contacts
     SET status = 'merged', merged_into_id = $1, merged_at = now(), updated_at = now()
     WHERE id = ANY($2::uuid[]) AND status = 'active'
     RETURNING id`,
    [payload.targetContactId, payload.sourceContactIds],
  );
  if (merged.rows.length !== new Set(payload.sourceContactIds).size) {
    throw new ConflictError("部分源联系人已被合并或状态不一致，请重新读取");
  }

  for (const [field, value] of Object.entries(payload.fieldChoices)) {
    if (!value) continue;
    await replaceFact(client, payload.targetContactId, field, value, evidenceIds);
    await client.query(
      `UPDATE contact_facts
       SET status = 'superseded', updated_at = now()
       WHERE contact_id = ANY($1::uuid[]) AND field = $2 AND status = 'confirmed'`,
      [payload.sourceContactIds, field],
    );
  }

  // 源联系人的长期记忆文档归档；目标文档由 P4 的草案流程重新生成。
  await client.query(
    `UPDATE memory_documents SET status = 'archived'
     WHERE contact_id = ANY($1::uuid[]) AND status = 'active'`,
    [payload.sourceContactIds],
  );

  return {
    contactId: payload.targetContactId,
    version: target.rows[0].version,
    mergedCount: merged.rows.length,
  };
}
