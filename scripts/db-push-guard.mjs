#!/usr/bin/env node
/**
 * Guard for `npm run db:push`.
 *
 * drizzle-kit push reconciles the database with shared/schema and offers to
 * drop anything it does not know. Dozens of live tables are still created by
 * runtime startup DDL rather than declared in shared/schema, so a push against
 * a real database can destroy them (and their sequences) along with their data.
 * drizzle.config.ts filters tables, but drizzle-kit does not filter sequences.
 *
 * The command is reserved for disposable databases (README). This guard makes
 * that rule enforceable: it refuses any database that already holds company
 * data unless DB_PUSH_ALLOW_NONEMPTY=1 is set deliberately.
 */
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("db:push guard: DATABASE_URL is not set.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: resolveDatabaseSsl(connectionString),
  connectionTimeoutMillis: 15_000,
});
let companyRows = 0;
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  // Maintenance scope only lets this read pass row-level security; the
  // transaction is read-only and rolled back.
  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
  const exists = await client.query("SELECT to_regclass('public.companies') IS NOT NULL AS present");
  if (exists.rows[0]?.present) {
    const count = await client.query("SELECT COUNT(*)::int AS n FROM companies");
    companyRows = count.rows[0]?.n ?? 0;
  }
  await client.query("ROLLBACK");
} catch (error) {
  console.error(`db:push guard: could not inspect the target database: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

if (companyRows > 0 && process.env.DB_PUSH_ALLOW_NONEMPTY !== "1") {
  console.error(
    [
      `db:push guard: refusing to push to a database that holds data (${companyRows} companies).`,
      "drizzle-kit push can drop tables and sequences that are created at runtime rather than declared",
      "in shared/schema. Use it only on a disposable database. If you are certain, set",
      "DB_PUSH_ALLOW_NONEMPTY=1 for this one command.",
    ].join("\n")
  );
  process.exit(1);
}
