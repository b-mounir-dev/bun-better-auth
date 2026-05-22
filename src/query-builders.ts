import type { CleanedWhere } from "@better-auth/core/db/adapter";
import type { BunSqlProvider } from "./types";

type WhereBuildResult = {
  sql: string;
  params: unknown[];
};

type BuildWhereClauseArgs = {
  where?: CleanedWhere[];
  provider: BunSqlProvider;
  resolveField: (field: string) => string;
  startIndex?: number;
};

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSafeIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Unsafe SQL identifier: "${value}"`);
  }
  return value;
}

export function quoteIdentifier(
  provider: BunSqlProvider,
  identifier: string,
): string {
  const safe = assertSafeIdentifier(identifier);
  return provider === "mysql" ? `\`${safe}\`` : `"${safe}"`;
}

export function quoteTablePath(
  provider: BunSqlProvider,
  tablePath: string,
): string {
  return tablePath
    .split(".")
    .map((part) => quoteIdentifier(provider, part))
    .join(".");
}

export function quoteColumn(
  provider: BunSqlProvider,
  alias: string,
  field: string,
): string {
  return `${quoteIdentifier(provider, alias)}.${quoteIdentifier(provider, field)}`;
}

function placeholder(provider: BunSqlProvider, index: number): string {
  return provider === "pg" ? `$${index}` : "?";
}

function insensitiveFieldExpr(provider: BunSqlProvider, columnExpr: string): string {
  if (provider === "pg") {
    return `LOWER(${columnExpr})`;
  }
  return `LOWER(${columnExpr})`;
}

function pushParam(
  provider: BunSqlProvider,
  params: unknown[],
  value: unknown,
  index: number,
): string {
  params.push(value);
  return placeholder(provider, index);
}

export function buildWhereClause({
  where,
  provider,
  resolveField,
  startIndex = 1,
}: BuildWhereClauseArgs): WhereBuildResult {
  if (!where || where.length === 0) {
    return { sql: "", params: [] };
  }

  const andClauses: string[] = [];
  const orClauses: string[] = [];
  const params: unknown[] = [];

  const currentIndex = () => startIndex + params.length;

  for (const condition of where) {
    const field = resolveField(condition.field);
    const operator = condition.operator ?? "eq";
    const connector = condition.connector ?? "AND";
    const mode = condition.mode ?? "sensitive";
    const value = condition.value;
    const isInsensitive =
      mode === "insensitive" &&
      (typeof value === "string" ||
        (Array.isArray(value) && value.every((item) => typeof item === "string")));

    let clause = "";

    if (operator === "in" || operator === "not_in") {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) {
        clause = operator === "in" ? "1 = 0" : "1 = 1";
      } else {
        const expr = isInsensitive
          ? insensitiveFieldExpr(provider, field)
          : field;
        const placeholders = values.map((entry) => {
          const normalized =
            isInsensitive && typeof entry === "string" ? entry.toLowerCase() : entry;
          return pushParam(provider, params, normalized, currentIndex());
        });
        const sqlOperator = operator === "in" ? "IN" : "NOT IN";
        clause = `${expr} ${sqlOperator} (${placeholders.join(", ")})`;
      }
    } else if (operator === "contains" || operator === "starts_with" || operator === "ends_with") {
      const strValue = String(value ?? "");
      const pattern =
        operator === "contains"
          ? `%${strValue}%`
          : operator === "starts_with"
            ? `${strValue}%`
            : `%${strValue}`;
      const paramValue =
        isInsensitive && provider !== "pg" ? pattern.toLowerCase() : pattern;
      const marker = pushParam(provider, params, paramValue, currentIndex());
      if (isInsensitive && provider === "pg") {
        clause = `${field} ILIKE ${marker}`;
      } else if (isInsensitive) {
        clause = `${insensitiveFieldExpr(provider, field)} LIKE ${marker}`;
      } else {
        clause = `${field} LIKE ${marker}`;
      }
    } else if (operator === "eq" || operator === "ne") {
      if (value === null) {
        clause = operator === "eq" ? `${field} IS NULL` : `${field} IS NOT NULL`;
      } else {
        const sqlOperator = operator === "eq" ? "=" : "<>";
        if (isInsensitive && typeof value === "string") {
          const normalized = value.toLowerCase();
          const marker = pushParam(provider, params, normalized, currentIndex());
          const expr = insensitiveFieldExpr(provider, field);
          clause = `${expr} ${sqlOperator} ${marker}`;
        } else if (
          provider === "mysql" &&
          mode === "sensitive" &&
          typeof value === "string"
        ) {
          const marker = pushParam(provider, params, value, currentIndex());
          clause = `BINARY ${field} ${sqlOperator} BINARY ${marker}`;
        } else {
          const marker = pushParam(provider, params, value, currentIndex());
          clause = `${field} ${sqlOperator} ${marker}`;
        }
      }
    } else {
      const sqlOperator =
        operator === "gt"
          ? ">"
          : operator === "gte"
            ? ">="
            : operator === "lt"
              ? "<"
              : "<=";
      const marker = pushParam(provider, params, value, currentIndex());
      clause = `${field} ${sqlOperator} ${marker}`;
    }

    if (connector === "OR") {
      orClauses.push(clause);
    } else {
      andClauses.push(clause);
    }
  }

  const composed: string[] = [];
  if (andClauses.length > 0) {
    composed.push(andClauses.length === 1 ? andClauses[0]! : `(${andClauses.join(" AND ")})`);
  }
  if (orClauses.length > 0) {
    composed.push(orClauses.length === 1 ? orClauses[0]! : `(${orClauses.join(" OR ")})`);
  }

  return {
    sql: composed.length > 0 ? `WHERE ${composed.join(" AND ")}` : "",
    params,
  };
}

export function extractAffectedCount(result: unknown): number {
  if (typeof result === "number") {
    return result;
  }
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as Record<string, unknown>;
    const candidates = [
      first.affectedRows,
      first.rowCount,
      first.changes,
      first.count,
      first.numUpdatedRows,
      first.numDeletedRows,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "number") {
        return candidate;
      }
      if (typeof candidate === "bigint") {
        return Number(candidate);
      }
      if (typeof candidate === "string" && candidate.length > 0) {
        const parsed = Number(candidate);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
  }
  return 0;
}
