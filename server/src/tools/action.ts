import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  actionPayloadSchema,
  actionTypes,
  type ActionPayload,
  type ToolContext,
} from "../domain.ts";
import { assertEvidenceIds, errorResult, textResult } from "./helpers.ts";

type Tool<S extends TSchema, D = unknown> = Omit<AgentTool<S, D>, "parameters">;

function tool<S extends TSchema, D = unknown>(schema: S, def: Tool<S, D>): AgentTool<any> {
  return { ...def, parameters: schema } as unknown as AgentTool<any>;
}

const proposeActionSchema = Type.Object({
  type: Type.Union(actionTypes.map((type) => Type.Literal(type))),
  payload: Type.Record(Type.String(), Type.Any()),
  rationale: Type.String({ minLength: 1, maxLength: 1000 }),
  evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
});

interface BaseVersionInfo {
  contactId: string | null;
  baseVersion: number | null;
  source: "model" | "server" | null;
}

async function activeContactVersion(ctx: ToolContext, contactId: string): Promise<number> {
  const result = await ctx.db.query<{ version: number; status: string }>(
    "SELECT version, status FROM contacts WHERE id = $1 AND user_id = $2",
    [contactId, ctx.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("联系人不存在");
  if (row.status !== "active") throw new Error("联系人已被合并，不能直接修改");
  return row.version;
}

async function eventInfo(
  ctx: ToolContext,
  eventId: string,
): Promise<{ version: number; contactId: string | null }> {
  const result = await ctx.db.query<{
    version: number;
    contact_ids: string[];
  }>(
    "SELECT version, contact_ids FROM calendar_events WHERE id = $1 AND user_id = $2",
    [eventId, ctx.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("日程不存在");
  return { version: row.version, contactId: row.contact_ids[0] ?? null };
}

async function resolveBaseVersion(
  ctx: ToolContext,
  payload: ActionPayload,
): Promise<BaseVersionInfo> {
  switch (payload.type) {
    case "create_contact":
    case "create_event":
      return { contactId: null, baseVersion: null, source: null };
    case "update_contact": {
      const current = await activeContactVersion(ctx, payload.contactId);
      if (payload.baseVersion !== undefined && payload.baseVersion !== current) {
        throw new Error(
          `stale_base_version: 联系人当前 version=${current}，提案里是 ${payload.baseVersion}，请重新读取后再提案`,
        );
      }
      return {
        contactId: payload.contactId,
        baseVersion: payload.baseVersion ?? current,
        source: payload.baseVersion === undefined ? "server" : "model",
      };
    }
    case "merge_contacts": {
      const current = await activeContactVersion(ctx, payload.targetContactId);
      if (payload.baseVersion !== undefined && payload.baseVersion !== current) {
        throw new Error(
          `stale_base_version: 目标联系人当前 version=${current}，提案里是 ${payload.baseVersion}`,
        );
      }
      return {
        contactId: payload.targetContactId,
        baseVersion: payload.baseVersion ?? current,
        source: payload.baseVersion === undefined ? "server" : "model",
      };
    }
    case "update_event":
    case "delete_event": {
      const info = await eventInfo(ctx, payload.eventId);
      if (payload.baseVersion !== undefined && payload.baseVersion !== info.version) {
        throw new Error(
          `stale_base_version: 日程当前 version=${info.version}，提案里是 ${payload.baseVersion}`,
        );
      }
      return {
        contactId: info.contactId,
        baseVersion: payload.baseVersion ?? info.version,
        source: payload.baseVersion === undefined ? "server" : "model",
      };
    }
  }
}

function withBaseVersion(payload: ActionPayload, baseVersion: number | null): ActionPayload {
  if (
    baseVersion !== null &&
    (payload.type === "update_contact" ||
      payload.type === "merge_contacts" ||
      payload.type === "update_event" ||
      payload.type === "delete_event")
  ) {
    return { ...payload, baseVersion };
  }
  return payload;
}

async function proposeAction(
  ctx: ToolContext,
  params: Static<typeof proposeActionSchema>,
) {
  const parsed = actionPayloadSchema.safeParse({ ...params.payload, type: params.type });
  if (!parsed.success) {
    return errorResult(
      `Action payload 不合法：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
    );
  }
  let payload = parsed.data;

  // 用户从某个联系人页面发起“约他”时，模型经常忘记带 contactIds。
  // 用 pageContext 的联系人补上，否则日程和洞察都不会挂到这个人身上。
  if (payload.type === "create_event" && payload.contactIds.length === 0 && ctx.contactId) {
    payload = { ...payload, contactIds: [ctx.contactId] };
  }

  let contactId = ctx.contactId;
  if (payload.type === "update_contact") contactId = payload.contactId;
  if (payload.type === "merge_contacts") contactId = payload.targetContactId;
  if (payload.type === "create_event") contactId = payload.contactIds[0] ?? ctx.contactId;

  const evidenceIds = params.evidenceIds?.length ? params.evidenceIds : ctx.evidenceIds;
  if (evidenceIds.length) {
    try {
      await assertEvidenceIds(ctx, evidenceIds, contactId);
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  let base: BaseVersionInfo;
  try {
    base = await resolveBaseVersion(ctx, payload);
  } catch (error) {
    return errorResult((error as Error).message);
  }
  if (base.contactId) contactId = base.contactId;
  if (payload.type === "update_contact" || payload.type === "merge_contacts") {
    contactId = base.contactId;
  }

  const storedPayload = withBaseVersion(payload, base.baseVersion);

  const inserted = await ctx.db.query<{ id: string }>(
    `INSERT INTO actions
       (thread_id, contact_id, type, payload, status, version,
        base_version, base_version_source, evidence_ids, rationale)
     VALUES ($1, $2, $3, $4, 'proposed', 1, $5, $6, $7::uuid[], $8)
     RETURNING id`,
    [
      ctx.threadId,
      contactId,
      storedPayload.type,
      JSON.stringify(storedPayload),
      base.baseVersion,
      base.source,
      evidenceIds,
      params.rationale,
    ],
  );
  const id = inserted.rows[0]?.id ?? "";
  ctx.terminal = { type: "action", id };

  return {
    content: [
      {
        type: "text" as const,
        text: `已生成 Action Card ${id}，等待用户确认。未确认前不会执行任何写入。`,
      },
    ],
    details: {
      actionId: id,
      type: storedPayload.type,
      payload: storedPayload,
      baseVersion: base.baseVersion,
      evidenceIds,
      rationale: params.rationale,
    },
    terminate: true,
  };
}

export function buildActionTool(ctx: ToolContext): AgentTool<any> {
  return tool(proposeActionSchema, {
    name: "propose_action",
    label: "行动提案",
    description:
      "生成一张 Action Card（创建/更新/合并联系人，创建/修改/删除日程）。这是终态工具；服务端只在用户确认后执行，未确认零写入。",
    execute: async (_id, params) => proposeAction(ctx, params),
  });
}

export function actionTextResult(id: string): ReturnType<typeof textResult> {
  return textResult(`已生成 Action ${id}`);
}
