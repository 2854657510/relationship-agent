import type { FastifyReply } from "fastify";

export interface RunEvent {
  seq: number;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

type Listener = (event: RunEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function publishEvent(event: RunEvent): void {
  const set = listeners.get(event.runId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // 单个 SSE 连接断开不能影响 run 本身。
    }
  }
}

export function subscribeRun(runId: string, listener: Listener): () => void {
  const set = listeners.get(runId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(runId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(runId);
  };
}

export function formatSse(event: RunEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export function openSse(reply: FastifyReply): {
  send: (event: RunEvent) => void;
  close: () => void;
} {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": connected\n\n");

  const keepAlive = setInterval(() => {
    reply.raw.write(": ping\n\n");
  }, 15_000);

  const close = () => {
    clearInterval(keepAlive);
    try {
      reply.raw.end();
    } catch {
      // 已经断开就忽略。
    }
  };

  return {
    send: (event) => {
      reply.raw.write(formatSse(event));
    },
    close,
  };
}
