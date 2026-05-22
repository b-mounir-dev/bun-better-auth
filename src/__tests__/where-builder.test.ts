import { describe, expect, test } from "bun:test";
import { buildWhereClause } from "../query-builders";

describe("buildWhereClause", () => {
  test("builds case-insensitive equality for postgres", () => {
    const built = buildWhereClause({
      provider: "pg",
      resolveField: (field) => `"t"."${field}"`,
      where: [
        {
          field: "email",
          value: "UPPER@example.com",
          operator: "eq",
          connector: "AND",
          mode: "insensitive",
        },
      ],
    });

    expect(built.sql).toContain(`LOWER("t"."email") = $1`);
    expect(built.params).toEqual(["upper@example.com"]);
  });

  test("builds case-insensitive contains for mysql", () => {
    const built = buildWhereClause({
      provider: "mysql",
      resolveField: (field) => `\`t\`.\`${field}\``,
      where: [
        {
          field: "name",
          value: "Ali",
          operator: "contains",
          connector: "AND",
          mode: "insensitive",
        },
      ],
    });

    expect(built.sql).toContain("LOWER(`t`.`name`) LIKE ?");
    expect(built.params).toEqual(["%ali%"]);
  });

  test("builds OR and AND groups", () => {
    const built = buildWhereClause({
      provider: "sqlite",
      resolveField: (field) => `"t"."${field}"`,
      where: [
        {
          field: "email",
          value: "a@example.com",
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
        {
          field: "name",
          value: "bob",
          operator: "starts_with",
          connector: "OR",
          mode: "sensitive",
        },
      ],
    });

    expect(built.sql).toContain("WHERE");
    expect(built.sql).toContain("AND");
    expect(built.params).toEqual(["a@example.com", "bob%"]);
  });

  test("supports numeric comparison operators", () => {
    const built = buildWhereClause({
      provider: "pg",
      resolveField: (field) => `"t"."${field}"`,
      where: [
        { field: "age", value: 18, operator: "gte", connector: "AND", mode: "sensitive" },
        { field: "age", value: 99, operator: "lt", connector: "AND", mode: "sensitive" },
      ],
    });

    expect(built.sql).toContain(`"t"."age" >= $1`);
    expect(built.sql).toContain(`"t"."age" < $2`);
    expect(built.params).toEqual([18, 99]);
  });

  test("supports null semantics for eq and ne", () => {
    const built = buildWhereClause({
      provider: "sqlite",
      resolveField: (field) => `"t"."${field}"`,
      where: [
        { field: "deletedAt", value: null, operator: "eq", connector: "AND", mode: "sensitive" },
        { field: "email", value: null, operator: "ne", connector: "AND", mode: "sensitive" },
      ],
    });

    expect(built.sql).toContain(`"t"."deletedAt" IS NULL`);
    expect(built.sql).toContain(`"t"."email" IS NOT NULL`);
    expect(built.params).toEqual([]);
  });

  test("supports in and not_in operators", () => {
    const built = buildWhereClause({
      provider: "mysql",
      resolveField: (field) => `\`t\`.\`${field}\``,
      where: [
        { field: "role", value: ["admin", "user"], operator: "in", connector: "AND", mode: "sensitive" },
        { field: "status", value: ["disabled"], operator: "not_in", connector: "AND", mode: "sensitive" },
      ],
    });

    expect(built.sql).toContain("`t`.`role` IN (?, ?)");
    expect(built.sql).toContain("`t`.`status` NOT IN (?)");
    expect(built.params).toEqual(["admin", "user", "disabled"]);
  });

  test("handles empty in and not_in lists", () => {
    const inBuilt = buildWhereClause({
      provider: "pg",
      resolveField: (field) => `"t"."${field}"`,
      where: [
        { field: "id", value: [], operator: "in", connector: "AND", mode: "sensitive" },
      ],
    });
    const notInBuilt = buildWhereClause({
      provider: "pg",
      resolveField: (field) => `"t"."${field}"`,
      where: [
        { field: "id", value: [], operator: "not_in", connector: "AND", mode: "sensitive" },
      ],
    });

    expect(inBuilt.sql).toContain("1 = 0");
    expect(notInBuilt.sql).toContain("1 = 1");
  });

  test("uses ILIKE for insensitive contains on postgres", () => {
    const built = buildWhereClause({
      provider: "pg",
      resolveField: (field) => `"t"."${field}"`,
      where: [
        { field: "name", value: "Sam", operator: "contains", connector: "AND", mode: "insensitive" },
      ],
    });

    expect(built.sql).toContain(`"t"."name" ILIKE $1`);
    expect(built.params).toEqual(["%Sam%"]);
  });

  test("uses binary comparison for mysql sensitive eq strings", () => {
    const built = buildWhereClause({
      provider: "mysql",
      resolveField: (field) => `\`t\`.\`${field}\``,
      where: [
        { field: "email", value: "Exact@Case.com", operator: "eq", connector: "AND", mode: "sensitive" },
      ],
    });

    expect(built.sql).toContain("BINARY `t`.`email` = BINARY ?");
    expect(built.params).toEqual(["Exact@Case.com"]);
  });
});
