import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  USER_ID,
  questionnaireAnswersSchema,
  sendMessageSchema,
} from "../domain.ts";
import {
  answerQuestionnaire,
  decidePermission,
  getRun,
  startMessageRun,
} from "../agent-service.ts";
import { confirmAction, getActionForUser, rejectAction } from "../action-service.ts";
import { ActiveRunError, ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { assembleSnapshot } from "../memory/snapshot.ts";
import {
  approveMemoryDraft,
  confirmMemoryItem,
  generateMemoryDraft,
  listMemoryForContact,
  rejectMemoryDraft,
  rejectMemoryItem,
} from "../text-memory.ts";
import { openSse, subscribeRun } from "./sse.ts";

export interface RouteDeps {
  db: Db;
}

const createThreadSchema = z.object({
  title: z.string().max(200).optional(),
});

const permissionDecisionSchema = z.object({
  decision: z.enum(["granted", "denied"]),
});

const baseVersionSchema = z.object({
  // 0 表示“还没有 active 文档”，是合法基线。
  baseVersion: z.number().int().nonnegative().optional(),
});

function handleError(error: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (error instanceof ActiveRunError || error instanceof ConflictError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof NotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof ValidationError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: "请求体不合法", issues: error.issues });
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(500).send({ error: message });
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db } = deps;

  app.get("/api/health", async (_request, reply) => {
    try {
      const result = await db.query<{ ok: number }>("SELECT 1 AS ok");
      const ok = result.rows[0]?.ok === 1;
      return {
        status: ok ? "ok" : "degraded",
        db: ok ? "ok" : "unknown",
        version: "p8",
        time: new Date().toISOString(),
      };
    } catch (error) {
      app.log.error({ err: error }, "health check failed");
      return reply.code(503).send({
        status: "degraded",
        db: "down",
        version: "p8",
        time: new Date().toISOString(),
      });
    }
  });

  app.post("/api/threads", async (request, reply) => {
    try {
      const body = createThreadSchema.parse(request.body ?? {});
      const inserted = await db.query<{ id: string; created_at: Date }>(
        `INSERT INTO threads (user_id, title) VALUES ($1, $2)
         RETURNING id, created_at`,
        [USER_ID, body.title ?? "新会话"],
      );
      const row = inserted.rows[0];
      return reply.code(201).send({ id: row?.id, createdAt: row?.created_at });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/threads/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const thread = await db.query<{
        id: string;
        title: string | null;
        compaction_summary: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, title, compaction_summary, created_at, updated_at
         FROM threads WHERE id = $1 AND user_id = $2`,
        [id, USER_ID],
      );
      if (!thread.rows[0]) throw new NotFoundError("会话不存在");

      const messages = await db.query<{
        seq: number;
        role: string;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT seq, role, payload, created_at FROM messages
         WHERE thread_id = $1 ORDER BY seq ASC LIMIT 200`,
        [id],
      );
      const questionnaire = await db.query(
        `SELECT id, questions, status FROM questionnaires
         WHERE thread_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      const permission = await db.query(
        `SELECT p.id, p.tool_name, p.args, p.status
         FROM permission_requests p JOIN agent_runs r ON r.id = p.run_id
         WHERE r.thread_id = $1 AND p.status = 'pending'
         ORDER BY p.created_at DESC LIMIT 1`,
        [id],
      );
      const action = await db.query(
        `SELECT id, type, payload, rationale, evidence_ids, base_version, status
         FROM actions WHERE thread_id = $1 AND status = 'proposed'
         ORDER BY created_at DESC LIMIT 1`,
        [id],
      );

      return {
        thread: thread.rows[0],
        messages: messages.rows,
        pendingQuestionnaire: questionnaire.rows[0] ?? null,
        pendingPermission: permission.rows[0] ?? null,
        pendingAction: action.rows[0] ?? null,
      };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/threads/:id/messages", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = sendMessageSchema.parse(request.body);
      const started = await startMessageRun(db, {
        threadId: id,
        userId: USER_ID,
        input,
      });
      return reply.code(started.existing ? 200 : 202).send(started);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/runs/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await getRun(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/runs/:id/events", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { after } = request.query as { after?: string };
      const run = await db.query<{ id: string }>(
        `SELECT r.id FROM agent_runs r JOIN threads t ON t.id = r.thread_id
         WHERE r.id = $1 AND t.user_id = $2`,
        [id, USER_ID],
      );
      if (!run.rows[0]) throw new NotFoundError("run 不存在");

      const cursor = Number(after ?? 0);
      const sse = openSse(reply);

      const replay = await db.query<{
        seq: number;
        type: string;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT seq, type, payload, created_at FROM agent_events
         WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
        [id, Number.isFinite(cursor) ? cursor : 0],
      );
      for (const row of replay.rows) {
        sse.send({
          seq: row.seq,
          runId: id,
          type: row.type,
          payload: row.payload,
          createdAt: row.created_at.toISOString(),
        });
      }

      const unsubscribe = subscribeRun(id, sse.send);
      request.raw.on("close", () => {
        unsubscribe();
        sse.close();
      });
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/questionnaires/:id/answer", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = questionnaireAnswersSchema.parse(request.body);
      const started = await answerQuestionnaire(db, id, USER_ID, body.answers);
      return reply.code(202).send(started);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/permissions/:id/decide", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = permissionDecisionSchema.parse(request.body);
      const started = await decidePermission(db, id, USER_ID, body.decision);
      return reply.code(202).send(started);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/actions/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await getActionForUser(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/actions/:id/confirm", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await confirmAction(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/actions/:id/reject", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await rejectAction(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/contacts", async (_request, reply) => {
    try {
      const result = await db.query<{
        id: string;
        display_name: string;
        version: number;
        updated_at: Date;
      }>(
        `SELECT id, display_name, version, updated_at
         FROM contacts WHERE user_id = $1 AND status = 'active'
         ORDER BY display_name`,
        [USER_ID],
      );
      return { contacts: result.rows };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/contacts/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const threadId = (request.query as { threadId?: string }).threadId;
      const { snapshot, rendered } = await assembleSnapshot(db, {
        contactId: id,
        threadId: threadId ?? "00000000-0000-0000-0000-000000000000",
      });
      if (!snapshot.contact) throw new NotFoundError("联系人不存在");
      return { snapshot, rendered };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/contacts/:id/memory", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await listMemoryForContact(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/contacts/:id/memory-drafts", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = baseVersionSchema.parse(request.body ?? {});
      return await generateMemoryDraft(db, id, USER_ID, body.baseVersion);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/memory-drafts/:id/approve", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = baseVersionSchema.parse(request.body ?? {});
      return await approveMemoryDraft(db, id, USER_ID, body.baseVersion);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/memory-drafts/:id/reject", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await rejectMemoryDraft(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/memory-items/:id/confirm", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await confirmMemoryItem(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/api/memory-items/:id/reject", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await rejectMemoryItem(db, id, USER_ID);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/api/evidence/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await db.query<{
        storage_path: string | null;
        mime_type: string | null;
        expires_at: Date | null;
      }>(
        `SELECT e.storage_path, e.mime_type, e.expires_at
         FROM evidence e JOIN threads t ON t.id = e.thread_id
         WHERE e.id = $1 AND t.user_id = $2`,
        [id, USER_ID],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError("证据不存在");
      if (row.expires_at && row.expires_at.getTime() < Date.now()) {
        return reply.code(410).send({ error: "截图已过期，仅保留摘要" });
      }
      if (!row.storage_path) return reply.code(404).send({ error: "没有原图" });
      reply.type(row.mime_type ?? "application/octet-stream");
      return reply.send(createReadStream(row.storage_path));
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
