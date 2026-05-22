import type { BetterAuthOptions } from "@better-auth/core";
import type {
  AdapterFactoryCustomizeAdapterCreator,
  AdapterFactoryOptions,
  CleanedWhere,
  DBAdapter,
  JoinConfig,
} from "@better-auth/core/db/adapter";
import { createAdapterFactory } from "@better-auth/core/db/adapter";
import { buildJoinParts, processJoinedRows } from "./join-builder";
import {
  buildWhereClause,
  extractAffectedCount,
  quoteColumn,
  quoteIdentifier,
  quoteTablePath,
} from "./query-builders";
import type {
  BunSqlAdapterConfig,
  BunSqlAdapterInstance,
  BunSqlProvider,
  BunSqlUnsafeClient,
} from "./types";

type AdapterFactoryContext = Parameters<AdapterFactoryCustomizeAdapterCreator>[0];

type SchemaFieldDefinition = {
  type?: string | string[];
  required?: boolean;
  defaultValue?: unknown;
  unique?: boolean;
  index?: boolean;
  fieldName?: string;
  references?: {
    model?: string;
    field?: string;
    onDelete?: string;
  };
};

type SchemaModelDefinition = {
  modelName: string;
  fields?: Record<string, SchemaFieldDefinition>;
  order?: number;
};

type SchemaTables = Record<string, SchemaModelDefinition>;
type BetterAuthAdvancedOptions = {
  database?: {
    generateId?: string;
    useNumberId?: boolean;
  };
};

function schemaIndexName(parts: string[]): string {
  return parts.join("_").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 55);
}

function resolveModelUsesNumberId(
  modelDef: SchemaModelDefinition,
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

function resolveSchemaColumnType(
  provider: BunSqlProvider,
  fieldType: string,
  modelUsesNumberId: boolean,
): string {
  if (fieldType === "string") {
    return provider === "mysql" ? "VARCHAR(512)" : "TEXT";
  }
  if (fieldType === "number") {
    return provider === "mysql" ? "DOUBLE" : provider === "pg" ? "DOUBLE PRECISION" : "REAL";
  }
  if (fieldType === "boolean") {
    return provider === "sqlite" ? "INTEGER" : "BOOLEAN";
  }
  if (fieldType === "date") {
    return provider === "sqlite" ? "TEXT" : "TIMESTAMP(3)";
  }
  if (fieldType === "json" || fieldType.endsWith("[]")) {
    return provider === "pg" ? "JSONB" : provider === "mysql" ? "JSON" : "TEXT";
  }
  if (modelUsesNumberId) {
    return provider === "sqlite" ? "INTEGER" : "BIGINT";
  }
  return provider === "mysql" ? "VARCHAR(512)" : "TEXT";
}

function buildSchemaDefaultClause(
  provider: BunSqlProvider,
  defaultValue: unknown,
): string {
  if (defaultValue === undefined || defaultValue === null || typeof defaultValue === "function") {
    return "";
  }
  if (typeof defaultValue === "string") {
    return ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
  }
  if (typeof defaultValue === "boolean") {
    if (provider === "pg") {
      return ` DEFAULT ${defaultValue ? "TRUE" : "FALSE"}`;
    }
    return ` DEFAULT ${defaultValue ? 1 : 0}`;
  }
  return ` DEFAULT ${String(defaultValue)}`;
}

function createSchemaCode(
  provider: BunSqlProvider,
  tables: SchemaTables,
  useNumberId: boolean,
): string {
  const statements: string[] = [];
  const orderedModels = Object.entries(tables).sort(
    (a, b) => (a[1].order ?? 0) - (b[1].order ?? 0),
  );

  for (const [modelKey, modelDef] of orderedModels) {
    const modelName = modelDef.modelName;
    const columns: string[] = [];
    const modelUsesNumberId = resolveModelUsesNumberId(modelDef, useNumberId);

    if (modelUsesNumberId) {
      columns.push(
        provider === "mysql"
          ? `${quoteIdentifier(provider, "id")} BIGINT AUTO_INCREMENT PRIMARY KEY`
          : provider === "pg"
            ? `${quoteIdentifier(provider, "id")} BIGSERIAL PRIMARY KEY`
            : `${quoteIdentifier(provider, "id")} INTEGER PRIMARY KEY AUTOINCREMENT`,
      );
    } else {
      columns.push(
        provider === "sqlite"
          ? `${quoteIdentifier(provider, "id")} TEXT PRIMARY KEY`
          : `${quoteIdentifier(provider, "id")} VARCHAR(191) PRIMARY KEY`,
      );
    }

    for (const [fieldKey, fieldDef] of Object.entries(modelDef.fields ?? {})) {
      if (fieldKey === "id") {
        continue;
      }
      const fieldName = fieldDef.fieldName ?? fieldKey;
      const fieldTypeRaw = fieldDef.type;
      const fieldType = Array.isArray(fieldTypeRaw)
        ? String(fieldTypeRaw[0] ?? "string")
        : String(fieldTypeRaw ?? "string");
      const columnType = resolveSchemaColumnType(provider, fieldType, modelUsesNumberId);
      const requiredClause = fieldDef.required ? "NOT NULL" : "NULL";
      const defaultClause = buildSchemaDefaultClause(provider, fieldDef.defaultValue);
      let referenceClause = "";
      if (fieldDef.references?.model && fieldDef.references?.field) {
        const refModelName = tables[fieldDef.references.model]?.modelName ?? fieldDef.references.model;
        referenceClause = ` REFERENCES ${quoteTablePath(provider, refModelName)}(${quoteIdentifier(
          provider,
          fieldDef.references.field,
        )})`;
        if (fieldDef.references.onDelete) {
          referenceClause += ` ON DELETE ${fieldDef.references.onDelete.toUpperCase()}`;
        }
      }
      columns.push(
        `${quoteIdentifier(provider, fieldName)} ${columnType} ${requiredClause}${defaultClause}${referenceClause}`,
      );
    }

    statements.push(
      `CREATE TABLE IF NOT EXISTS ${quoteTablePath(provider, modelName)} (${columns.join(", ")});`,
    );

    for (const [fieldKey, fieldDef] of Object.entries(modelDef.fields ?? {})) {
      const fieldName = fieldDef.fieldName ?? fieldKey;
      if (fieldDef.unique) {
        statements.push(
          `CREATE UNIQUE INDEX ${quoteIdentifier(
            provider,
            schemaIndexName([modelName, fieldName, "unique"]),
          )} ON ${quoteTablePath(provider, modelName)} (${quoteIdentifier(provider, fieldName)});`,
        );
      } else if (fieldDef.index) {
        statements.push(
          `CREATE INDEX ${quoteIdentifier(
            provider,
            schemaIndexName([modelName, fieldName, "idx"]),
          )} ON ${quoteTablePath(provider, modelName)} (${quoteIdentifier(provider, fieldName)});`,
        );
      }
    }
  }

  return statements.join("\n");
}

function getDefaultSchemaPath(provider: BunSqlProvider): string {
  if (provider === "pg") {
    return "./auth-schema.pg.sql";
  }
  if (provider === "mysql") {
    return "./auth-schema.mysql.sql";
  }
  return "./auth-schema.sqlite.sql";
}

function supportsReturning(provider: BunSqlProvider): boolean {
  return provider === "pg" || provider === "sqlite";
}

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function formatDateForMysql(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms}`;
}

function parseMysqlDateString(value: string): Date | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/,
  );
  if (!match) {
    return toValidDate(value);
  }
  const [, y, m, d, hh = "00", mm = "00", ss = "00", micro = "0"] = match;
  const millis = Math.floor(Number(micro.padEnd(3, "0").slice(0, 3)));
  return new Date(
    Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss),
      millis,
    ),
  );
}

function normalizeMysqlDateValue(value: Date | string): Date | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return new Date(
      Date.UTC(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
      ),
    );
  }
  return parseMysqlDateString(value);
}

async function runUnsafe<T = Record<string, unknown>>(
  sql: BunSqlUnsafeClient,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return sql.unsafe<T>(query, params);
}

function getModelFieldsFromSchema(
  schema: Record<string, any>,
  getDefaultModelName: (model: string) => string,
  model: string,
): string[] {
  const defaultModel = getDefaultModelName(model);
  const modelSchema = schema[defaultModel];
  if (!modelSchema?.fields) {
    return [];
  }
  return Object.keys(modelSchema.fields);
}

export const bunSqlAdapter = (
  sql: BunSqlUnsafeClient,
  config: BunSqlAdapterConfig,
): BunSqlAdapterInstance => {
  let lazyOptions: BetterAuthOptions | null = null;

  type CustomAdapterRuntimeOptions = {
    canBeginTransaction: boolean;
  };

  const createCustomAdapter =
    (
      client: BunSqlUnsafeClient,
      runtime: CustomAdapterRuntimeOptions,
    ): AdapterFactoryCustomizeAdapterCreator =>
    ({
      getFieldName,
      getModelName,
      getDefaultModelName,
      schema,
      options,
    }: AdapterFactoryContext) => {
      const provider = config.provider;

      const tableSql = (model: string) => quoteTablePath(provider, model);
      const alias = (value: string) => quoteIdentifier(provider, value);

      const selectColumns = (model: string, modelAlias: string, select?: string[]) => {
        if (!select || select.length === 0) {
          return [`${alias(modelAlias)}.*`];
        }
        return select.map((field) => {
          const dbField = getFieldName({ model, field });
          return quoteColumn(provider, modelAlias, dbField);
        });
      };

      const baseWhereResolver =
        (model: string, tableAlias: string) =>
        (field: string): string => {
          const dbField = getFieldName({ model, field });
          return quoteColumn(provider, tableAlias, dbField);
        };

      const fetchLatestInsertedRow = async (
        model: string,
        data: Record<string, unknown>,
      ): Promise<Record<string, unknown> | null> => {
        const defaultIdField = getFieldName({ model, field: "id" });
        const knownKey = data[defaultIdField] ?? data.id;
        if (knownKey !== undefined && knownKey !== null) {
          const where = buildWhereClause({
            provider,
            resolveField: baseWhereResolver(model, "t"),
            where: [
              {
                field: "id",
                value: knownKey as string | number | boolean | Date,
                operator: "eq",
                connector: "AND",
                mode: "sensitive",
              },
            ] as CleanedWhere[],
          });
          const rows = await runUnsafe<Record<string, unknown>>(
            client,
            `SELECT ${alias("t")}.* FROM ${tableSql(model)} ${alias("t")} ${where.sql} LIMIT 1`,
            where.params,
          );
          return rows[0] ?? null;
        }

        const rows = await runUnsafe<Record<string, unknown>>(
          client,
          `SELECT ${alias("t")}.* FROM ${tableSql(model)} ${alias("t")} ORDER BY ${quoteColumn(provider, "t", defaultIdField)} DESC LIMIT 1`,
          [],
        );
        return rows[0] ?? null;
      };

      const mapJoinResult = (
        model: string,
        rows: Record<string, unknown>[],
        join: JoinConfig | undefined,
        descriptors: ReturnType<typeof buildJoinParts>["selectDescriptors"],
      ): Record<string, unknown>[] => {
        const idField = getFieldName({ model, field: "id" });
        return processJoinedRows({
          rows,
          join,
          getModelName,
          getFieldName,
          selectDescriptors: descriptors,
          mainIdField: idField,
        });
      };

      return {
        options: {
          provider: config.provider,
        },
        async createSchema({ file, tables }) {
          const advancedOptions = (
            options as BetterAuthOptions & { advanced?: BetterAuthAdvancedOptions }
          ).advanced;
          const useNumberId = Boolean(
            advancedOptions?.database?.generateId === "number" ||
              advancedOptions?.database?.useNumberId,
          );
          const code = createSchemaCode(
            provider,
            tables as SchemaTables,
            useNumberId,
          );
          return {
            code,
            path: file ?? getDefaultSchemaPath(provider),
            overwrite: true,
          };
        },
        async create({ data, model }) {
          const fields = Object.keys(data);
          const params = fields.map((field) => data[field]);
          const placeholders = fields
            .map((_, index) => (provider === "pg" ? `$${index + 1}` : "?"))
            .join(", ");
          const fieldList = fields
            .map((field) => quoteIdentifier(provider, field))
            .join(", ");

          const insertQueryBase = `INSERT INTO ${tableSql(model)} (${fieldList}) VALUES (${placeholders})`;
          if (supportsReturning(provider)) {
            const rows = await runUnsafe<Record<string, unknown>>(
              client,
              `${insertQueryBase} RETURNING *`,
              params,
            );
            return (rows[0] ?? null) as any;
          }

          await runUnsafe(client, insertQueryBase, params);
          return (await fetchLatestInsertedRow(model, data)) as any;
        },
        async findOne({ model, where, select, join }) {
          const mainAlias = "t";
          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: baseWhereResolver(model, mainAlias),
          });
          const joinParts = buildJoinParts({
            provider,
            baseAlias: mainAlias,
            join,
            getModelName,
            getFieldName,
            getModelFields: (joinModel) =>
              getModelFieldsFromSchema(schema as Record<string, any>, getDefaultModelName, joinModel),
          });

          const selectParts = [
            ...selectColumns(model, mainAlias, select),
            ...joinParts.selectSql,
          ];
          const query = `SELECT ${selectParts.join(", ")} FROM ${tableSql(model)} ${alias(mainAlias)}${joinParts.joinSql} ${whereResult.sql} LIMIT 1`;
          const rows = await runUnsafe<Record<string, unknown>>(
            client,
            query,
            whereResult.params,
          );
          if (rows.length === 0) {
            return null;
          }
          if (!join) {
            return rows[0] as any;
          }
          return (mapJoinResult(model, rows, join, joinParts.selectDescriptors)[0] ??
            null) as any;
        },
        async findMany({ model, where, limit, select, sortBy, offset, join }) {
          const mainAlias = "t";
          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: baseWhereResolver(model, mainAlias),
          });
          const joinParts = buildJoinParts({
            provider,
            baseAlias: mainAlias,
            join,
            getModelName,
            getFieldName,
            getModelFields: (joinModel) =>
              getModelFieldsFromSchema(schema as Record<string, any>, getDefaultModelName, joinModel),
          });
          const selectParts = [
            ...selectColumns(model, mainAlias, select),
            ...joinParts.selectSql,
          ];

          const params = [...whereResult.params];
          const suffix: string[] = [];
          if (sortBy) {
            suffix.push(
              `ORDER BY ${quoteColumn(provider, mainAlias, getFieldName({ model, field: sortBy.field }))} ${sortBy.direction.toUpperCase()}`,
            );
          }
          if (limit !== undefined) {
            params.push(limit);
            suffix.push(`LIMIT ${provider === "pg" ? `$${params.length}` : "?"}`);
          } else {
            params.push(options.database?.defaultFindLimit ?? 100);
            suffix.push(`LIMIT ${provider === "pg" ? `$${params.length}` : "?"}`);
          }
          if (offset !== undefined) {
            params.push(offset);
            suffix.push(`OFFSET ${provider === "pg" ? `$${params.length}` : "?"}`);
          }

          const query = `SELECT ${selectParts.join(", ")} FROM ${tableSql(model)} ${alias(mainAlias)}${joinParts.joinSql} ${whereResult.sql} ${suffix.join(" ")}`;
          const rows = await runUnsafe<Record<string, unknown>>(client, query, params);
          if (!join) {
            return rows as any;
          }
          return mapJoinResult(model, rows, join, joinParts.selectDescriptors) as any;
        },
        async update({ model, where, update }) {
          const updateRecord = update as Record<string, unknown>;
          const fields = Object.keys(updateRecord);
          if (fields.length === 0) {
            return null;
          }
          const setParts: string[] = [];
          const params: unknown[] = [];
          for (const field of fields) {
            params.push(updateRecord[field]);
            setParts.push(
              `${quoteIdentifier(provider, field)} = ${
                provider === "pg" ? `$${params.length}` : "?"
              }`,
            );
          }

          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: (field) => quoteIdentifier(provider, getFieldName({ model, field })),
            startIndex: params.length + 1,
          });
          params.push(...whereResult.params);

          if (supportsReturning(provider)) {
            const rows = await runUnsafe<Record<string, unknown>>(
              client,
              `UPDATE ${tableSql(model)} SET ${setParts.join(", ")} ${whereResult.sql} RETURNING *`,
              params,
            );
            return (rows[0] ?? null) as any;
          }

          await runUnsafe(
            client,
            `UPDATE ${tableSql(model)} SET ${setParts.join(", ")} ${whereResult.sql}`,
            params,
          );
          const whereForRead: CleanedWhere[] = where.slice(0, 1) as CleanedWhere[];
          if (whereForRead.length === 0) {
            return null;
          }
          const readWhere = buildWhereClause({
            where: whereForRead,
            provider,
            resolveField: baseWhereResolver(model, "t"),
          });
          const rows = await runUnsafe<Record<string, unknown>>(
            client,
            `SELECT ${alias("t")}.* FROM ${tableSql(model)} ${alias("t")} ${readWhere.sql} LIMIT 1`,
            readWhere.params,
          );
          return (rows[0] ?? null) as any;
        },
        async updateMany({ model, where, update }) {
          const updateRecord = update as Record<string, unknown>;
          const fields = Object.keys(updateRecord);
          if (fields.length === 0) {
            return 0;
          }
          const params: unknown[] = [];
          const setParts = fields.map((field) => {
            params.push(updateRecord[field]);
            return `${quoteIdentifier(provider, field)} = ${
              provider === "pg" ? `$${params.length}` : "?"
            }`;
          });
          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: (field) => quoteIdentifier(provider, getFieldName({ model, field })),
            startIndex: params.length + 1,
          });
          params.push(...whereResult.params);

          const result = await runUnsafe(
            client,
            `UPDATE ${tableSql(model)} SET ${setParts.join(", ")} ${whereResult.sql}`,
            params,
          );
          const affected = extractAffectedCount(result);
          if (provider === "mysql" && affected === 0) {
            const rowCountRows = await runUnsafe<Record<string, unknown>>(
              client,
              "SELECT ROW_COUNT() AS affectedRows",
            );
            return extractAffectedCount(rowCountRows);
          }
          return affected;
        },
        async count({ model, where }) {
          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: baseWhereResolver(model, "t"),
          });
          const rows = await runUnsafe<Record<string, unknown>>(
            client,
            `SELECT COUNT(*) AS count FROM ${tableSql(model)} ${alias("t")} ${whereResult.sql}`,
            whereResult.params,
          );
          const value = rows[0]?.count;
          if (typeof value === "number") {
            return value;
          }
          if (typeof value === "bigint") {
            return Number(value);
          }
          if (typeof value === "string") {
            return Number(value);
          }
          return 0;
        },
        async delete({ model, where }) {
          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: (field) => quoteIdentifier(provider, getFieldName({ model, field })),
          });
          await runUnsafe(
            client,
            `DELETE FROM ${tableSql(model)} ${whereResult.sql}`,
            whereResult.params,
          );
        },
        async deleteMany({ model, where }) {
          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: (field) => quoteIdentifier(provider, getFieldName({ model, field })),
          });
          const result = await runUnsafe(
            client,
            `DELETE FROM ${tableSql(model)} ${whereResult.sql}`,
            whereResult.params,
          );
          const affected = extractAffectedCount(result);
          if (provider === "mysql" && affected === 0) {
            const rowCountRows = await runUnsafe<Record<string, unknown>>(
              client,
              "SELECT ROW_COUNT() AS affectedRows",
            );
            return extractAffectedCount(rowCountRows);
          }
          return affected;
        },
        async consumeOne({ model, where }) {
          const idField = getFieldName({ model, field: "id" });
          if (provider === "mysql") {
            const runInTransaction = runtime.canBeginTransaction && typeof client.begin === "function";
            const claim = async (tx: BunSqlUnsafeClient) => {
              const whereResult = buildWhereClause({
                where,
                provider,
                resolveField: baseWhereResolver(model, "t"),
              });
              const selected = await runUnsafe<Record<string, unknown>>(
                tx,
                `SELECT ${alias("t")}.* FROM ${tableSql(model)} ${alias("t")} ${whereResult.sql} LIMIT 1 FOR UPDATE`,
                whereResult.params,
              );
              const target = selected[0];
              if (!target) {
                return null;
              }
              await runUnsafe(
                tx,
                `DELETE FROM ${tableSql(model)} WHERE ${quoteIdentifier(provider, idField)} = ?`,
                [target[idField]],
              );
              return target;
            };
            if (runInTransaction) {
              return client.begin!(claim) as Promise<any>;
            }
            return claim(client) as Promise<any>;
          }

          const whereResult = buildWhereClause({
            where,
            provider,
            resolveField: baseWhereResolver(model, "t"),
          });
          const query = `DELETE FROM ${tableSql(model)} WHERE ${quoteIdentifier(
            provider,
            idField,
          )} IN (SELECT ${quoteColumn(provider, "t", idField)} FROM ${tableSql(model)} ${alias(
            "t",
          )} ${whereResult.sql} LIMIT 1) RETURNING *`;
          const rows = await runUnsafe<Record<string, unknown>>(
            client,
            query,
            whereResult.params,
          );
          return (rows[0] ?? null) as any;
        },
      };
    };

  const adapterOptions: AdapterFactoryOptions = {
    config: {
      adapterId: "bun-sql",
      adapterName: "Bun SQL Adapter",
      usePlural: config.usePlural ?? false,
      debugLogs: config.debugLogs ?? false,
      supportsJSON: config.provider !== "sqlite",
      supportsDates: true,
      supportsBooleans: config.provider === "pg",
      supportsNumericIds: true,
      customTransformInput: ({ data, fieldAttributes }) => {
        if (fieldAttributes.type !== "date") {
          return data;
        }
        if (data === null || data === undefined) {
          return data;
        }
        const date = toValidDate(data);
        if (!date) {
          return data;
        }
        if (config.provider === "mysql") {
          return formatDateForMysql(date);
        }
        if (config.provider === "sqlite") {
          return date.toISOString();
        }
        return date;
      },
      customTransformOutput: ({ data, fieldAttributes }) => {
        if (fieldAttributes.type !== "date") {
          return data;
        }
        if (data === null || data === undefined) {
          return data;
        }
        if (config.provider === "mysql") {
          if (data instanceof Date || typeof data === "string") {
            return normalizeMysqlDateValue(data) ?? data;
          }
        }
        if (data instanceof Date) {
          return data;
        }
        return toValidDate(data) ?? data;
      },
      transaction:
        config.transaction === false
          ? false
          : async (callback) => {
              if (typeof sql.begin !== "function") {
                return callback(
                  createAdapterFactory({
                    config: {
                      ...adapterOptions.config,
                      transaction: false,
                    },
                    adapter: createCustomAdapter(sql, { canBeginTransaction: false }),
                  })(lazyOptions!) as Omit<DBAdapter<BetterAuthOptions>, "transaction">,
                );
              }
              return sql.begin(async (tx) => {
                const transactionalAdapter = createAdapterFactory({
                  config: {
                    ...adapterOptions.config,
                    transaction: false,
                  },
                  adapter: createCustomAdapter(tx, { canBeginTransaction: false }),
                })(lazyOptions!);
                return callback(
                  transactionalAdapter as Omit<DBAdapter<BetterAuthOptions>, "transaction">,
                );
              });
            },
    },
    adapter: createCustomAdapter(sql, {
      canBeginTransaction: config.transaction !== false,
    }),
  };

  const adapter = createAdapterFactory(adapterOptions);

  return (options: BetterAuthOptions) => {
    lazyOptions = options;
    return adapter(options);
  };
};
