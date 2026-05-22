import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { closeSql, createAdapter, createSqlClient, purgeTables, setupSchema } from "./harness";

describe("mysql e2e", () => {
  let sql: SQL;
  let adapter: ReturnType<typeof createAdapter>;

  beforeAll(async () => {
    sql = createSqlClient("mysql");
    await setupSchema(sql, "mysql");
    adapter = createAdapter(sql, "mysql");
  });

  beforeEach(async () => {
    await purgeTables(sql, "mysql");
  });

  afterAll(async () => {
    await closeSql(sql);
  });

  test("runs CRUD and count on real mysql", async () => {
    const now = new Date().toISOString();
    const created = await adapter.create<any>({
      model: "user",
      data: {
        name: "Bob",
        email: "bob@example.com",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    });

    const found = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(found?.email).toBe("bob@example.com");

    const updateMany = await adapter.updateMany({
      model: "user",
      where: [{ field: "email", value: "bob@example.com" }],
      update: { name: "Bob Updated" },
    });
    expect(updateMany).toBe(1);

    const count = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "bob@example.com" }],
    });
    expect(count).toBe(1);
  });

  test("supports case-insensitive filters and join shaping on mysql", async () => {
    const now = new Date().toISOString();
    const user = await adapter.create<any>({
      model: "user",
      data: {
        name: "JoinUser",
        email: "JOIN@EXAMPLE.COM",
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "session",
      data: {
        userId: user.id,
        token: "mysql-token-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
    });

    const insensitive = await adapter.findOne<any>({
      model: "user",
      where: [
        {
          field: "email",
          value: "join@example.com",
          operator: "eq",
          mode: "insensitive",
        },
      ],
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

  test("respects case-sensitive eq matching on mysql", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "user",
      data: {
        name: "Sensitive",
        email: "Exact@Case.com",
        createdAt: now,
        updatedAt: now,
      },
    });

    const strictMiss = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "email", value: "exact@case.com", operator: "eq", mode: "sensitive" }],
    });
    const strictHit = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "email", value: "Exact@Case.com", operator: "eq", mode: "sensitive" }],
    });

    expect(strictMiss).toBeNull();
    expect(strictHit?.email).toBe("Exact@Case.com");
  });

  test("supports null equality and inequality semantics on mysql", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "user",
      data: {
        name: "HasImage",
        email: "has-image@example.com",
        image: "x",
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "user",
      data: {
        name: "NoImage",
        email: "no-image@example.com",
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });

    const isNull = await adapter.findMany<any>({
      model: "user",
      where: [{ field: "image", value: null, operator: "eq" }],
      limit: 10,
    });
    const isNotNull = await adapter.findMany<any>({
      model: "user",
      where: [{ field: "image", value: null, operator: "ne" }],
      limit: 10,
    });

    expect(isNull.some((row) => row.email === "no-image@example.com")).toBe(true);
    expect(isNotNull.some((row) => row.email === "has-image@example.com")).toBe(true);
  });

  test("rolls back transaction on mysql when callback throws", async () => {
    const now = new Date().toISOString();
    await expect(
      adapter.transaction(async (tx) => {
        await tx.create({
          model: "user",
          data: {
            name: "ShouldRollback",
            email: "rollback@example.com",
            createdAt: now,
            updatedAt: now,
          },
        });
        throw new Error("rollback-test");
      }),
    ).rejects.toThrow("rollback-test");

    const count = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "rollback@example.com" }],
    });
    expect(count).toBe(0);
  });

  test("consumeOne is race-safe under concurrency on mysql", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "verification",
      data: {
        identifier: "race@example.com",
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
          where: [{ field: "identifier", value: "race@example.com" }],
        }),
      ),
    );

    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect((winners[0] as any).value).toBe("single-race-token");
  });

  test("consumeOne works inside adapter.transaction on mysql", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "verification",
      data: {
        identifier: "tx-consume@example.com",
        value: "tx-consume-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
    });

    const consumed = await adapter.transaction(async (tx) =>
      tx.consumeOne<any>({
        model: "verification",
        where: [{ field: "identifier", value: "tx-consume@example.com" }],
      }),
    );

    expect(consumed?.value).toBe("tx-consume-token");

    const remaining = await adapter.count({
      model: "verification",
      where: [{ field: "identifier", value: "tx-consume@example.com" }],
    });
    expect(remaining).toBe(0);
  });

  test("round-trips date fields through mysql DATETIME transformers", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.678Z");
    const updatedAt = new Date("2026-01-02T04:05:06.789Z");

    const created = await adapter.create<any>({
      model: "user",
      data: {
        name: "DateUser",
        email: "date-user@example.com",
        createdAt,
        updatedAt,
      },
    });

    const found = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });

    expect(found?.createdAt instanceof Date).toBe(true);
    expect(found?.updatedAt instanceof Date).toBe(true);
    expect(found?.createdAt.toISOString()).toBe("2026-01-02T03:04:05.678Z");
    expect(found?.updatedAt.toISOString()).toBe("2026-01-02T04:05:06.789Z");
  });
});
