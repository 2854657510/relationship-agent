/**
 * 粗略 token 估算，只用于“要不要压缩”的判断，不用于计费。
 * 中文按 1.5 字/token，其他按 4 字符/token，故意偏保守。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: unknown }>): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          total += estimateTokens(part.text);
        } else {
          total += 20;
        }
      }
    }
    total += 8;
  }
  return total;
}
