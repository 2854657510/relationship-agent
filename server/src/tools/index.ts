import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "../domain.ts";
import { buildActionTool } from "./action.ts";
import { buildEvidenceTools } from "./evidence.ts";
import { buildQuestionnaireTool } from "./questionnaire.ts";
import { buildReadTools } from "./read.ts";
import { buildResearchTools } from "./research.ts";

/**
 * 每个 run 单独构建工具，工具闭包里带 run/thread/contact 上下文。
 * 这样权限、证据范围和终止状态不会串到别的会话。
 */
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    ...buildReadTools(ctx),
    ...buildEvidenceTools(ctx),
    ...buildResearchTools(ctx),
    buildQuestionnaireTool(ctx),
    buildActionTool(ctx),
  ];
}
