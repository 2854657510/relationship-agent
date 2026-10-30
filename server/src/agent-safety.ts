import { config } from "./config.ts";

/**
 * 单次 run 的预算守卫。
 *
 * 预算不交给模型“自觉”，而是在 beforeToolCall 里扣减；
 * 超了直接 abort，错误原因写回 run。
 */
export class RunGuard {
  readonly startedAt = Date.now();
  toolCalls = 0;

  constructor(
    readonly maxToolCalls = config.limits.maxToolCalls,
    readonly maxSeconds = config.limits.maxRunSeconds,
  ) {}

  checkToolCall(toolName: string): void {
    if (Date.now() - this.startedAt > this.maxSeconds * 1000) {
      throw new Error(`本轮超过 ${this.maxSeconds}s 预算，已停止`);
    }
    if (this.toolCalls >= this.maxToolCalls) {
      throw new Error(`本轮超过 ${this.maxToolCalls} 次工具调用预算，已停止`);
    }
    this.toolCalls += 1;
    void toolName;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function assertImageLimits(images: Array<{ mimeType: string; dataBase64: string }>): void {
  if (images.length > MAX_IMAGES) throw new Error(`最多 ${MAX_IMAGES} 张图`);
  for (const image of images) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)) {
      throw new Error("只接受 jpeg/png/webp");
    }
    const bytes = Buffer.from(image.dataBase64, "base64").byteLength;
    if (bytes > MAX_IMAGE_BYTES) throw new Error("单张图片解码后不能超过 8MB");
  }
}
