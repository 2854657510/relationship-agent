import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { questionnairePayloadSchema, type ToolContext } from "../domain.ts";
import { errorResult, textResult } from "./helpers.ts";

type Tool<S extends TSchema, D = unknown> = Omit<AgentTool<S, D>, "parameters">;

function tool<S extends TSchema, D = unknown>(schema: S, def: Tool<S, D>): AgentTool<any> {
  return { ...def, parameters: schema } as unknown as AgentTool<any>;
}

const questionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 60 }),
  prompt: Type.String({ minLength: 1, maxLength: 300 }),
  kind: Type.Union([
    Type.Literal("single_choice"),
    Type.Literal("multi_choice"),
    Type.Literal("text"),
    Type.Literal("date"),
  ]),
  options: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  required: Type.Optional(Type.Boolean()),
});

const questionnaireSchema = Type.Object({
  questions: Type.Array(questionSchema, { minItems: 1, maxItems: 4 }),
});

async function questionnaire(
  ctx: ToolContext,
  params: Static<typeof questionnaireSchema>,
) {
  const parsed = questionnairePayloadSchema.safeParse(params);
  if (!parsed.success) {
    return errorResult(
      `问卷格式不合法：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
    );
  }

  const inserted = await ctx.db.query<{ id: string }>(
    `INSERT INTO questionnaires (run_id, thread_id, questions, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [ctx.runId, ctx.threadId, JSON.stringify(parsed.data.questions)],
  );
  const id = inserted.rows[0]?.id ?? "";
  ctx.terminal = { type: "questionnaire", id };

  return {
    content: [
      {
        type: "text" as const,
        text: `已向用户发起 ${parsed.data.questions.length} 道追问，本轮暂停，等待回答。`,
      },
    ],
    details: { questionnaireId: id, questions: parsed.data.questions },
    terminate: true,
  };
}

export function buildQuestionnaireTool(ctx: ToolContext): AgentTool<any> {
  return tool(questionnaireSchema, {
    name: "questionnaire",
    label: "结构化追问",
    description:
      "当缺少关键信息（是谁、什么时候、改什么）时，向用户发起 1–4 道结构化问题。这是终态工具，调用后本轮停止。",
    execute: async (_id, params) => questionnaire(ctx, params),
  });
}

export function questionnaireTextResult(id: string): ReturnType<typeof textResult> {
  return textResult(`已发起问卷 ${id}`);
}
