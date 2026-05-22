# Changelog

## 1.0.0

First stable release.

- Promoted from beta after validation across PostgreSQL, MySQL, and SQLite.
- No breaking changes from `1.0.0-beta.2`.
- Full test coverage: unit tests, e2e tests, and Better Auth contract test suites.

## 1.0.0-beta.2

- Fixed MySQL `consumeOne` nested transaction behavior by reusing the active transaction-scoped client inside `adapter.transaction(...)` instead of opening a nested `begin()`.
- Added unit and MySQL e2e regression tests for `consumeOne` inside adapter-managed transactions.

## 1.0.0-beta.1

- Added `createSchema` support for the `bun-sql` adapter so Better Auth CLI `generate` works with Bun SQL-backed projects.
- Added schema generation tests covering provider-specific output and custom output path handling.
- Updated documentation for CLI schema generation support.

## 1.0.0-beta.0

- Added Bun SQL adapter support for Better Auth across PostgreSQL, MySQL, and SQLite.
- Added native join support and provider-specific behavior for `create`, `update`, `delete`, `count`, and `consumeOne`.
- Added layered test coverage:
  - Bun unit tests
  - real MySQL/SQLite e2e tests
  - Better Auth contract suites via `@better-auth/test-utils/adapter`
- Added reproducible release gate scripts (`test:all`) and contract test lane (`test:contract`).

### Beta Notes

- This is a beta release intended for early validation and feedback.
- Use a disposable database for e2e/contract MySQL tests because tables are recreated during migrations.
