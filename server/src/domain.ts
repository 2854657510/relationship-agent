import { z } from "zod";

/**
 * 领域类型 + 入参校验。
 *
 * 这里只放“跨模块共享”的东西：
 * - HTTP 入参 schema
 * - Action / questionnaire / insight 的协议
 * - 数据库行类型
 *
 * 具体 SQL 不放在这里，避免 domain 变成第二个 db 层。
 */

export const USER_ID = "local-user";

export const permissionModeSchema = z.enum(["ask", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const pageContextSchema = z
  .object({
    contactId: z.string().uuid().nullable().optional(),
    insightId: z.string().uuid().nullable().optional(),
    calendarEventId: z.string().uuid().nullable().optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .default({});
export type PageContext = z.infer<typeof pageContextSchema>;

export const imageInputSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z.string().min(1),
});

export const sendMessageSchema = z
  .object({
    text: z.string().max(8_000).optional(),
    images: z.array(imageInputSchema).max(4).default([]),
    pageContext: pageContextSchema.optional(),
    permissionMode: permissionModeSchema.default("ask"),
    requestId: z.string().min(1).max(120),
  })
  .refine((value) => Boolean(value.text?.trim()) || value.images.length > 0, {
    message: "text 和 images 至少提供一个",
  });
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const actionTypes = [
  "create_contact",
  "update_contact",
  "merge_contacts",
  "create_event",
  "update_event",
  "delete_event",
] as const;
export type ActionType = (typeof actionTypes)[number];

const contactFieldsSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  email: z.string().email().optional(),
  notes: z.string().max(4_000).optional(),
});

export const actionPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_contact"),
    displayName: z.string().min(1).max(120),
    company: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    phone: z.string().max(60).optional(),
    email: z.string().email().optional(),
    notes: z.string().max(4_000).optional(),
  }),
  z.object({
    type: z.literal("update_contact"),
    contactId: z.string().uuid(),
    patch: contactFieldsSchema.refine((patch) => Object.keys(patch).length > 0, {
      message: "patch 不能为空",
    }),
    baseVersion: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("merge_contacts"),
    sourceContactIds: z.array(z.string().uuid()).min(1),
    targetContactId: z.string().uuid(),
    fieldChoices: z.record(z.string()).default({}),
    baseVersion: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("create_event"),
    title: z.string().min(1).max(200),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    timezone: z.string().min(1).default("Asia/Shanghai"),
    location: z.string().max(300).optional(),
    notes: z.string().max(4_000).optional(),
    contactIds: z.array(z.string().uuid()).default([]),
  }),
  z.object({
    type: z.literal("update_event"),
    eventId: z.string().uuid(),
    patch: z
      .object({
        title: z.string().min(1).max(200).optional(),
        startsAt: z.string().datetime({ offset: true }).optional(),
        endsAt: z.string().datetime({ offset: true }).optional(),
        timezone: z.string().min(1).optional(),
        location: z.string().max(300).optional(),
        notes: z.string().max(4_000).optional(),
        contactIds: z.array(z.string().uuid()).optional(),
      })
      .refine((patch) => Object.keys(patch).length > 0, { message: "patch 不能为空" }),
    baseVersion: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("delete_event"),
    eventId: z.string().uuid(),
    baseVersion: z.number().int().positive().optional(),
  }),
]);
export type ActionPayload = z.infer<typeof actionPayloadSchema>;

export const questionSchema = z
  .object({
    id: z.string().min(1).max(60),
    prompt: z.string().min(1).max(300),
    kind: z.enum(["single_choice", "multi_choice", "text", "date"]),
    options: z.array(z.string().min(1).max(120)).max(4).optional(),
    required: z.boolean().default(true),
  })
  .superRefine((question, ctx) => {
    const needsOptions = question.kind === "single_choice" || question.kind === "multi_choice";
    if (needsOptions && (!question.options || question.options.length < 2)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "选择题至少 2 个选项" });
    }
    if (!needsOptions && question.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "非选择题不要带 options" });
    }
  });

export const questionnairePayloadSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
});
export type QuestionnairePayload = z.infer<typeof questionnairePayloadSchema>;

export const questionnaireAnswersSchema = z.object({
  answers: z.record(z.union([z.string(), z.array(z.string())])),
});

export const insightOutputSchema = z.object({
  insight: z
    .object({
      content: z.string().min(1).max(800),
      confidence: z.enum(["low", "medium", "high"]),
      recheckAt: z.string().datetime({ offset: true }).nullable(),
      evidenceIds: z.array(z.string().uuid()).min(1),
      sourceIds: z.array(z.string()).min(1),
    })
    .nullable(),
  memoryDraft: z
    .object({
      content: z.string().min(1).max(800),
      evidenceIds: z.array(z.string().uuid()).min(1),
    })
    .nullable(),
});
export type InsightOutput = z.infer<typeof insightOutputSchema>;

export const memoryDraftRequestSchema = z.object({
  baseVersion: z.number().int().positive().optional(),
});

export const memoryDecisionSchema = z.object({
  requestId: z.string().min(1).max(120).optional(),
});

// ---------- 数据库行类型 ----------

export interface ContactRow {
  id: string;
  user_id: string;
  display_name: string;
  version: number;
  status: "active" | "merged";
  merged_into_id: string | null;
  merged_at: Date | null;
}

export interface EvidenceRow {
  id: string;
  type: "user_note" | "screenshot" | "web_page" | "action_receipt";
  contact_id: string | null;
  content: string | null;
  storage_path: string | null;
  mime_type: string | null;
  sha256: string | null;
  source_summary: string | null;
  captured_at: Date;
  expires_at: Date | null;
}

export interface ActionRow {
  id: string;
  thread_id: string;
  contact_id: string | null;
  type: ActionType;
  payload: ActionPayload;
  status: "proposed" | "confirmed" | "rejected" | "executed" | "failed" | "conflict";
  version: number;
  base_version: number | null;
  base_version_source: "model" | "server" | null;
  evidence_ids: string[];
  rationale: string | null;
  created_at: Date;
}

export interface MemorySnapshot {
  now: string;
  timezone: string;
  contact: {
    id: string;
    displayName: string;
    version: number;
    facts: Array<{ field: string; value: string; status: string; evidenceIds: string[] }>;
    mergedFrom: Array<{ id: string; displayName: string }>;
  } | null;
  evidence: Array<{ id: string; type: string; summary: string; capturedAt: string; expired: boolean }>;
  candidates: Array<{ id: string; kind: string; content: string; evidenceIds: string[] }>;
  conflicts: Array<{ field: string; values: string[]; evidenceIds: string[] }>;
  goals: Array<{ id: string; description: string; evidenceIds: string[] }>;
  insights: Array<{ id: string; content: string; confidence: string; evidenceIds: string[] }>;
  confirmedMemories: Array<{ id: string; kind: string; content: string; evidenceIds: string[] }>;
  memoryDocument: { version: number; contentMarkdown: string } | null;
  actions: Array<{ id: string; type: string; status: string; summary: string }>;
  thread: { id: string; compactionSummary?: string };
}

export interface ToolTerminalState {
  type: "questionnaire" | "action" | "permission";
  id: string;
}

export interface ToolContext {
  userId: string;
  threadId: string;
  runId: string;
  contactId: string | null;
  evidenceIds: string[];
  permissionMode: PermissionMode;
  /** 恢复 run 时，用户刚刚授权的单个工具；只放行这一次。 */
  grantedPermission: string | null;
  db: import("./db/client.ts").Db;
  terminal: ToolTerminalState | null;
  maxToolCalls: number;
}

export function isActionType(value: string): value is ActionType {
  return (actionTypes as readonly string[]).includes(value);
}
