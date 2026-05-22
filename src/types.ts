import type { BetterAuthOptions } from "@better-auth/core";
import type {
  DBAdapter,
  DBAdapterDebugLogOption,
} from "@better-auth/core/db/adapter";

export type BunSqlProvider = "pg" | "mysql" | "sqlite";

export type BunSqlUnsafeClient = {
  unsafe<T = any>(query: string, values?: unknown[]): Promise<T[]>;
  begin?<T>(callback: (tx: BunSqlUnsafeClient) => Promise<T>): Promise<T>;
};

export type BunSqlAdapterConfig = {
  provider: BunSqlProvider;
  usePlural?: boolean;
  debugLogs?: DBAdapterDebugLogOption;
  transaction?: boolean;
  supportsJoin?: boolean;
};

export type BunSqlAdapterInstance = (
  options: BetterAuthOptions,
) => DBAdapter<BetterAuthOptions>;
