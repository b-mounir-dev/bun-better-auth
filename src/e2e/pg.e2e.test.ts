import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { closeSql, createAdapter, createSqlClient, purgeTables, setupSchema } from "./harness";

describe("pg e2e", () => {
  let sql: SQL;
  let adapter: ReturnType<typeof createAdapter>;

  beforeAll(async () => {
    sql = createSqlClient("pg");
    await setupSchema(sql, "pg");
    adapter = createAdapter(sql, "pg");
  });

  beforeEach(async () => {
    await purgeTables(sql, "pg");
  });

  afterAll(async () => {
    await closeSql(sql);
  });

  test("runs CRUD and count on real postgres", async () => {
    const now = new Date().toISOString();
    const created = await adapter.create<any>({
      model: "user",
      data: {
        name: "PgUser",
        email: "pg@example.com",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    });

    const found = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(found?.email).toBe("pg@example.com");

    const updated = await adapter.update<any>({
      model: "user",
      where: [{ field: "id", value: created.id }],
      update: { name: "PgUser Updated" },
    });
    expect(updated?.name).toBe("PgUser Updated");

    const count = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "pg@example.com" }],
    });
    expect(count).toBe(1);
  });

  test("supports case-insensitive filtering and joins on postgres", async () => {
    const now = new Date().toISOString();
    const user = await adapter.create<any>({
      model: "user",
      data: {
        name: "PgJoin",
        email: "PGJOIN@EXAMPLE.COM",
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "session",
      data: {
        userId: user.id,
        token: "pg-token-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
    });

    const insensitive = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "email", value: "pgjoin@example.com", operator: "eq", mode: "insensitive" }],
    });
    expect(insensitive?.id).toBe(user.id);

    const joined = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "id", value: user.id }],
      join: { session: { limit: 5 } },
    });
    const sessions = joined?.session ?? joined?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(1);
  });

  test("supports null semantics and transaction rollback on postgres", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "user",
      data: {
        name: "PgNull",
        email: "pg-null@example.com",
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "user",
      data: {
        name: "PgNotNull",
        email: "pg-notnull@example.com",
        image: "x",
        createdAt: now,
        updatedAt: now,
      },
    });

    const eqNull = await adapter.findMany<any>({
      model: "user",
      where: [{ field: "image", value: null, operator: "eq" }],
      limit: 10,
    });
    const neNull = await adapter.findMany<any>({
      model: "user",
      where: [{ field: "image", value: null, operator: "ne" }],
      limit: 10,
    });
    expect(eqNull.some((row) => row.email === "pg-null@example.com")).toBe(true);
    expect(neNull.some((row) => row.email === "pg-notnull@example.com")).toBe(true);

    await expect(
      adapter.transaction(async (tx) => {
        await tx.create({
          model: "user",
          data: {
            name: "PgRollback",
            email: "pg-rollback@example.com",
            createdAt: now,
            updatedAt: now,
          },
        });
        throw new Error("pg-rollback");
      }),
    ).rejects.toThrow("pg-rollback");

    const rollbackCount = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "pg-rollback@example.com" }],
    });
    expect(rollbackCount).toBe(0);
  });

  test("consumeOne is race-safe under concurrency on postgres", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "verification",
      data: {
        identifier: "pg-race@example.com",
        value: "single-race-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        adapter.consumeOne<any>({
          model: "verification",
          where: [{ field: "identifier", value: "pg-race@example.com" }],
        }),
      ),
    );

    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect((winners[0] as any).value).toBe("single-race-token");
  });
});
