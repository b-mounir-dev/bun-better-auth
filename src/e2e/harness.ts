import { SQL } from "bun";
import { bunSqlAdapter } from "../bun-sql-adapter";

export type E2EProvider = "pg" | "mysql" | "sqlite";

const E2E_SECRET = "test-secret-that-is-at-least-32-chars-long!!";

export function createSqlClient(provider: E2EProvider): SQL {
  if (provider === "pg") {
    return new SQL(
      process.env.BUN_BETTER_AUTH_PG_URL ??
        "postgres://postgres:postgres@localhost:5432/vostra_db",
    );
  }
  if (provider === "mysql") {
    return new SQL(
      process.env.BUN_BETTER_AUTH_MYSQL_URL ??
        "mysql://vostra_user:vostra_password@localhost:3306/vostra_db",
    );
  }
  return new SQL("sqlite://:memory:");
}

export function createAdapter(sql: SQL, provider: E2EProvider) {
  return bunSqlAdapter(sql, {
    provider,
    transaction: true,
  })({
    secret: E2E_SECRET,
    database: {
      defaultFindLimit: 100,
    },
  } as any);
}

export async function setupSchema(sql: SQL, provider: E2EProvider) {
  if (provider === "pg") {
    await sql.unsafe('DROP TABLE IF EXISTS "account" CASCADE');
    await sql.unsafe('DROP TABLE IF EXISTS "session" CASCADE');
    await sql.unsafe('DROP TABLE IF EXISTS "verification" CASCADE');
    await sql.unsafe('DROP TABLE IF EXISTS "user" CASCADE');

    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "user" (
      "id" VARCHAR(128) PRIMARY KEY,
      "name" VARCHAR(255) NULL,
      "email" VARCHAR(255) NOT NULL,
      "emailVerified" BOOLEAN NULL,
      "image" TEXT NULL,
      "createdAt" TIMESTAMP(3) NULL,
      "updatedAt" TIMESTAMP(3) NULL,
      CONSTRAINT "uq_user_email" UNIQUE ("email")
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "session" (
      "id" VARCHAR(128) PRIMARY KEY,
      "token" VARCHAR(255) NOT NULL,
      "expiresAt" TIMESTAMP(3) NULL,
      "createdAt" TIMESTAMP(3) NULL,
      "updatedAt" TIMESTAMP(3) NULL,
      "ipAddress" VARCHAR(255) NULL,
      "userAgent" TEXT NULL,
      "userId" VARCHAR(128) NOT NULL,
      CONSTRAINT "uq_session_token" UNIQUE ("token"),
      CONSTRAINT "fk_session_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "account" (
      "id" VARCHAR(128) PRIMARY KEY,
      "accountId" VARCHAR(255) NOT NULL,
      "providerId" VARCHAR(255) NOT NULL,
      "userId" VARCHAR(128) NOT NULL,
      "accessToken" TEXT NULL,
      "refreshToken" TEXT NULL,
      "idToken" TEXT NULL,
      "accessTokenExpiresAt" TIMESTAMP(3) NULL,
      "refreshTokenExpiresAt" TIMESTAMP(3) NULL,
      "scope" VARCHAR(255) NULL,
      "password" TEXT NULL,
      "createdAt" TIMESTAMP(3) NULL,
      "updatedAt" TIMESTAMP(3) NULL,
      CONSTRAINT "fk_account_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE,
      CONSTRAINT "uq_account_provider_account_id" UNIQUE ("providerId", "accountId")
    )`);
    await sql.unsafe('CREATE INDEX IF NOT EXISTS "idx_session_user" ON "session" ("userId")');
    await sql.unsafe('CREATE INDEX IF NOT EXISTS "idx_account_user" ON "account" ("userId")');
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "verification" (
      "id" VARCHAR(128) PRIMARY KEY,
      "identifier" VARCHAR(255) NULL,
      "value" VARCHAR(255) NULL,
      "expiresAt" TIMESTAMP(3) NULL,
      "createdAt" TIMESTAMP(3) NULL,
      "updatedAt" TIMESTAMP(3) NULL
    )`);
    return;
  }

  if (provider === "mysql") {
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
    await sql.unsafe("DROP TABLE IF EXISTS `account`");
    await sql.unsafe("DROP TABLE IF EXISTS `session`");
    await sql.unsafe("DROP TABLE IF EXISTS `verification`");
    await sql.unsafe("DROP TABLE IF EXISTS `user`");
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");

    await sql.unsafe(`CREATE TABLE IF NOT EXISTS \`user\` (
      \`id\` VARCHAR(128) PRIMARY KEY,
      \`name\` VARCHAR(255) NULL,
      \`email\` VARCHAR(255) NOT NULL,
      \`emailVerified\` BOOLEAN NULL,
      \`image\` TEXT NULL,
      \`createdAt\` DATETIME(3) NULL,
      \`updatedAt\` DATETIME(3) NULL,
      UNIQUE KEY \`uq_user_email\` (\`email\`)
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS \`session\` (
      \`id\` VARCHAR(128) PRIMARY KEY,
      \`token\` VARCHAR(255) NOT NULL,
      \`expiresAt\` DATETIME(3) NULL,
      \`createdAt\` DATETIME(3) NULL,
      \`updatedAt\` DATETIME(3) NULL,
      \`ipAddress\` VARCHAR(255) NULL,
      \`userAgent\` TEXT NULL,
      \`userId\` VARCHAR(128) NOT NULL,
      UNIQUE KEY \`uq_session_token\` (\`token\`),
      INDEX \`idx_session_user\` (\`userId\`),
      CONSTRAINT \`fk_session_user\` FOREIGN KEY (\`userId\`) REFERENCES \`user\` (\`id\`) ON DELETE CASCADE
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS \`account\` (
      \`id\` VARCHAR(128) PRIMARY KEY,
      \`accountId\` VARCHAR(255) NOT NULL,
      \`providerId\` VARCHAR(255) NOT NULL,
      \`userId\` VARCHAR(128) NOT NULL,
      \`accessToken\` TEXT NULL,
      \`refreshToken\` TEXT NULL,
      \`idToken\` TEXT NULL,
      \`accessTokenExpiresAt\` DATETIME(3) NULL,
      \`refreshTokenExpiresAt\` DATETIME(3) NULL,
      \`scope\` VARCHAR(255) NULL,
      \`password\` TEXT NULL,
      \`createdAt\` DATETIME(3) NULL,
      \`updatedAt\` DATETIME(3) NULL,
      UNIQUE KEY \`uq_account_provider_account_id\` (\`providerId\`, \`accountId\`),
      INDEX \`idx_account_user\` (\`userId\`),
      CONSTRAINT \`fk_account_user\` FOREIGN KEY (\`userId\`) REFERENCES \`user\` (\`id\`) ON DELETE CASCADE
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS \`verification\` (
      \`id\` VARCHAR(128) PRIMARY KEY,
      \`identifier\` VARCHAR(255) NULL,
      \`value\` VARCHAR(255) NULL,
      \`expiresAt\` DATETIME(3) NULL,
      \`createdAt\` DATETIME(3) NULL,
      \`updatedAt\` DATETIME(3) NULL
    )`);
    return;
  }

  await sql.unsafe("PRAGMA foreign_keys = ON");
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "user" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NULL,
    "image" TEXT NULL,
    "createdAt" TEXT NULL,
    "updatedAt" TEXT NULL
  )`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "session" (
    "id" TEXT PRIMARY KEY,
    "token" TEXT NOT NULL UNIQUE,
    "expiresAt" TEXT NULL,
    "createdAt" TEXT NULL,
    "updatedAt" TEXT NULL,
    "ipAddress" TEXT NULL,
    "userAgent" TEXT NULL,
    "userId" TEXT NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
  )`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "account" (
    "id" TEXT PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT NULL,
    "refreshToken" TEXT NULL,
    "idToken" TEXT NULL,
    "accessTokenExpiresAt" TEXT NULL,
    "refreshTokenExpiresAt" TEXT NULL,
    "scope" TEXT NULL,
    "password" TEXT NULL,
    "createdAt" TEXT NULL,
    "updatedAt" TEXT NULL,
    UNIQUE ("providerId", "accountId"),
    FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
  )`);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS "verification" (
    "id" TEXT PRIMARY KEY,
    "identifier" TEXT NULL,
    "value" TEXT NULL,
    "expiresAt" TEXT NULL,
    "createdAt" TEXT NULL,
    "updatedAt" TEXT NULL
  )`);
}

export async function purgeTables(sql: SQL, provider: E2EProvider) {
  if (provider === "pg") {
    await sql.unsafe(
      'TRUNCATE TABLE "account", "session", "verification", "user" RESTART IDENTITY CASCADE',
    );
    return;
  }

  if (provider === "mysql") {
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 0");
    await sql.unsafe("TRUNCATE TABLE `account`");
    await sql.unsafe("TRUNCATE TABLE `session`");
    await sql.unsafe("TRUNCATE TABLE `verification`");
    await sql.unsafe("TRUNCATE TABLE `user`");
    await sql.unsafe("SET FOREIGN_KEY_CHECKS = 1");
    return;
  }

  await sql.unsafe("PRAGMA foreign_keys = ON");
  await sql.unsafe(`DELETE FROM "account"`);
  await sql.unsafe(`DELETE FROM "session"`);
  await sql.unsafe(`DELETE FROM "verification"`);
  await sql.unsafe(`DELETE FROM "user"`);
}

export async function closeSql(sql: SQL) {
  await sql.close();
}
