# Postgres port notes

deploy/postgres/schema.sql is a faithful translation of the schema in
app/lib/db.ts. This file explains the differences a real port of the
application code (not just the schema) has to handle. None of this has
been applied or tested; see docs/DEPLOY.md Option C for the honest cost
and the recommended migration order.

## datetime('now') vs now()

SQLite: every table uses `DEFAULT (datetime('now'))`, a UTC text
timestamp. Postgres: `DEFAULT now()` on a `timestamptz` column, which
stores true timezone-aware instants instead of text. The application code
that reads these values as strings and formats them for display will need
to expect a JS Date-like value (or an ISO string, depending on the
Postgres driver's type mapping) instead of the exact SQLite text format.
Any code that does string comparison or string slicing on a timestamp
column instead of parsing it as a date needs to be found and fixed during
the port; grep the app for places that treat `created_at` or similar
columns as plain strings.

## AUTOINCREMENT vs GENERATED ALWAYS AS IDENTITY

SQLite: `INTEGER PRIMARY KEY AUTOINCREMENT`. Postgres: `bigint GENERATED
ALWAYS AS IDENTITY PRIMARY KEY` (the modern replacement for `SERIAL`).
Functionally equivalent for the app's purposes: both hand out an
increasing unique integer per row. One real difference: an `INSERT`
against an identity column in Postgres does not accept an explicit value
by default; if any code path currently inserts an explicit id (for
example, a data-import or seed script), that code needs `OVERRIDING
SYSTEM VALUE` added to the INSERT, or it needs to stop specifying ids and
let Postgres assign them.

## INSERT OR IGNORE vs ON CONFLICT DO NOTHING

SQLite's `INSERT OR IGNORE INTO ...` has no direct Postgres equivalent
syntax; the Postgres way is `INSERT INTO ... ON CONFLICT (column) DO
NOTHING`, which requires naming the actual conflicting column or
constraint (for example `ON CONFLICT (domain) DO NOTHING` for the
companies table, matching the `companies_domain` partial unique index).
Search the app and scrapers/harness_signals.py for `INSERT OR IGNORE` and
`INSERT OR REPLACE`; each one needs its own `ON CONFLICT` clause written
by hand, matching whichever unique index or constraint it was relying on
in SQLite.

## Boolean ints vs real booleans

SQLite has no boolean type; the schema uses `INTEGER NOT NULL DEFAULT 0`
for flags like `disabled`, `do_not_contact`, `paused`, `done`, and
`handled`, with 0 and 1. deploy/postgres/schema.sql upgrades all of these
to real `boolean` columns with `true`/`false` defaults. Any application
code that compares these values to the numbers `0` or `1` (for example
`row.disabled === 1` or `row.do_not_contact ? ... : ...` relying on a
truthy 0/1 number) needs to be checked; a real boolean is truthy/falsy the
same way in JavaScript, so most conditional checks keep working
unchanged, but any strict equality check against the number `1` (`=== 1`)
will not match a Postgres boolean `true` and needs to become `=== true`
or just be used directly as a boolean.

## Sync vs async

This is the largest and most invasive difference, covered in depth in
docs/DEPLOY.md Option C: node:sqlite's `DatabaseSync` API used throughout
app/lib/db.ts is synchronous (`db().prepare(sql).all()/get()/run()`
return immediately with results). Every mainstream Postgres driver for
Node (pg, postgres.js, Neon's serverless driver, Supabase's client) is
asynchronous and returns a Promise. That means:

- Every function that currently calls `db()` synchronously has to become
  `async` and every call site has to `await` it, all the way up the call
  chain to the API route handler or server component that started it.
- Code that currently does `const rows = db().prepare(sql).all();` and
  keeps going on the next line has to become
  `const rows = await pool.query(sql);` (or the equivalent for the chosen
  driver) inside an async function.
- This does not change the SQL much (deploy/postgres/schema.sql keeps
  the table and column names the same on purpose, to make this
  mechanical), but it touches all 173 db() call sites across the 48 files
  identified in the codebase, because every one of them needs the `await`
  added and every function in its call chain needs to become `async`.
- The safest way to do this without breaking everything at once is the
  thin async data-access layer described in docs/DEPLOY.md: wrap the
  actual driver calls behind a small set of named async functions per
  table, and migrate the app to call those, one table's call sites at a
  time, testing as you go, rather than changing `db()` itself out from
  under every caller in one commit.

## Row-level security / multi-bank scaffolding

deploy/postgres/schema.sql includes a commented-out `workspaces` table and
row-level security policy pattern at the top of the file. It is commented
out because the current application has no concept of a workspace or
tenant at all; every row in every table today implicitly belongs to the
one bank running the app. Wiring in real multi-tenancy (a workspace_id
column on every table, a policy per table, and the app setting
`app.current_workspace_id` once per authenticated request) is part of the
larger Option C rewrite, not something to bolt on after the fact. The
commented block exists so the shape of that future work is visible and
reviewable now, without being applied against a schema that nothing in
the app yet populates correctly.
