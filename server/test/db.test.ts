import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestPool } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { seedDatabase } from "../src/db/seed.ts";
import { appendMessage, compactThread, loadThreadState } from "../src/conversation-context.ts";
import { assembleSnapshot } from "../src/memory/snapshot.ts";
import { cleanupExpiredEvidence } from "../src/cleanup.ts";

let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
  // 测试库每次重置，保证迁移从空库开始；不动开发库。
  await runMigrations(pool, { reset: true, log: () => {} });
  await seedDatabase(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

describe("P1 数据库", () => {
  it("18 张业务表都存在", async () => {
    const expected = [
      "contacts",
      "contact_facts",
      "evidence",
      "threads",
      "messages",
      "agent_runs",
      "agent_events",
      "tool_calls",
      "calendar_events",
      "meet_intents",
      "actions",
      "action_receipts",
      "questionnaires",
      "permission_requests",
      "insights",
      "relationship_goals",
      "memory_items",
      "memory_documents",
    ];

    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = result.rows.map((row) => row.table_name);

    for (const table of expected) {
      expect(names, `缺少表 ${table}`).toContain(table);
    }
  });

  it("18 个迁移全部记录，017 保留原文件名", async () => {
    const result = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(result.rows).toHaveLength(18);
    expect(result.rows.some((row) => row.version === "017_text_memory_documents.sql")).toBe(true);
    expect(result.rows.at(-1)?.version).toBe("018_thread_compaction_cutoff.sql");
  });

  it("seed 幂等：重复执行仍是 3 个联系人", async () => {
    await seedDatabase(pool);
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM contacts",
    );
    expect(result.rows[0]?.count).toBe("3");
  });

  it("截图证据必须带过期时间", async () => {
    await expect(
      pool.query(
        `INSERT INTO evidence (type, storage_path, mime_type)
         VALUES ('screenshot', '/tmp/x.jpg', 'image/jpeg')`,
      ),
    ).rejects.toThrow(/evidence_screenshot_expiry_check/);
  });

  it("同一联系人只能有一份 active 记忆文档", async () => {
    await expect(
      pool.query(
        `INSERT INTO memory_documents (contact_id, version, content_markdown, status)
         VALUES ('c0000000-0000-4000-8000-000000000001', 2, '第二份 active', 'active')`,
      ),
    ).rejects.toThrow(/memory_documents_one_active_idx/);
  });
});

describe("压缩、快照与过期清理", () => {
  it("50 条消息压缩后只保留最近 12 条，摘要落库", async () => {
    const thread = await pool.query<{ id: string }>(
      "INSERT INTO threads (user_id, title) VALUES ('local-user', 'compact-test') RETURNING id",
    );
    const threadId = thread.rows[0]?.id;
    if (!threadId) throw new Error("thread not created");

    for (let i = 1; i <= 50; i += 1) {
      await appendMessage(pool, threadId, {
        role: "user",
        content: `消息 ${i}`,
        timestamp: i,
      });
    }

    const before = await loadThreadState(pool, threadId);
    expect(before.messages).toHaveLength(50);

    const after = await compactThread(pool, threadId, before, async () => "FAKE SUMMARY");
    expect(after.summary).toBe("FAKE SUMMARY");
    expect(after.untilSeq).toBe(38);
    expect(after.messages).toHaveLength(12);

    const reloaded = await loadThreadState(pool, threadId);
    expect(reloaded.summary).toBe("FAKE SUMMARY");
    expect(reloaded.untilSeq).toBe(38);
    expect(reloaded.messages).toHaveLength(12);
  });

  it("MemorySnapshot 不跨人物", async () => {
    const thread = await pool.query<{ id: string }>(
      "INSERT INTO threads (user_id, title) VALUES ('local-user', 'scope-test') RETURNING id",
    );
    const { snapshot } = await assembleSnapshot(pool, {
      contactId: "c0000000-0000-4000-8000-000000000001",
      threadId: thread.rows[0]?.id ?? "",
    });
    expect(snapshot.contact?.displayName).toBe("张三");
    expect(snapshot.contact?.facts.some((fact) => fact.value.includes("设计"))).toBe(false);
    expect(snapshot.contact?.facts.some((fact) => fact.value === "字节跳动")).toBe(true);
  });

  it("过期截图删原图、保留摘要", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ra-evidence-"));
    const file = path.join(dir, "shot.jpg");
    await writeFile(file, "expired");
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO evidence (type, storage_path, mime_type, expires_at, source_summary)
       VALUES ('screenshot', $1, 'image/jpeg', now() - interval '1 hour', '摘要保留')
       RETURNING id`,
      [file],
    );

    const cleaned = await cleanupExpiredEvidence(pool);
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const row = await pool.query<{ storage_path: string | null; source_summary: string | null }>(
      "SELECT storage_path, source_summary FROM evidence WHERE id = $1",
      [inserted.rows[0]?.id],
    );
    expect(row.rows[0]?.storage_path).toBeNull();
    expect(row.rows[0]?.source_summary).toBe("摘要保留");
    await expect(access(file)).rejects.toThrow();
  });
});
