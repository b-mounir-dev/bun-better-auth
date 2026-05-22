import { describe, expect, test } from "bun:test";
import { bunSqlAdapter } from "../bun-sql-adapter";
import type { BunSqlUnsafeClient } from "../types";

type UnsafeCall = {
  query: string;
  params: unknown[];
};

function createMockSql(initialResponses: unknown[][] = []) {
  const calls: UnsafeCall[] = [];
  const txCalls: UnsafeCall[] = [];
  const queue = [...initialResponses];

  const txClient: BunSqlUnsafeClient = {
    unsafe: async (query, params = []) => {
      txCalls.push({ query, params });
      return (queue.shift() ?? []) as any;
    },
  };

  let beginCount = 0;
  const client: BunSqlUnsafeClient = {
    unsafe: async (query, params = []) => {
      calls.push({ query, params });
      return (queue.shift() ?? []) as any;
    },
    begin: async (callback) => {
      beginCount += 1;
      return callback(txClient);
    },
  };

  return {
    client,
    calls,
    txCalls,
    queue,
    getBeginCount: () => beginCount,
  };
}

describe("bunSqlAdapter", () => {
  test("should create bun sql adapter", () => {
    const mock = createMockSql();
    const adapterFactory = bunSqlAdapter(mock.client, { provider: "sqlite" });
    expect(adapterFactory).toBeDefined();
    const adapter = adapterFactory({ database: { defaultFindLimit: 100 } } as any);
    expect(adapter).toBeDefined();
  });

  test("create uses RETURNING for postgres", async () => {
    const mock = createMockSql([[{ id: "u_1", email: "a@example.com" }]]);
    const instance = bunSqlAdapter(mock.client, { provider: "pg" });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const created = await adapter.create({
      model: "user",
      data: { email: "a@example.com" },
    });

    expect((created as any).id).toBe("u_1");
    expect(mock.calls[0]?.query).toContain("RETURNING *");
  });

  test("create falls back to select for mysql", async () => {
    const mock = createMockSql([[], [{ id: "u_2", email: "b@example.com" }]]);
    const instance = bunSqlAdapter(mock.client, { provider: "mysql" });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const created = await adapter.create({
      model: "user",
      data: { email: "b@example.com" },
    });

    expect((created as any).id).toBe("u_2");
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0]?.query).toContain("INSERT INTO");
    expect(mock.calls[1]?.query).toContain("SELECT");
  });

  test("consumeOne on mysql uses transaction and FOR UPDATE", async () => {
    const mock = createMockSql([
      [{ id: "token_1", identifier: "a@example.com" }],
      [],
    ]);
    const instance = bunSqlAdapter(mock.client, {
      provider: "mysql",
      transaction: true,
    });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const consumed = await adapter.consumeOne({
      model: "verification",
      where: [{ field: "identifier", value: "a@example.com" }],
    });

    expect((consumed as any).id).toBe("token_1");
    expect(mock.getBeginCount()).toBe(1);
    expect(mock.txCalls[0]?.query).toContain("FOR UPDATE");
    expect(mock.txCalls[1]?.query).toContain("DELETE FROM");
    expect(mock.txCalls[1]?.query).toContain("WHERE `id` = ?");
  });

  test("consumeOne on mysql inside adapter.transaction reuses outer transaction", async () => {
    const mock = createMockSql([
      [{ id: "token_tx_1", identifier: "tx@example.com" }],
      [],
    ]);
    const instance = bunSqlAdapter(mock.client, {
      provider: "mysql",
      transaction: true,
    });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const consumed = await adapter.transaction(async (tx) =>
      tx.consumeOne({
        model: "verification",
        where: [{ field: "identifier", value: "tx@example.com" }],
      }),
    );

    expect((consumed as any).id).toBe("token_tx_1");
    expect(mock.getBeginCount()).toBe(1);
    expect(mock.txCalls[0]?.query).toContain("FOR UPDATE");
    expect(mock.txCalls[1]?.query).toContain("DELETE FROM");
  });

  test("consumeOne deletes only selected row for non-unique predicates on mysql", async () => {
    const mock = createMockSql([
      [{ id: "verification_1", identifier: "same-identifier", value: "first" }],
      [],
    ]);
    const instance = bunSqlAdapter(mock.client, {
      provider: "mysql",
      transaction: true,
    });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const consumed = await adapter.consumeOne({
      model: "verification",
      where: [{ field: "identifier", value: "same-identifier" }],
    });

    expect((consumed as any).id).toBe("verification_1");
    expect(mock.txCalls[0]?.query).toContain("LIMIT 1 FOR UPDATE");
    expect(mock.txCalls[1]?.query).toContain("DELETE FROM `verification`");
    expect(mock.txCalls[1]?.params).toEqual(["verification_1"]);
  });

  test("consumeOne on postgres uses delete returning", async () => {
    const mock = createMockSql([[{ id: "token_2" }]]);
    const instance = bunSqlAdapter(mock.client, { provider: "pg" });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const consumed = await adapter.consumeOne({
      model: "verification",
      where: [{ field: "identifier", value: "a@example.com" }],
    });

    expect((consumed as any).id).toBe("token_2");
    expect(mock.calls[0]?.query).toContain("RETURNING *");
    expect(mock.calls[0]?.query).toContain("LIMIT 1");
  });

  test("findMany uses mapped field names from Better Auth schema config", async () => {
    const mock = createMockSql([[{ id: "u_1", email_verified: true }]]);
    const instance = bunSqlAdapter(mock.client, { provider: "pg" });
    const adapter = instance({
      secret: "test-secret-that-is-at-least-32-chars-long!!",
      database: { defaultFindLimit: 100 },
      user: {
        fields: {
          emailVerified: "email_verified",
        },
      },
    } as any);

    await adapter.findMany({
      model: "user",
      where: [{ field: "emailVerified", value: true }],
      limit: 10,
    });

    expect(mock.calls[0]?.query).toContain(`"t"."email_verified" = $1`);
  });

  test("updateMany reads affected row count from driver response", async () => {
    const mock = createMockSql([[{ affectedRows: 3 }]]);
    const instance = bunSqlAdapter(mock.client, { provider: "mysql" });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const updated = await adapter.updateMany({
      model: "user",
      where: [{ field: "email", value: "a@example.com" }],
      update: { name: "Updated" },
    });

    expect(updated).toBe(3);
  });

  test("deleteMany reads row count from driver response", async () => {
    const mock = createMockSql([[{ rowCount: 2 }]]);
    const instance = bunSqlAdapter(mock.client, { provider: "pg" });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const deleted = await adapter.deleteMany({
      model: "verification",
      where: [{ field: "identifier", value: "a@example.com" }],
    });

    expect(deleted).toBe(2);
  });

  test("count parses numeric string result", async () => {
    const mock = createMockSql([[{ count: "7" }]]);
    const instance = bunSqlAdapter(mock.client, { provider: "sqlite" });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const total = await adapter.count({
      model: "user",
      where: [{ field: "email", value: "a@example.com" }],
    });

    expect(total).toBe(7);
  });

  test("consumeOne on mysql without transaction support still executes select and delete", async () => {
    const calls: UnsafeCall[] = [];
    const client: BunSqlUnsafeClient = {
      unsafe: async (query, params = []) => {
        calls.push({ query, params });
        if (query.includes("SELECT")) {
          return [{ id: "v_1" }] as any;
        }
        return [] as any;
      },
    };
    const instance = bunSqlAdapter(client, { provider: "mysql", transaction: true });
    const adapter = instance({ database: { defaultFindLimit: 100 } } as any);

    const consumed = await adapter.consumeOne({
      model: "verification",
      where: [{ field: "identifier", value: "x@example.com" }],
    });

    expect((consumed as any).id).toBe("v_1");
    expect(calls[0]?.query).toContain("FOR UPDATE");
    expect(calls[1]?.query).toContain("DELETE FROM");
  });

  test("createSchema returns default provider path and provider-specific SQL", async () => {
    const mock = createMockSql();
    const instance = bunSqlAdapter(mock.client, { provider: "pg" });
    const adapter = instance({
      secret: "test-secret-that-is-at-least-32-chars-long!!",
      database: { defaultFindLimit: 100 },
    } as any);

    expect(adapter.createSchema).toBeDefined();
    const generated = await adapter.createSchema!(
      {
        secret: "test-secret-that-is-at-least-32-chars-long!!",
        database: { defaultFindLimit: 100 },
      } as any,
      undefined,
    );

    expect(generated.path).toBe("./auth-schema.pg.sql");
    expect(generated.overwrite).toBe(true);
    expect(generated.code).toContain('CREATE TABLE IF NOT EXISTS "user"');
    expect(generated.code).toContain('"emailVerified" BOOLEAN');
    expect(generated.code).toContain(
      'CREATE UNIQUE INDEX "user_email_unique" ON "user" ("email")',
    );
  });

  test("createSchema uses provided output path", async () => {
    const mock = createMockSql();
    const instance = bunSqlAdapter(mock.client, { provider: "mysql" });
    const adapter = instance({
      secret: "test-secret-that-is-at-least-32-chars-long!!",
      database: { defaultFindLimit: 100 },
    } as any);

    const generated = await adapter.createSchema!(
      {
        secret: "test-secret-that-is-at-least-32-chars-long!!",
        database: { defaultFindLimit: 100 },
      } as any,
      "./custom-auth-schema.sql",
    );

    expect(generated.path).toBe("./custom-auth-schema.sql");
    expect(generated.code).toContain("CREATE TABLE IF NOT EXISTS `user`");
    expect(generated.code).toContain("`emailVerified` BOOLEAN");
  });

  test("createSchema includes FK and index statements", async () => {
    const mock = createMockSql();
    const instance = bunSqlAdapter(mock.client, { provider: "sqlite" });
    const adapter = instance({
      secret: "test-secret-that-is-at-least-32-chars-long!!",
      database: { defaultFindLimit: 100 },
    } as any);

    const generated = await adapter.createSchema!(
      {
        secret: "test-secret-that-is-at-least-32-chars-long!!",
        database: { defaultFindLimit: 100 },
      } as any,
      undefined,
    );

    expect(generated.path).toBe("./auth-schema.sqlite.sql");
    expect(generated.code).toContain("REFERENCES \"user\"(\"id\") ON DELETE CASCADE");
    expect(generated.code).toContain(
      "CREATE INDEX \"session_userId_idx\" ON \"session\" (\"userId\")",
    );
  });
});
