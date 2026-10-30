import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getMainModel, getModels } from "../agent.ts";

export function extractAssistantText(content: AssistantMessage["content"]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * 一次性文本调用，用于摘要/记忆文档这类不参与主 tool loop 的任务。
 * 失败直接抛错，调用方决定降级。
 */
export async function completeText(systemPrompt: string, userPrompt: string): Promise<string> {
  const models = getModels();
  const model = getMainModel();
  const response = await models.completeSimple(model, {
    systemPrompt,
    messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
  });
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "模型调用失败");
  }
  return extractAssistantText(response.content);
}
