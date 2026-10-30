import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/index.ts";
import type { Db } from "../src/db/client.ts";

const okDb = {
  query: async () => ({
    rows: [{ ok: 1 }],
    command: "SELECT",
    rowCount: 1,
    oid: 0,
    fields: [],
  }),
  connect: async () => {
    throw new Error("connect is not used in this test");
  },
} as unknown as Db;

const downDb = {
  query: async () => {
    throw new Error("connection refused");
  },
  connect: async () => {
    throw new Error("connect is not used in this test");
  },
} as unknown as Db;

describe("GET /api/health", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("数据库正常时返回 200", async () => {
    app = await buildServer({ db: okDb, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      db: "ok",
      version: "p8",
    });
  });

  it("数据库不可用时返回 503", async () => {
    app = await buildServer({ db: downDb, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      db: "down",
      version: "p8",
    });
  });
});
