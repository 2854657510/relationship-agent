import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { pathToFileURL } from "node:url";
import { config } from "./config.ts";
import { createPool, type Db } from "./db/client.ts";
import { registerRoutes } from "./http/routes.ts";
import { cleanupExpiredEvidence } from "./cleanup.ts";

export interface BuildServerOptions {
  db: Db;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  // 开发期只允许 Vite 的两个本地地址，别在 P1 就放开 *。
  await app.register(cors, {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  });

  await registerRoutes(app, { db: options.db });
  return app;
}

async function main(): Promise<void> {
  const pool = createPool();
  const app = await buildServer({ db: pool });
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Relationship Agent server listening on http://${config.host}:${config.port}`);

  // 启动时清一次，之后每小时一次；unref 不阻止进程退出。
  void cleanupExpiredEvidence(pool)
    .then((count) => app.log.info({ count }, "expired evidence cleanup"))
    .catch((error) => app.log.warn({ err: error }, "expired evidence cleanup failed"));
  const cleanupTimer = setInterval(() => {
    void cleanupExpiredEvidence(pool)
      .then((count) => app.log.info({ count }, "expired evidence cleanup"))
      .catch((error) => app.log.warn({ err: error }, "expired evidence cleanup failed"));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// 测试会 import 这个文件；只有直接运行时才监听端口。
const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  main().catch((error) => {
    console.error("服务启动失败：", error);
    process.exit(1);
  });
}
