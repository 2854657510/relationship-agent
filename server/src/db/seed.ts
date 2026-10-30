import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { config } from "../config.ts";
import { createPool } from "./client.ts";

// 固定 UUID + ON CONFLICT，让 seed 可以反复跑，不会产生重复数据。
const SEED_SQL = `
INSERT INTO contacts (id, display_name, version, status) VALUES
  ('c0000000-0000-4000-8000-000000000001', '张三', 1, 'active'),
  ('c0000000-0000-4000-8000-000000000002', '李四', 1, 'active'),
  ('c0000000-0000-4000-8000-000000000003', '王五', 1, 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence (id, user_id, type, contact_id, content, source_summary, metadata) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'local-user', 'user_note',
   'c0000000-0000-4000-8000-000000000001',
   '他说最近在忙新项目，周末一般不回消息。', '张三近况', '{"seed": true}'::jsonb),
  ('e1000000-0000-4000-8000-000000000002', 'local-user', 'user_note',
   'c0000000-0000-4000-8000-000000000002',
   '她更喜欢线下聊，咖啡厅比会议室放松。', '李四偏好', '{"seed": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO contact_facts (id, contact_id, field, value, status, confidence, evidence_ids) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'company',  '字节跳动',            'confirmed', 'high',   ARRAY['e1000000-0000-4000-8000-000000000001']::uuid[]),
  ('f1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'title',    '产品经理',            'confirmed', 'high',   ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 'phone',    '13800000001',         'confirmed', 'medium', ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', 'email',    'zhangsan@example.com','confirmed', 'medium', ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'city',     '北京',                'confirmed', 'high',   ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000001', 'birthday', '1992-05-12',          'confirmed', 'medium', ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000002', 'company',  '独立设计工作室',      'confirmed', 'high',   ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000002', 'title',    '设计师',              'confirmed', 'high',   ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000002', 'email',    'lisi@example.com',    'confirmed', 'medium', ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000010', 'c0000000-0000-4000-8000-000000000002', 'city',     '上海',                'confirmed', 'high',   ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000003', 'company',  '某基金',              'confirmed', 'medium', ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000012', 'c0000000-0000-4000-8000-000000000003', 'title',    '投资经理',            'confirmed', 'high',   ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000013', 'c0000000-0000-4000-8000-000000000003', 'email',    'wangwu@example.com',  'confirmed', 'medium', ARRAY[]::uuid[]),
  ('f1000000-0000-4000-8000-000000000014', 'c0000000-0000-4000-8000-000000000003', 'city',     '深圳',                'confirmed', 'high',   ARRAY[]::uuid[])
ON CONFLICT (id) DO NOTHING;

INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, timezone, location, notes, contact_ids, version) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'local-user', '与张三喝咖啡',
   '2026-11-04T15:00:00+08:00', '2026-11-04T16:00:00+08:00', 'Asia/Shanghai', '国贸',
   '聊聊新项目', ARRAY['c0000000-0000-4000-8000-000000000001']::uuid[], 1),
  ('e2000000-0000-4000-8000-000000000002', 'local-user', '项目评审',
   '2026-11-06T10:00:00+08:00', '2026-11-06T11:00:00+08:00', 'Asia/Shanghai', NULL,
   '设计稿评审', ARRAY['c0000000-0000-4000-8000-000000000002']::uuid[], 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO relationship_goals (id, contact_id, description, status, evidence_ids) VALUES
  ('90000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   '三个月内建立稳定的合作信任', 'active', ARRAY['e1000000-0000-4000-8000-000000000001']::uuid[]),
  ('90000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
   '保持每月一次深聊', 'active', ARRAY[]::uuid[])
ON CONFLICT (id) DO NOTHING;

INSERT INTO insights (id, contact_id, content, confidence, status, evidence_ids, source_ids, recheck_at) VALUES
  ('15000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   '最近工作压力偏高，约见尽量避开周末。', 'medium', 'active',
   ARRAY['e1000000-0000-4000-8000-000000000001']::uuid[],
   ARRAY['e1000000-0000-4000-8000-000000000001'],
   now() + interval '7 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO memory_items (id, contact_id, kind, content, status, confidence, evidence_ids) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'preference', '偏好简短、提前发议程；周末尽量不打扰。', 'confirmed', 'high',
   ARRAY['e1000000-0000-4000-8000-000000000001']::uuid[])
ON CONFLICT (id) DO NOTHING;

INSERT INTO memory_documents (id, contact_id, version, content_markdown, status, evidence_ids, approved_at) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 1,
   '# 张三\n\n- 产品经理，字节跳动\n- 偏好简短、提前发议程\n- 周末尽量不打扰\n',
   'active', ARRAY['e1000000-0000-4000-8000-000000000001']::uuid[], now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO meet_intents (id, contact_id, intent, status, evidence_ids) VALUES
  ('1a000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   '下周三下午一起喝咖啡', 'candidate',
   ARRAY['e1000000-0000-4000-8000-000000000001']::uuid[])
ON CONFLICT (id) DO NOTHING;
`;

export interface SeedCounts {
  contacts: string;
  facts: string;
  events: string;
  memories: string;
}

export async function seedDatabase(pool: Pool): Promise<SeedCounts> {
  await pool.query(SEED_SQL);
  const counts = await pool.query<SeedCounts>(`
    SELECT
      (SELECT count(*) FROM contacts)::text AS contacts,
      (SELECT count(*) FROM contact_facts)::text AS facts,
      (SELECT count(*) FROM calendar_events)::text AS events,
      (SELECT count(*) FROM memory_items)::text AS memories
  `);
  return counts.rows[0] ?? { contacts: "0", facts: "0", events: "0", memories: "0" };
}

async function main(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL ?? config.databaseUrl);
  try {
    const counts = await seedDatabase(pool);
    console.log(
      `seed 完成：contacts=${counts.contacts} facts=${counts.facts} events=${counts.events} memories=${counts.memories}`,
    );
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
