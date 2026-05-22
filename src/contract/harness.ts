import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { SQL } from "bun";
import { bunSqlAdapter } from "../bun-sql-adapter";

export type ContractProvider = "pg" | "mysql" | "sqlite";

const SECRET = "test-secret-that-is-at-least-32-chars-long!!";

const MYSQL_URL =
  process.env.BUN_BETTER_AUTH_MYSQL_URL ??
  "mysql://vostra_user:vostra_password@localhost:3306/vostra_db";
const PG_URL =
  process.env.BUN_BETTER_AUTH_PG_URL ??
  "postgres://postgres:postgres@localhost:5432/vostra_db";

function q(provider: ContractProvider, name: string): string {
  if (provider === "mysql") {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function qTable(provider: ContractProvider, modelName: string): string {
  return modelName
    .split(".")
    .map((part) => q(provider, part))
    .join(".");
}

function indexName(parts: string[]): string {
  return parts.join("_").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 55);
}

function columnType(
  provider: ContractProvider,
  type: string,
  supportsNumberId: boolean,
): string {
  if (type === "string") {
    return provider === "mysql" ? "VARCHAR(512)" : provider === "pg" ? "TEXT" : "TEXT";
  }
  if (type === "number") {
    return provider === "mysql" ? "DOUBLE" : provider === "pg" ? "DOUBLE PRECISION" : "REAL";
  }
  if (type === "boolean") {
    return provider === "mysql" || provider === "pg" ? "BOOLEAN" : "INTEGER";
  }
  if (type === "date") {
    return provider === "mysql" || provider === "pg" ? "TIMESTAMP(3)" : "TEXT";
  }
  if (type === "json") {
    return provider === "mysql" ? "JSON" : provider === "pg" ? "JSONB" : "TEXT";
  }
  if (type.endsWith("[]")) {
    return provider === "mysql" ? "JSON" : provider === "pg" ? "JSONB" : "TEXT";
  }
  if (supportsNumberId) {
    return provider === "mysql" ? "BIGINT" : provider === "pg" ? "BIGINT" : "INTEGER";
  }
  return provider === "mysql" ? "VARCHAR(512)" : provider === "pg" ? "TEXT" : "TEXT";
}

function resolveModelIdNumeric(
  modelDef: { fields?: Record<string, { type?: string | string[] }> },
  globalUseNumberId: boolean,
): boolean {
  const idType = modelDef.fields?.id?.type;
  if (typeof idType === "string") {
    return idType === "number";
  }
  if (Array.isArray(idType)) {
    return idType.includes("number");
  }
  return globalUseNumberId;
}

async function listExistingTables(sql: SQL, provider: ContractProvider): Promise<string[]> {
  if (provider === "pg") {
    const rows = (await sql.unsafe<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    )) as unknown as { tablename: string }[];
    return rows.map((row) => row.tablename);
  }
  if (provider === "mysql") {
    const rows = (await sql.unsafe<Record<string, unknown>>(
      "SHOW TABLES",
    )) as unknown as Record<string, unknown>[];
    return rows
      .map((row) => Object.values(row)[0])
      .filter((name): name is string => typeof name === "string");
  }
  const rows = (await sql.unsafe<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  )) as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

async function dropAllTables(sql: SQL, provider: ContractProvider): Promise<void> {
  const tables = await listExistingTables(sql, provider);
  if (tables.length === 0) {
    return;
  }
  if (provider === "mysql") {
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of tables) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${q(provider, table)}`);
    }
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");
    return;
  }
  if (provider === "pg") {
    for (const table of tables) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${q(provider, table)} CASCADE`);
    }
    return;
  }
  await sql.unsafe("PRAGMA foreign_keys = OFF");
  for (const table of tables) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${q(provider, table)}`);
  }
  await sql.unsafe("PRAGMA foreign_keys = ON");
}

function baseOptions(): BetterAuthOptions {
  return {
    secret: SECRET,
    emailAndPassword: {
      enabled: true,
      password: {
        hash: async (password: string) => password,
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          hash === password,
      },
    },
    database: {
      defaultFindLimit: 100,
    },
  } as BetterAuthOptions;
}

export function createContractContext(provider: ContractProvider) {
  const createSql = () =>
    provider === "mysql" ? new SQL(MYSQL_URL) : provider === "pg" ? new SQL(PG_URL) : new SQL("sqlite://:memory:");
  let sql = createSql();

  const adapter = async () =>
    bunSqlAdapter(sql, {
      provider,
      transaction: true,
      supportsJoin: true,
    });

  const runMigrations = async (options: BetterAuthOptions) => {
    const authTables = getAuthTables(options);
    const useNumberId = Boolean(
      (options as any)?.advanced?.database?.generateId === "number" ||
        (options as any)?.advanced?.database?.useNumberId,
    );

    if (provider === "pg") {
      await sql.close();
      sql = createSql();
    }
    await dropAllTables(sql, provider);
    const ordered = Object.entries(authTables).sort(
      (a, b) => (a[1].order ?? 0) - (b[1].order ?? 0),
    );

    for (const [_modelKey, modelDef] of ordered) {
      const modelName = modelDef.modelName;
      const columns: string[] = [];
      const modelUsesNumberId = resolveModelIdNumeric(
        modelDef as { fields?: Record<string, { type?: string | string[] }> },
        useNumberId,
      );

      if (modelUsesNumberId) {
        columns.push(
          provider === "mysql"
            ? `${q(provider, "id")} BIGINT AUTO_INCREMENT PRIMARY KEY`
            : provider === "pg"
              ? `${q(provider, "id")} BIGSERIAL PRIMARY KEY`
            : `${q(provider, "id")} INTEGER PRIMARY KEY AUTOINCREMENT`,
        );
      } else {
        columns.push(
          provider === "mysql"
            ? `${q(provider, "id")} VARCHAR(191) PRIMARY KEY`
            : provider === "pg"
              ? `${q(provider, "id")} VARCHAR(191) PRIMARY KEY`
            : `${q(provider, "id")} TEXT PRIMARY KEY`,
        );
      }

      for (const [fieldKey, fieldDef] of Object.entries(modelDef.fields ?? {})) {
        const fieldName = fieldDef.fieldName ?? fieldKey;
        const type = columnType(provider, String(fieldDef.type), modelUsesNumberId);
        const required = fieldDef.required ? "NOT NULL" : "NULL";
        let defaultClause = "";
        if (
          fieldDef.defaultValue !== undefined &&
          fieldDef.defaultValue !== null &&
          typeof fieldDef.defaultValue !== "function"
        ) {
          if (typeof fieldDef.defaultValue === "string") {
            defaultClause = ` DEFAULT '${fieldDef.defaultValue.replace(/'/g, "''")}'`;
          } else if (typeof fieldDef.defaultValue === "boolean") {
            defaultClause =
              provider === "pg"
                ? ` DEFAULT ${fieldDef.defaultValue ? "TRUE" : "FALSE"}`
                : ` DEFAULT ${fieldDef.defaultValue ? 1 : 0}`;
          } else {
            defaultClause = ` DEFAULT ${String(fieldDef.defaultValue)}`;
          }
        }
        let refClause = "";
        if (fieldDef.references?.model && fieldDef.references?.field) {
          const refModel = authTables[fieldDef.references.model]?.modelName ?? fieldDef.references.model;
          refClause = ` REFERENCES ${qTable(provider, refModel)}(${q(provider, fieldDef.references.field)})`;
          if (fieldDef.references.onDelete) {
            refClause += ` ON DELETE ${fieldDef.references.onDelete.toUpperCase()}`;
          }
        }
        columns.push(`${q(provider, fieldName)} ${type} ${required}${defaultClause}${refClause}`);
      }

      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS ${qTable(provider, modelName)} (${columns.join(", ")})`,
      );

      for (const [fieldKey, fieldDef] of Object.entries(modelDef.fields ?? {})) {
        const fieldName = fieldDef.fieldName ?? fieldKey;
        if (fieldDef.unique) {
          await sql.unsafe(
            `CREATE UNIQUE INDEX ${q(
              provider,
              indexName([modelName, fieldName, "unique"]),
            )} ON ${qTable(provider, modelName)} (${q(provider, fieldName)})`,
          );
        } else if (fieldDef.index) {
          await sql.unsafe(
            `CREATE INDEX ${q(
              provider,
              indexName([modelName, fieldName, "idx"]),
            )} ON ${qTable(provider, modelName)} (${q(provider, fieldName)})`,
          );
        }
      }
    }
  };

  return {
    sql,
    adapter,
    runMigrations,
    overrideBetterAuthOptions: (overrides?: BetterAuthOptions): BetterAuthOptions =>
      ({ ...baseOptions(), ...(overrides ?? {}) }) as BetterAuthOptions,
    onFinish: async () => {
      await sql.close();
    },
  };
}
