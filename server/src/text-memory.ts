import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./db/client.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { completeText } from "./util/llm.ts";

const MEMORY_PROMPT = readFileSync(
  fileURLToPath(new URL("./prompts/memory-document.md", import.meta.url)),
  "utf8",
);

export interface MemoryCandidate {
  id: string;
  contactId: string;
  kind: string;
  content: string;
  evidenceIds: string[];
  sourceInsightId: string | null;
  createdAt: Date;
}

export interface MemoryDocumentView {
  id: string;
  contactId: string;
  version: number;
  contentMarkdown: string;
  status: "draft" | "active" | "archived";
  basedOnVersion: number | null;
  evidenceIds: string[];
  createdAt: Date;
  approvedAt: Date | null;
}

async function assertContactOwner(db: Db, contactId: string, userId: string): Promise<void> {
  const result = await db.query(
    "SELECT 1 FROM contacts WHERE id = $1 AND user_id = $2",
    [contactId, userId],
  );
  if (!result.rows[0]) throw new NotFoundError("联系人不存在");
}

function mapDocument(row: {
  id: string;
  contact_id: string;
  version: number;
  content_markdown: string;
  status: "draft" | "active" | "archived";
  based_on_version: number | null;
  evidence_ids: string[];
  created_at: Date;
  approved_at: Date | null;
}): MemoryDocumentView {
  return {
    id: row.id,
    contactId: row.contact_id,
    version: row.version,
    contentMarkdown: row.content_markdown,
    status: row.status,
    basedOnVersion: row.based_on_version,
    evidenceIds: row.evidence_ids,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export async function listMemoryForContact(
  db: Db,
  contactId: string,
  userId: string,
): Promise<{
  candidates: MemoryCandidate[];
  confirmed: MemoryCandidate[];
  draft: MemoryDocumentView | null;
  active: MemoryDocumentView | null;
}> {
  await assertContactOwner(db, contactId, userId);

  const candidates = await db.query<{
    id: string;
    contact_id: string;
    kind: string;
    content: string;
    evidence_ids: string[];
    source_insight_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, contact_id, kind, content, evidence_ids, source_insight_id, created_at
     FROM memory_items
     WHERE contact_id = $1 AND status = 'candidate'
     ORDER BY created_at DESC`,
    [contactId],
  );
  const confirmed = await db.query<{
    id: string;
    contact_id: string;
    kind: string;
    content: string;
    evidence_ids: string[];
    source_insight_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, contact_id, kind, content, evidence_ids, source_insight_id, created_at
     FROM memory_items
     WHERE contact_id = $1 AND status = 'confirmed'
     ORDER BY created_at DESC LIMIT 50`,
    [contactId],
  );
  const draft = await db.query<Parameters<typeof mapDocument>[0]>(
    `SELECT id, contact_id, version, content_markdown, status, based_on_version,
            evidence_ids, created_at, approved_at
     FROM memory_documents
     WHERE contact_id = $1 AND status = 'draft'
     ORDER BY version DESC LIMIT 1`,
    [contactId],
  );
  const active = await db.query<Parameters<typeof mapDocument>[0]>(
    `SELECT id, contact_id, version, content_markdown, status, based_on_version,
            evidence_ids, created_at, approved_at
     FROM memory_documents
     WHERE contact_id = $1 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [contactId],
  );

  return {
    candidates: candidates.rows.map((row) => ({
      id: row.id,
      contactId: row.contact_id,
      kind: row.kind,
      content: row.content,
      evidenceIds: row.evidence_ids,
      sourceInsightId: row.source_insight_id,
      createdAt: row.created_at,
    })),
    confirmed: confirmed.rows.map((row) => ({
      id: row.id,
      contactId: row.contact_id,
      kind: row.kind,
      content: row.content,
      evidenceIds: row.evidence_ids,
      sourceInsightId: row.source_insight_id,
      createdAt: row.created_at,
    })),
    draft: draft.rows[0] ? mapDocument(draft.rows[0]) : null,
    active: active.rows[0] ? mapDocument(active.rows[0]) : null,
  };
}

export async function confirmMemoryItem(
  db: Db,
  memoryItemId: string,
  userId: string,
): Promise<{ id: string; status: "confirmed" }> {
  const result = await db.query<{ status: string; contact_id: string }>(
    `SELECT m.status, m.contact_id
     FROM memory_items m JOIN contacts c ON c.id = m.contact_id
     WHERE m.id = $1 AND c.user_id = $2`,
    [memoryItemId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("记忆项不存在");
  if (row.status === "confirmed") return { id: memoryItemId, status: "confirmed" };
  if (row.status !== "candidate") throw new ConflictError(`记忆项状态是 ${row.status}，不能确认`);

  await db.query(
    `UPDATE memory_items SET status = 'confirmed', confirmed_at = now() WHERE id = $1`,
    [memoryItemId],
  );
  return { id: memoryItemId, status: "confirmed" };
}

export async function rejectMemoryItem(
  db: Db,
  memoryItemId: string,
  userId: string,
): Promise<{ id: string; status: "rejected" }> {
  const result = await db.query<{ status: string }>(
    `SELECT m.status
     FROM memory_items m JOIN contacts c ON c.id = m.contact_id
     WHERE m.id = $1 AND c.user_id = $2`,
    [memoryItemId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("记忆项不存在");
  if (row.status === "rejected") return { id: memoryItemId, status: "rejected" };
  if (row.status !== "candidate") throw new ConflictError(`记忆项状态是 ${row.status}，不能拒绝`);

  await db.query("UPDATE memory_items SET status = 'rejected' WHERE id = $1", [memoryItemId]);
  return { id: memoryItemId, status: "rejected" };
}

function fallbackDocument(
  name: string,
  facts: Array<{ field: string; value: string }>,
  memories: Array<{ kind: string; content: string }>,
  insights: Array<{ content: string; confidence: string }>,
): string {
  const lines = [`# ${name}`, "", "## 基本信息"];
  if (!facts.length) lines.push("- （暂无）");
  for (const fact of facts) lines.push(`- ${fact.field}: ${fact.value}`);
  lines.push("", "## 重要记忆");
  if (!memories.length) lines.push("- （暂无）");
  for (const memory of memories) lines.push(`- [${memory.kind}] ${memory.content}`);
  lines.push("", "## 关系背景 / 推断");
  if (!insights.length) lines.push("- （暂无）");
  for (const insight of insights) lines.push(`- [${insight.confidence}] ${insight.content}`);
  return lines.join("\n");
}

export async function generateMemoryDraft(
  db: Db,
  contactId: string,
  userId: string,
  baseVersion?: number,
): Promise<MemoryDocumentView> {
  await assertContactOwner(db, contactId, userId);

  const contact = await db.query<{ display_name: string }>(
    "SELECT display_name FROM contacts WHERE id = $1",
    [contactId],
  );
  const facts = await db.query<{ field: string; value: string; evidence_ids: string[] }>(
    `SELECT field, value, evidence_ids FROM contact_facts
     WHERE contact_id = $1 AND status = 'confirmed'
     ORDER BY field`,
    [contactId],
  );
  const memories = await db.query<{
    kind: string;
    content: string;
    evidence_ids: string[];
  }>(
    `SELECT kind, content, evidence_ids FROM memory_items
     WHERE contact_id = $1 AND status = 'confirmed'
     ORDER BY created_at DESC LIMIT 30`,
    [contactId],
  );
  const insights = await db.query<{
    content: string;
    confidence: string;
    evidence_ids: string[];
  }>(
    `SELECT content, confidence, evidence_ids FROM insights
     WHERE contact_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 10`,
    [contactId],
  );
  const active = await db.query<{ version: number; content_markdown: string }>(
    `SELECT version, content_markdown FROM memory_documents
     WHERE contact_id = $1 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [contactId],
  );

  const activeVersion = active.rows[0]?.version ?? 0;
  if (baseVersion !== undefined && baseVersion !== activeVersion) {
    throw new ConflictError(`长期文档当前 version=${activeVersion}，请求基于 ${baseVersion}`);
  }

  const evidenceIds = [
    ...new Set([
      ...facts.rows.flatMap((row) => row.evidence_ids),
      ...memories.rows.flatMap((row) => row.evidence_ids),
      ...insights.rows.flatMap((row) => row.evidence_ids),
    ]),
  ];

  const name = contact.rows[0]?.display_name ?? "联系人";
  const input = [
    `# 联系人\n${name}`,
    `# 已确认事实\n${facts.rows.map((row) => `- ${row.field}: ${row.value}`).join("\n") || "（暂无）"}`,
    `# 已确认记忆\n${memories.rows.map((row) => `- [${row.kind}] ${row.content}`).join("\n") || "（暂无）"}`,
    `# 活跃洞察（推断）\n${insights.rows.map((row) => `- [${row.confidence}] ${row.content}`).join("\n") || "（暂无）"}`,
    `# 上一版文档\n${active.rows[0]?.content_markdown ?? "（无）"}`,
    `# 可用 evidence ids\n${evidenceIds.join(", ") || "（无）"}`,
  ].join("\n\n");

  let markdown: string;
  try {
    markdown = await completeText(MEMORY_PROMPT, input);
  } catch {
    // 模型不可用时至少给一个可读的确定性草案，不让整个审核流程挂掉。
    markdown = fallbackDocument(
      name,
      facts.rows,
      memories.rows,
      insights.rows,
    );
  }
  markdown = markdown.replace(/```markdown/gi, "").replace(/```/g, "").trim();

  const next = await db.query<{ version: number }>(
    "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM memory_documents WHERE contact_id = $1",
    [contactId],
  );
  const version = next.rows[0]?.version ?? 1;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE memory_documents SET status = 'archived' WHERE contact_id = $1 AND status = 'draft'",
      [contactId],
    );
    const inserted = await client.query<Parameters<typeof mapDocument>[0]>(
      `INSERT INTO memory_documents
         (contact_id, version, content_markdown, status, based_on_version, evidence_ids)
       VALUES ($1, $2, $3, 'draft', $4, $5::uuid[])
       RETURNING id, contact_id, version, content_markdown, status,
                 based_on_version, evidence_ids, created_at, approved_at`,
      [contactId, version, markdown, activeVersion, evidenceIds],
    );
    await client.query("COMMIT");
    const row = inserted.rows[0];
    if (!row) throw new Error("生成记忆文档失败");
    return mapDocument(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function approveMemoryDraft(
  db: Db,
  draftId: string,
  userId: string,
  baseVersion?: number,
): Promise<MemoryDocumentView> {
  const draftResult = await db.query<Parameters<typeof mapDocument>[0]>(
    `SELECT d.id, d.contact_id, d.version, d.content_markdown, d.status,
            d.based_on_version, d.evidence_ids, d.created_at, d.approved_at
     FROM memory_documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.id = $1 AND c.user_id = $2`,
    [draftId, userId],
  );
  const draft = draftResult.rows[0];
  if (!draft) throw new NotFoundError("记忆文档不存在");
  if (draft.status === "active") return mapDocument(draft);
  if (draft.status !== "draft") throw new ConflictError(`文档状态是 ${draft.status}，不能批准`);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const active = await client.query<{ version: number }>(
      `SELECT version FROM memory_documents
       WHERE contact_id = $1 AND status = 'active'
       ORDER BY version DESC LIMIT 1
       FOR UPDATE`,
      [draft.contact_id],
    );
    const activeVersion = active.rows[0]?.version ?? 0;
    if (baseVersion !== undefined && baseVersion !== activeVersion) {
      throw new ConflictError(`长期文档当前 version=${activeVersion}，请求基于 ${baseVersion}`);
    }
    if (draft.based_on_version !== null && draft.based_on_version !== activeVersion) {
      throw new ConflictError(
        `草案基于 v${draft.based_on_version}，但当前 active 是 v${activeVersion}；请重新生成草案`,
      );
    }

    await client.query(
      `UPDATE memory_documents SET status = 'archived'
       WHERE contact_id = $1 AND status = 'active'`,
      [draft.contact_id],
    );
    const updated = await client.query<Parameters<typeof mapDocument>[0]>(
      `UPDATE memory_documents
       SET status = 'active', approved_at = now()
       WHERE id = $1
       RETURNING id, contact_id, version, content_markdown, status,
                 based_on_version, evidence_ids, created_at, approved_at`,
      [draftId],
    );
    await client.query("COMMIT");
    const row = updated.rows[0];
    if (!row) throw new Error("批准记忆文档失败");
    return mapDocument(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectMemoryDraft(
  db: Db,
  draftId: string,
  userId: string,
): Promise<{ id: string; status: "archived" }> {
  const result = await db.query<{ status: string }>(
    `SELECT d.status FROM memory_documents d JOIN contacts c ON c.id = d.contact_id
     WHERE d.id = $1 AND c.user_id = $2`,
    [draftId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("记忆文档不存在");
  if (row.status !== "draft") throw new ConflictError(`文档状态是 ${row.status}，不能驳回`);
  await db.query("UPDATE memory_documents SET status = 'archived' WHERE id = $1", [draftId]);
  return { id: draftId, status: "archived" };
}
