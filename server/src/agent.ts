import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  type Model,
  type MutableModels,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { config } from "./config.ts";
import { RunGuard } from "./agent-safety.ts";

let cachedModels: MutableModels | null = null;

export function getModels(): MutableModels {
  if (!cachedModels) {
    cachedModels = createModels();
    cachedModels.setProvider(deepseekProvider());
  }
  return cachedModels;
}

export function getMainModel(): Model<any> {
  const model = getModels().getModel(config.pi.provider, config.pi.model);
  if (!model) {
    throw new Error(
      `找不到模型 ${config.pi.provider}/${config.pi.model}。检查 PI_PROVIDER/PI_MODEL，或用 mock 模式跑测试。`,
    );
  }
  return model;
}

export function createStreamFn(models: MutableModels = getModels()): StreamFn {
  return (model, context, options) => models.streamSimple(model, context, options);
}

export interface BuildMainAgentOptions {
  systemPrompt: string;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  guard: RunGuard;
  streamFn?: StreamFn;
  model?: Model<any>;
  sessionId: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * 主 Agent 的唯一构造入口。
 *
 * 关键点：
 * - tools 是 per-run 闭包，里面带 contact/thread/evidence 范围；
 * - beforeToolCall 只做预算和兜底，权限判断在工具内部（因为它需要持久化暂停状态）；
 * - toolExecution=sequential，保证终态工具之后不会还有并行调用。
 */
export function buildMainAgent(options: BuildMainAgentOptions): Agent {
  const model = options.model ?? getMainModel();
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: options.tools,
      messages: options.messages,
    },
    streamFn: options.streamFn ?? createStreamFn(),
    toolExecution: "sequential",
    sessionId: options.sessionId,
    beforeToolCall: async ({ toolCall }) => {
      try {
        options.guard.checkToolCall(toolCall.name);
        return undefined;
      } catch (error) {
        return {
          block: true,
          reason: (error as Error).message,
          terminate: true,
        };
      }
    },
  });
  return agent;
}

export function modelLabel(): string {
  return `${config.pi.provider}/${config.pi.model}`;
}
