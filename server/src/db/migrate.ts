import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { config } from "../config.ts";
import { createPool } from "./client.ts";

const defaultMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

export interface RunMigrationsOptions {
  reset?: boolean;
  dir?: string;
  log?: (message: string) => void;
}

/**
 * 按文件名顺序应用迁移，已应用的跳过。
 * 每个文件单独事务：失败只回滚当前文件，不会留下半张表。
 * 调用方负责 pool.end()；测试可以复用同一个 pool。
 */
export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions = {},
): Promise<string[]> {
  const dir = options.dir ?? defaultMigrationsDir;
  const log = options.log ?? console.log;

  if (options.reset) {
    log("!! 正在重置 public schema，仅用于本地开发 !!");
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
  }

  const client = await pool.connect();
  const appliedFiles: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(dir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const applied = new Set(
      (
        await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows.map((row) => row.version),
    );

    for (const file of files) {
      if (applied.has(file)) {
        log(`跳过 ${file}`);
        continue;
      }

      const sql = await readFile(path.join(dir, file), "utf8");
      log(`应用 ${file}`);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedFiles.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`迁移 ${file} 失败: ${(error as Error).message}`);
      }
    }

    log(`完成，共 ${files.length} 个迁移文件，本次新应用 ${appliedFiles.length} 个。`);
    return appliedFiles;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL ?? config.databaseUrl);
  try {
    await runMigrations(pool, { reset: process.argv.includes("--reset") });
  } finally {
    await pool.end();
  }
}

// 只有直接运行 CLI 时才连库；测试 import 时不会触发。
const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
