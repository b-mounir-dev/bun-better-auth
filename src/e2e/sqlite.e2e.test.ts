import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { closeSql, createAdapter, createSqlClient, purgeTables, setupSchema } from "./harness";

describe("sqlite e2e", () => {
  let sql: SQL;
  let adapter: ReturnType<typeof createAdapter>;

  beforeAll(async () => {
    sql = createSqlClient("sqlite");
    await setupSchema(sql, "sqlite");
    adapter = createAdapter(sql, "sqlite");
  });

  beforeEach(async () => {
    await purgeTables(sql, "sqlite");
  });

  afterAll(async () => {
    await closeSql(sql);
  });

  test("runs CRUD and count on real sqlite", async () => {
    const now = new Date().toISOString();
    const created = await adapter.create<any>({
      model: "user",
      data: {
        name: "Alice",
        email: "alice@example.com",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    });

    const found = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(found?.email).toBe("alice@example.com");

    const updated = await adapter.update<any>({
      model: "user",
      where: [{ field: "id", value: created.id }],
      update: { name: "Alice Updated" },
    });
    expect(updated?.name).toBe("Alice Updated");

    const count = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "alice@example.com" }],
    });
    expect(count).toBe(1);

    await adapter.deleteMany({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    const left = await adapter.count({
      model: "user",
      where: [{ field: "id", value: created.id }],
    });
    expect(left).toBe(0);
  });

  test("supports case-insensitive filtering on sqlite", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "user",
      data: {
        name: "Case",
        email: "Case@Example.com",
        createdAt: now,
        updatedAt: now,
      },
    });

    const found = await adapter.findOne<any>({
      model: "user",
      where: [
        { field: "email", value: "case@example.com", operator: "eq", mode: "insensitive" },
      ],
    });
    expect(found?.email).toBe("Case@Example.com");
  });

  test("supports joins and consumeOne on sqlite", async () => {
    const now = new Date().toISOString();
    const user = await adapter.create<any>({
      model: "user",
      data: {
        name: "JoinTarget",
        email: "join@example.com",
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "session",
      data: {
        userId: user.id,
        token: "t1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "session",
      data: {
        userId: user.id,
        token: "t2",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
    });

    const joined = await adapter.findOne<any>({
      model: "user",
      where: [{ field: "id", value: user.id }],
      join: {
        session: { limit: 1 },
      },
    });
    const sessions = joined?.session ?? joined?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(1);

    await adapter.create({
      model: "verification",
      data: {
        identifier: "join@example.com",
        value: "single-use",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      },
    });

    const first = await adapter.consumeOne<any>({
      model: "verification",
      where: [{ field: "identifier", value: "join@example.com" }],
    });
    const second = await adapter.consumeOne<any>({
      model: "verification",
      where: [{ field: "identifier", value: "join@example.com" }],
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("supports null eq/ne semantics and transaction rollback on sqlite", async () => {
    const now = new Date().toISOString();
    await adapter.create({
      model: "user",
      data: {
        name: "NullImage",
        email: "null-image@example.com",
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await adapter.create({
      model: "user",
      data: {
        name: "WithImage",
        email: "with-image@example.com",
        image: "img",
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
    expect(eqNull.some((row) => row.email === "null-image@example.com")).toBe(true);
    expect(neNull.some((row) => row.email === "with-image@example.com")).toBe(true);

    await expect(
      adapter.transaction(async (tx) => {
        await tx.create({
          model: "user",
          data: {
            name: "SQLiteRollback",
            email: "sqlite-rollback@example.com",
            createdAt: now,
            updatedAt: now,
          },
        });
        throw new Error("sqlite-rollback");
      }),
    ).rejects.toThrow("sqlite-rollback");

    const rollbackCount = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "sqlite-rollback@example.com" }],
    });
    expect(rollbackCount).toBe(0);
  });
});
