import type { Db } from "../db/client.ts";
import {
  USER_ID,
  type ContactRow,
  type EvidenceRow,
  type MemorySnapshot,
} from "../domain.ts";

export const USER_TIMEZONE = "Asia/Shanghai";

interface FactRow {
  id: string;
  contact_id: string;
  field: string;
  value: string;
  status: string;
  evidence_ids: string[];
}

interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  evidence_ids: string[];
}

interface InsightRow {
  id: string;
  content: string;
  confidence: string;
  evidence_ids: string[];
}

interface GoalRow {
  id: string;
  description: string;
  evidence_ids: string[];
}

interface DocumentRow {
  version: number;
  content_markdown: string;
}

interface ActionRowLite {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  rationale: string | null;
}

export interface SnapshotResult {
  snapshot: MemorySnapshot;
  rendered: string;
}

async function resolveRootContactId(db: Db, contactId: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE up AS (
       SELECT id, merged_into_id FROM contacts WHERE id = $1
       UNION ALL
       SELECT c.id, c.merged_into_id
       FROM contacts c JOIN up u ON u.merged_into_id = c.id
     )
     SELECT id FROM up WHERE merged_into_id IS NULL LIMIT 1`,
    [contactId],
  );
  return result.rows[0]?.id ?? null;
}

async function contactGroupIds(db: Db, rootId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `WITH RECURSIVE grp AS (
       SELECT id FROM contacts WHERE id = $1
       UNION ALL
       SELECT c.id FROM contacts c JOIN grp g ON c.merged_into_id = g.id
     )
     SELECT id FROM grp`,
    [rootId],
  );
  return result.rows.map((row) => row.id);
}

function summarizeEvidence(row: EvidenceRow): string {
  const text = row.source_summary?.trim() || row.content?.trim() || "(无摘要)";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function assembleSnapshot(
  db: Db,
  options: { contactId: string | null; threadId: string; compactionSummary?: string },
): Promise<SnapshotResult> {
  const now = new Date();
  let contact: ContactRow | null = null;
  let mergedFrom: Array<{ id: string; displayName: string }> = [];
  let groupIds: string[] = [];

  if (options.contactId) {
    const rootId = await resolveRootContactId(db, options.contactId);
    if (rootId) {
      groupIds = await contactGroupIds(db, rootId);
      const contactResult = await db.query<ContactRow>(
        `SELECT id, user_id, display_name, version, status, merged_into_id, merged_at
         FROM contacts WHERE id = $1`,
        [rootId],
      );
      contact = contactResult.rows[0] ?? null;
      if (groupIds.length > 1) {
        const merged = await db.query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM contacts
           WHERE id = ANY($1::uuid[]) AND id <> $2 ORDER BY created_at`,
          [groupIds, rootId],
        );
        mergedFrom = merged.rows.map((row) => ({ id: row.id, displayName: row.display_name }));
      }
    }
  }

  const factsResult = groupIds.length
    ? await db.query<FactRow>(
        `SELECT id, contact_id, field, value, status, evidence_ids
         FROM contact_facts
         WHERE contact_id = ANY($1::uuid[]) AND status IN ('confirmed', 'candidate')
         ORDER BY field, created_at DESC`,
        [groupIds],
      )
    : { rows: [] as FactRow[] };

  const insightsResult = groupIds.length
    ? await db.query<InsightRow>(
        `SELECT id, content, confidence, evidence_ids
         FROM insights
         WHERE contact_id = ANY($1::uuid[]) AND status = 'active'
         ORDER BY created_at DESC LIMIT 10`,
        [groupIds],
      )
    : { rows: [] as InsightRow[] };

  const goalsResult = groupIds.length
    ? await db.query<GoalRow>(
        `SELECT id, description, evidence_ids
         FROM relationship_goals
         WHERE contact_id = ANY($1::uuid[]) AND status = 'active'
         ORDER BY created_at DESC`,
        [groupIds],
      )
    : { rows: [] as GoalRow[] };

  const documentResult = groupIds.length
    ? await db.query<DocumentRow>(
        `SELECT version, content_markdown FROM memory_documents
         WHERE contact_id = ANY($1::uuid[]) AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
        [groupIds],
      )
    : { rows: [] as DocumentRow[] };

  const evidenceResult = await db.query<EvidenceRow>(
    `SELECT id, type, contact_id, content, storage_path, mime_type, sha256,
            source_summary, captured_at, expires_at
     FROM evidence
     WHERE (contact_id = ANY($1::uuid[]) OR thread_id = $2)
     ORDER BY captured_at DESC
     LIMIT 20`,
    [groupIds, options.threadId],
  );

  const actionsResult = await db.query<ActionRowLite>(
    `SELECT id, type, status, payload, rationale
     FROM actions WHERE thread_id = $1
     ORDER BY created_at DESC LIMIT 5`,
    [options.threadId],
  );

  const confirmedFacts = factsResult.rows.filter((row) => row.status === "confirmed");
  const candidateFacts = factsResult.rows.filter((row) => row.status === "candidate");

  const byField = new Map<string, FactRow[]>();
  for (const fact of confirmedFacts) {
    const list = byField.get(fact.field) ?? [];
    list.push(fact);
    byField.set(fact.field, list);
  }
  const conflicts = [...byField.entries()]
    .map(([field, rows]) => ({
      field,
      values: [...new Set(rows.map((row) => row.value))],
      evidenceIds: rows.flatMap((row) => row.evidence_ids),
    }))
    .filter((item) => item.values.length > 1);

  // 候选/已确认分开查，避免把 confirmed 混进 candidates。
  const candidateMemoryResult = groupIds.length
    ? await db.query<MemoryRow>(
        `SELECT id, kind, content, evidence_ids
         FROM memory_items
         WHERE contact_id = ANY($1::uuid[]) AND status = 'candidate'
         ORDER BY created_at DESC LIMIT 10`,
        [groupIds],
      )
    : { rows: [] as MemoryRow[] };
  const confirmedMemoryResult = groupIds.length
    ? await db.query<MemoryRow>(
        `SELECT id, kind, content, evidence_ids
         FROM memory_items
         WHERE contact_id = ANY($1::uuid[]) AND status = 'confirmed'
         ORDER BY created_at DESC LIMIT 10`,
        [groupIds],
      )
    : { rows: [] as MemoryRow[] };

  const snapshot: MemorySnapshot = {
    now: now.toISOString(),
    timezone: USER_TIMEZONE,
    contact: contact
      ? {
          id: contact.id,
          displayName: contact.display_name,
          version: contact.version,
          facts: confirmedFacts.map((row) => ({
            field: row.field,
            value: row.value,
            status: row.status,
            evidenceIds: row.evidence_ids,
          })),
          mergedFrom,
        }
      : null,
    evidence: evidenceResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      summary: summarizeEvidence(row),
      capturedAt: row.captured_at.toISOString(),
      expired: Boolean(row.expires_at && row.expires_at.getTime() < now.getTime()),
    })),
    candidates: [
      ...candidateFacts.map((row) => ({
        id: row.id,
        kind: `fact:${row.field}`,
        content: row.value,
        evidenceIds: row.evidence_ids,
      })),
      ...candidateMemoryResult.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        content: row.content,
        evidenceIds: row.evidence_ids,
      })),
    ],
    conflicts,
    goals: goalsResult.rows.map((row) => ({
      id: row.id,
      description: row.description,
      evidenceIds: row.evidence_ids,
    })),
    insights: insightsResult.rows.map((row) => ({
      id: row.id,
      content: row.content,
      confidence: row.confidence,
      evidenceIds: row.evidence_ids,
    })),
    confirmedMemories: confirmedMemoryResult.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      evidenceIds: row.evidence_ids,
    })),
    memoryDocument: documentResult.rows[0]
      ? {
          version: documentResult.rows[0].version,
          contentMarkdown: documentResult.rows[0].content_markdown,
        }
      : null,
    actions: actionsResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      summary: row.rationale ?? row.type,
    })),
    thread: { id: options.threadId, compactionSummary: options.compactionSummary },
  };

  return { snapshot, rendered: renderSnapshot(snapshot) };
}

export function renderSnapshot(snapshot: MemorySnapshot): string {
  const lines: string[] = [];
  lines.push(`# 当前时间`);
  lines.push(`${snapshot.now}（时区 ${snapshot.timezone}）`);
  lines.push("");

  if (!snapshot.contact) {
    lines.push("# 当前联系人");
    lines.push("本轮没有指定联系人。不要注入任何联系人专属资料；需要时先问用户是谁。");
  } else {
    lines.push(`# 当前联系人`);
    lines.push(
      `- ${snapshot.contact.displayName}（id=${snapshot.contact.id}, version=${snapshot.contact.version}）`,
    );
    if (snapshot.contact.mergedFrom.length) {
      lines.push(
        `- 已合并：${snapshot.contact.mergedFrom.map((item) => item.displayName).join("、")}`,
      );
    }
    lines.push("");
    lines.push("## 已确认结构化事实");
    if (!snapshot.contact.facts.length) lines.push("- （暂无）");
    for (const fact of snapshot.contact.facts) {
      const refs = fact.evidenceIds.length ? ` [${fact.evidenceIds.join(",")}]` : "";
      lines.push(`- ${fact.field}: ${fact.value}${refs}`);
    }
  }
  lines.push("");

  if (snapshot.conflicts.length) {
    lines.push("## 事实冲突（不要擅自选一个）");
    for (const conflict of snapshot.conflicts) {
      lines.push(
        `- ${conflict.field}: ${conflict.values.join(" / ")} [${conflict.evidenceIds.join(",")}]`,
      );
    }
    lines.push("");
  }

  if (snapshot.candidates.length) {
    lines.push("## 候选事实 / 待确认记忆");
    for (const item of snapshot.candidates.slice(0, 10)) {
      lines.push(
        `- ${item.kind}: ${truncate(item.content, 160)} [${item.evidenceIds.join(",") || "无来源"}]`,
      );
    }
    lines.push("");
  }

  if (snapshot.goals.length) {
    lines.push("## 活跃关系目标");
    for (const goal of snapshot.goals) {
      lines.push(`- ${goal.description} [${goal.evidenceIds.join(",") || "无来源"}]`);
    }
    lines.push("");
  }

  if (snapshot.insights.length) {
    lines.push("## 有效洞察（推断，不是事实）");
    for (const insight of snapshot.insights) {
      lines.push(
        `- (${insight.confidence}) ${truncate(insight.content, 200)} [${insight.evidenceIds.join(",")}]`,
      );
    }
    lines.push("");
  }

  if (snapshot.confirmedMemories.length) {
    lines.push("## 已确认长期记忆");
    for (const memory of snapshot.confirmedMemories) {
      lines.push(
        `- ${memory.kind}: ${truncate(memory.content, 200)} [${memory.evidenceIds.join(",") || "无来源"}]`,
      );
    }
    lines.push("");
  }

  if (snapshot.memoryDocument) {
    lines.push(`## 长期记忆文档（v${snapshot.memoryDocument.version}）`);
    lines.push(truncate(snapshot.memoryDocument.contentMarkdown, 2_000));
    lines.push("");
  }

  if (snapshot.actions.length) {
    lines.push("## 当前会话最近的 Action");
    for (const action of snapshot.actions) {
      lines.push(`- ${action.id} ${action.type} / ${action.status}：${truncate(action.summary, 120)}`);
    }
    lines.push("");
  }

  lines.push("## 相关证据（只能引用这里出现的 id）");
  if (!snapshot.evidence.length) lines.push("- （暂无）");
  for (const evidence of snapshot.evidence.slice(0, 15)) {
    const expired = evidence.expired ? "，已过期，仅摘要可用" : "";
    lines.push(
      `- ${evidence.id} (${evidence.type}, ${evidence.capturedAt}${expired}): ${evidence.summary}`,
    );
  }

  return lines.join("\n");
}
