import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../domain.ts";
import { assembleSnapshot } from "../memory/snapshot.ts";
import { errorResult, formatLocalTime, iso, textResult } from "./helpers.ts";

type Tool<S extends TSchema, D = unknown> = Omit<AgentTool<S, D>, "parameters">;

function tool<S extends TSchema, D = unknown>(schema: S, def: Tool<S, D>): AgentTool<any> {
  return { ...def, parameters: schema } as unknown as AgentTool<any>;
}

const searchContactsSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 100 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

const contactIdSchema = Type.Object({
  contactId: Type.String({ minLength: 1 }),
});

const calendarRangeSchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  contactId: Type.Optional(Type.String()),
});

const freeSlotsSchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  durationMinutes: Type.Integer({ minimum: 15, maximum: 480 }),
});

const briefSchema = Type.Object({
  contactId: Type.String({ minLength: 1 }),
  calendarEventId: Type.Optional(Type.String()),
});

const meetIntentSchema = Type.Object({
  contactId: Type.Optional(Type.String()),
});

type CalendarRow = {
  id: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  location: string | null;
  contact_ids: string[];
  version: number;
};

async function searchContacts(
  ctx: ToolContext,
  params: Static<typeof searchContactsSchema>,
) {
  const limit = params.limit ?? 10;
  const result = await ctx.db.query<{ id: string; display_name: string; version: number }>(
    `SELECT id, display_name, version
     FROM contacts
     WHERE user_id = $1 AND status = 'active'
       AND (display_name ILIKE '%' || $2 || '%' OR id::text = $2)
     ORDER BY display_name
     LIMIT $3`,
    [ctx.userId, params.query, limit],
  );
  if (!result.rows.length) {
    return textResult(`没有找到匹配“${params.query}”的联系人。`, { contacts: [] });
  }
  const lines = result.rows.map(
    (row) => `- ${row.display_name}（id=${row.id}, version=${row.version}）`,
  );
  return textResult(`找到 ${result.rows.length} 个联系人：\n${lines.join("\n")}`, {
    contacts: result.rows,
  });
}

async function getContactProfile(
  ctx: ToolContext,
  params: Static<typeof contactIdSchema>,
) {
  const { snapshot, rendered } = await assembleSnapshot(ctx.db, {
    contactId: params.contactId,
    threadId: ctx.threadId,
  });
  if (!snapshot.contact) return errorResult("联系人不存在");
  return textResult(rendered, snapshot);
}

async function listCalendarEvents(
  ctx: ToolContext,
  params: Static<typeof calendarRangeSchema>,
) {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return errorResult("时间范围不合法");
  }
  const result = await ctx.db.query<CalendarRow>(
    `SELECT id, title, starts_at, ends_at, timezone, location, contact_ids, version
     FROM calendar_events
     WHERE user_id = $1 AND starts_at < $3 AND ends_at > $2
       AND ($4::uuid IS NULL OR $4 = ANY(contact_ids))
     ORDER BY starts_at`,
    [ctx.userId, from.toISOString(), to.toISOString(), params.contactId ?? null],
  );
  if (!result.rows.length) {
    return textResult("这个时间范围内没有日程。", { events: [] });
  }
  const lines = result.rows.map(
    (row) =>
      `- ${row.id} v${row.version}：${row.title}，${formatLocalTime(row.starts_at)}–${formatLocalTime(row.ends_at)}，${row.timezone}${row.location ? `，${row.location}` : ""}`,
  );
  return textResult(`共 ${result.rows.length} 个日程：\n${lines.join("\n")}`, {
    events: result.rows,
  });
}

async function findFreeSlots(
  ctx: ToolContext,
  params: Static<typeof freeSlotsSchema>,
) {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return errorResult("时间范围不合法");
  }
  if (to.getTime() - from.getTime() > 14 * 24 * 60 * 60 * 1000) {
    return errorResult("一次最多查 14 天");
  }

  const events = await ctx.db.query<CalendarRow>(
    `SELECT id, title, starts_at, ends_at, timezone, location, contact_ids, version
     FROM calendar_events
     WHERE user_id = $1 AND starts_at < $3 AND ends_at > $2
     ORDER BY starts_at`,
    [ctx.userId, from.toISOString(), to.toISOString()],
  );

  const duration = params.durationMinutes * 60 * 1000;
  const slots: Array<{ start: Date; end: Date }> = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);

  while (cursor <= to && slots.length < 8) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      for (const hour of [9, 10, 11, 14, 15, 16]) {
        const start = new Date(cursor);
        start.setHours(hour, 0, 0, 0);
        const end = new Date(start.getTime() + duration);
        if (start < from || end > to) continue;
        const overlaps = events.rows.some(
          (event) => start < event.ends_at && end > event.starts_at,
        );
        if (!overlaps) slots.push({ start, end });
        if (slots.length >= 8) break;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (!slots.length) return textResult("这个范围内没有找到可用空档。", { slots: [] });
  const lines = slots.map(
    (slot) => `- ${formatLocalTime(slot.start)}–${formatLocalTime(slot.end)}（${iso(slot.start)}）`,
  );
  return textResult(`可用空档：\n${lines.join("\n")}`, {
    slots: slots.map((slot) => ({ start: iso(slot.start), end: iso(slot.end) })),
  });
}

async function meetingBrief(ctx: ToolContext, params: Static<typeof briefSchema>) {
  const { snapshot, rendered } = await assembleSnapshot(ctx.db, {
    contactId: params.contactId,
    threadId: ctx.threadId,
  });
  if (!snapshot.contact) return errorResult("联系人不存在");

  const facts = snapshot.contact.facts
    .slice(0, 8)
    .map((fact) => `${fact.field}=${fact.value}`)
    .join("；");
  const insights = snapshot.insights.map((item) => item.content).join("；");
  const goals = snapshot.goals.map((item) => item.description).join("；");
  const recent = snapshot.evidence
    .slice(0, 3)
    .map((item) => item.summary)
    .join("；");

  const brief = [
    `会前简报：${snapshot.contact.displayName}`,
    facts ? `- 事实：${facts}` : "- 事实：暂无",
    goals ? `- 关系目标：${goals}` : "- 关系目标：暂无",
    insights ? `- 洞察（推断）：${insights}` : "- 洞察：暂无",
    recent ? `- 最近证据：${recent}` : "- 最近证据：暂无",
    params.calendarEventId ? `- 关联日程：${params.calendarEventId}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return textResult(brief, { brief, snapshot: rendered });
}

async function listMeetIntents(
  ctx: ToolContext,
  params: Static<typeof meetIntentSchema>,
) {
  const contactId = params.contactId ?? ctx.contactId;
  if (!contactId) return errorResult("需要指定联系人");
  const result = await ctx.db.query<{
    id: string;
    intent: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, intent, status, created_at
     FROM meet_intents
     WHERE contact_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [contactId],
  );
  if (!result.rows.length) return textResult("没有记录到见面意图。", { intents: [] });
  const lines = result.rows.map(
    (row) => `- ${row.intent}（${row.status}，${formatLocalTime(row.created_at)}）`,
  );
  return textResult(`见面意图：\n${lines.join("\n")}`, { intents: result.rows });
}

export function buildReadTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    tool(searchContactsSchema, {
      name: "search_contacts",
      label: "搜索联系人",
      description: "按姓名模糊搜索当前用户的联系人，返回联系人 id 和 version。",
      execute: async (_id, params) => searchContacts(ctx, params),
    }),
    tool(contactIdSchema, {
      name: "get_contact_profile",
      label: "读取联系人档案",
      description: "读取指定联系人的事实、记忆、洞察、目标、长期记忆文档和版本号。",
      execute: async (_id, params) => getContactProfile(ctx, params),
    }),
    tool(calendarRangeSchema, {
      name: "list_calendar_events",
      label: "读取日程",
      description: "读取时间范围内的日程，可限定某个联系人；返回事件 id 和 version。",
      execute: async (_id, params) => listCalendarEvents(ctx, params),
    }),
    tool(freeSlotsSchema, {
      name: "find_free_slots",
      label: "查找空档",
      description:
        "按工作日 09:00–18:00、Asia/Shanghai 时区计算空闲时间段；最多查 14 天，返回 ISO 时间。",
      execute: async (_id, params) => findFreeSlots(ctx, params),
    }),
    tool(briefSchema, {
      name: "generate_meeting_brief",
      label: "生成会前简报",
      description: "汇总某个联系人的事实、目标、洞察和最近证据，生成会前简报。",
      execute: async (_id, params) => meetingBrief(ctx, params),
    }),
    tool(meetIntentSchema, {
      name: "list_meet_intents",
      label: "读取见面意图",
      description: "读取某个联系人的见面意图记录。",
      execute: async (_id, params) => listMeetIntents(ctx, params),
    }),
  ];
}
