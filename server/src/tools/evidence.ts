import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../domain.ts";
import { assertEvidenceIds, errorResult, textResult } from "./helpers.ts";

type Tool<S extends TSchema, D = unknown> = Omit<AgentTool<S, D>, "parameters">;

function tool<S extends TSchema, D = unknown>(schema: S, def: Tool<S, D>): AgentTool<any> {
  return { ...def, parameters: schema } as unknown as AgentTool<any>;
}

const screenshotSchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  extractedFields: Type.Optional(
    Type.Array(
      Type.Object({
        field: Type.String({ minLength: 1 }),
        value: Type.String({ minLength: 1 }),
      }),
      { maxItems: 20 },
    ),
  ),
  evidenceIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 4 })),
});

const candidateMemorySchema = Type.Object({
  contactId: Type.Optional(Type.String()),
  kind: Type.String({ minLength: 1, maxLength: 60 }),
  content: Type.String({ minLength: 1, maxLength: 1000 }),
  evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
});

const meetIntentSchema = Type.Object({
  contactId: Type.Optional(Type.String()),
  intent: Type.String({ minLength: 1, maxLength: 500 }),
  evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
});

async function recordScreenshot(
  ctx: ToolContext,
  params: Static<typeof screenshotSchema>,
) {
  const ids = params.evidenceIds?.length ? params.evidenceIds : ctx.evidenceIds;
  if (!ids.length) return errorResult("本轮没有截图证据可记录");

  const screenshots = await ctx.db.query<{ id: string }>(
    `SELECT id FROM evidence WHERE id = ANY($1::uuid[]) AND type = 'screenshot'`,
    [ids],
  );
  if (!screenshots.rows.length) return errorResult("当前证据里没有截图");

  const fields = params.extractedFields ?? [];
  await ctx.db.query(
    `UPDATE evidence
     SET source_summary = $2,
         metadata = metadata || jsonb_build_object(
           'understoodAt', now(),
           'extractedFields', $3::jsonb
         )
     WHERE id = ANY($1::uuid[]) AND type = 'screenshot'`,
    [screenshots.rows.map((row) => row.id), params.summary, JSON.stringify(fields)],
  );

  return textResult(
    `已记录截图理解，关联 ${screenshots.rows.length} 张截图。提取字段 ${fields.length} 个。`,
    { evidenceIds: screenshots.rows.map((row) => row.id), summary: params.summary, fields },
  );
}

async function recordCandidateMemory(
  ctx: ToolContext,
  params: Static<typeof candidateMemorySchema>,
) {
  const contactId = params.contactId ?? ctx.contactId;
  if (!contactId) return errorResult("需要指定联系人");
  const evidenceIds = params.evidenceIds?.length ? params.evidenceIds : ctx.evidenceIds;
  if (!evidenceIds.length) return errorResult("候选记忆必须带 evidenceId");

  try {
    await assertEvidenceIds(ctx, evidenceIds, contactId);
  } catch (error) {
    return errorResult((error as Error).message);
  }

  const inserted = await ctx.db.query<{ id: string }>(
    `INSERT INTO memory_items (contact_id, kind, content, status, confidence, evidence_ids)
     VALUES ($1, $2, $3, 'candidate', 'medium', $4::uuid[])
     RETURNING id`,
    [contactId, params.kind, params.content, evidenceIds],
  );
  const id = inserted.rows[0]?.id;
  return textResult(`已记录候选记忆 ${id}，等待用户确认。`, { id, evidenceIds });
}

async function recordMeetIntent(
  ctx: ToolContext,
  params: Static<typeof meetIntentSchema>,
) {
  const contactId = params.contactId ?? ctx.contactId;
  if (!contactId) return errorResult("需要指定联系人");
  const evidenceIds = params.evidenceIds?.length ? params.evidenceIds : ctx.evidenceIds;
  if (evidenceIds.length) {
    try {
      await assertEvidenceIds(ctx, evidenceIds, contactId);
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  const inserted = await ctx.db.query<{ id: string }>(
    `INSERT INTO meet_intents (contact_id, intent, status, evidence_ids)
     VALUES ($1, $2, 'candidate', $3::uuid[])
     RETURNING id`,
    [contactId, params.intent, evidenceIds],
  );
  return textResult(`已记录见面意图。`, {
    id: inserted.rows[0]?.id,
    evidenceIds,
  });
}

export function buildEvidenceTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    tool(screenshotSchema, {
      name: "record_screenshot_understanding",
      label: "记录截图理解",
      description:
        "把本轮截图的摘要和提取字段写入 evidence 的 source_summary/metadata。截图理解是候选，不是联系人事实。",
      execute: async (_id, params) => recordScreenshot(ctx, params),
    }),
    tool(candidateMemorySchema, {
      name: "record_candidate_memory",
      label: "记录候选记忆",
      description:
        "写一条待用户确认的候选记忆，必须带 evidenceId；不能直接写成已确认记忆。",
      execute: async (_id, params) => recordCandidateMemory(ctx, params),
    }),
    tool(meetIntentSchema, {
      name: "record_meet_intent",
      label: "记录见面意图",
      description: "记录“想见某人/想约某事”的候选意图，带 evidenceId。",
      execute: async (_id, params) => recordMeetIntent(ctx, params),
    }),
  ];
}
