# bun-better-auth

A [Better Auth](https://better-auth.com) database adapter that uses Bun's built-in SQL client (`Bun.sql` / `new SQL(...)`) — no extra database drivers needed.

Supports **PostgreSQL**, **MySQL**, and **SQLite** out of the box.

[![npm version](https://img.shields.io/npm/v/bun-better-auth.svg)](https://www.npmjs.com/package/bun-better-auth)

> **Note:** This library is actively developed. Feedback and contributions are welcome — open an issue or PR on [GitHub](https://github.com/b-mounir-dev/bun-better-auth).

## Installation

```bash
bun add bun-better-auth
```

## Quick start

```ts
import { betterAuth } from "better-auth";
import { SQL } from "bun";
import { bunSqlAdapter } from "bun-better-auth";

const sql = new SQL(process.env.DATABASE_URL!);

export const auth = betterAuth({
  database: bunSqlAdapter(sql, { provider: "pg" }),
});
```

That's it. Pass the adapter to `database` and Better Auth handles the rest.

## Providers

Set `provider` to match your database:

| Provider | Value |
|---|---|
| PostgreSQL | `"pg"` |
| MySQL | `"mysql"` |
| SQLite | `"sqlite"` |

### PostgreSQL

```ts
import { SQL } from "bun";
import { bunSqlAdapter } from "bun-better-auth";

const sql = new SQL("postgres://user:pass@localhost:5432/mydb");

export const auth = betterAuth({
  database: bunSqlAdapter(sql, { provider: "pg" }),
});
```

### MySQL

```ts
import { SQL } from "bun";
import { bunSqlAdapter } from "bun-better-auth";

const sql = new SQL("mysql://user:pass@localhost:3306/mydb");

export const auth = betterAuth({
  database: bunSqlAdapter(sql, { provider: "mysql" }),
});
```

### SQLite

```ts
import { SQL } from "bun";
import { bunSqlAdapter } from "bun-better-auth";

const sql = new SQL("sqlite://./mydb.sqlite");

export const auth = betterAuth({
  database: bunSqlAdapter(sql, { provider: "sqlite" }),
});
```

## Configuration

```ts
bunSqlAdapter(sql, {
  provider: "pg",       // required — "pg" | "mysql" | "sqlite"
  usePlural: false,     // use plural table names (e.g. "users" instead of "user")
  transaction: true,    // wrap mutations in transactions when supported (default: true)
  debugLogs: false,     // log generated SQL queries for debugging
})
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `provider` | `"pg" \| "mysql" \| "sqlite"` | — | **Required.** Your database type. |
| `usePlural` | `boolean` | `false` | Use plural table names (`users`, `sessions`, …). |
| `transaction` | `boolean` | `true` | Wrap mutations in a transaction via `sql.begin()`. Set to `false` if your client doesn't support it. |
| `debugLogs` | `boolean \| object` | `false` | Enable SQL query logging. Accepts a Better Auth debug log config. |

## Transactions

By default the adapter wraps write operations in a transaction using `sql.begin()`. If your `SQL` client was created without transaction support, pass `transaction: false`:

```ts
bunSqlAdapter(sql, {
  provider: "pg",
  transaction: false,
});
```

## Using `Bun.sql` directly

If you use the global `Bun.sql` shorthand instead of `new SQL(...)`, pass it in the same way:

```ts
import { bunSqlAdapter } from "bun-better-auth";

export const auth = betterAuth({
  database: bunSqlAdapter(Bun.sql, { provider: "pg" }),
});
```

## Schema generation

`bun-better-auth` supports Better Auth CLI schema generation for the `bun-sql` adapter. Run the following command to generate your schema SQL:

```bash
bun x --bun auth@latest generate
```

This outputs the SQL for your tables. Apply it to your database manually — schema migration is not handled by this adapter.

Refer to the [Better Auth docs](https://better-auth.com/docs/concepts/database) for full schema guidance.

## TypeScript

All exported types are available if you need them:

```ts
import type {
  BunSqlAdapterConfig,
  BunSqlAdapterInstance,
  BunSqlProvider,
} from "bun-better-auth";
```

## License

MIT
