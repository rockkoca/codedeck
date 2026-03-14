## ADDED Requirements

### Requirement: D1-compatible query API wrapper
The system SHALL provide a `PgDatabase` class that implements D1's chained API (`prepare(sql).bind(...args).first<T>()`, `.all<T>()`, `.run()`) backed by a PostgreSQL connection pool.

#### Scenario: Simple SELECT query
- **WHEN** calling `db.prepare('SELECT * FROM users WHERE id = ?').bind('u1').first<User>()`
- **THEN** the wrapper converts `?` to `$1`, executes against PostgreSQL, and returns the first row or `null`

#### Scenario: Multi-parameter query
- **WHEN** calling `db.prepare('SELECT * FROM t WHERE a = ? AND b = ?').bind('x', 'y').all<T>()`
- **THEN** placeholders are converted to `$1, $2` in order and `{ results: T[] }` is returned

#### Scenario: Question mark inside string literal or identifier
- **WHEN** SQL contains `?` inside a quoted string (e.g., `'what?'`) or double-quoted identifier
- **THEN** the `?` is NOT converted to a `$N` placeholder — only unquoted `?` are treated as bind parameters

#### Scenario: INSERT with run()
- **WHEN** calling `db.prepare('INSERT INTO t (id) VALUES (?)').bind('id1').run()`
- **THEN** the statement executes and returns `{ changes: number }` with the affected row count

#### Scenario: No rows found
- **WHEN** calling `.first<T>()` on a query that matches zero rows
- **THEN** `null` is returned (not undefined, not an error)

### Requirement: PostgreSQL connection pool
The system SHALL create a connection pool from `DATABASE_URL` environment variable using the `pg` library's `Pool` class.

#### Scenario: Pool initialization
- **WHEN** the server starts with `DATABASE_URL=postgresql://user:pass@host:5432/db`
- **THEN** a `Pool` is created and the `PgDatabase` instance wraps it

#### Scenario: Connection failure
- **WHEN** PostgreSQL is unreachable at startup
- **THEN** the server logs an error and exits with a non-zero code

### Requirement: PostgreSQL schema migration
The system SHALL provide a consolidated SQL migration file (`001_init.sql`) that creates all tables and indexes, converted from the 9 D1/SQLite migrations.

#### Scenario: SQLite syntax converted
- **WHEN** D1 uses `INSERT OR REPLACE INTO`
- **THEN** PG migration uses `INSERT INTO ... ON CONFLICT (pk) DO UPDATE SET ...`

#### Scenario: Integer timestamps
- **WHEN** D1 uses `INTEGER` for epoch-ms timestamps
- **THEN** PG migration uses `BIGINT`

#### Scenario: Fresh deployment
- **WHEN** running the migration against an empty PostgreSQL database
- **THEN** all tables, indexes, and constraints from the original 9 migrations are created

### Requirement: Auto-migration on startup
The system SHALL apply pending migrations automatically when the server starts (idempotent — safe to run repeatedly).

#### Scenario: First run
- **WHEN** the database has no tables
- **THEN** `001_init.sql` is applied, creating all tables

#### Scenario: Already migrated
- **WHEN** all migrations have been applied
- **THEN** startup proceeds without errors or duplicate table creation
