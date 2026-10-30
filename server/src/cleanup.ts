import { unlink } from "node:fs/promises";
import type { Db } from "./db/client.ts";

/**
 * 截图默认 24h 过期：删原图，保留 source_summary / sha256 / 候选字段和来源关系。
 * 只处理 storage_path 还在的行；重复执行是幂等的。
 */
export async function cleanupExpiredEvidence(db: Db): Promise<number> {
  const expired = await db.query<{ id: string; storage_path: string }>(
    `SELECT id, storage_path FROM evidence
     WHERE expires_at IS NOT NULL AND expires_at < now() AND storage_path IS NOT NULL
     LIMIT 200`,
  );
  if (!expired.rows.length) return 0;

  for (const row of expired.rows) {
    try {
      await unlink(row.storage_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await db.query(
    `UPDATE evidence
     SET storage_path = NULL,
         metadata = metadata || jsonb_build_object('expiredAt', now())
     WHERE id = ANY($1::uuid[])`,
    [expired.rows.map((row) => row.id)],
  );
  return expired.rows.length;
}
