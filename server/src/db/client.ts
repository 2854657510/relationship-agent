import pg from "pg";
import { config } from "../config.ts";

// 路由层只依赖这个最小接口，测试可以注入假实现，不用起 Postgres。
export type Db = Pick<pg.Pool, "query" | "connect">;

export function createPool(connectionString: string = config.databaseUrl): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function createTestPool(): pg.Pool {
  return createPool(config.testDatabaseUrl);
}
