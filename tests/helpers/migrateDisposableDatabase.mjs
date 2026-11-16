/**
 * Build a disposable test database the only supported way: by applying the
 * numbered migrations (scripts/db/migrate.mjs apply). Tests that used to call
 * the runtime ensure* schema writers now get the exact catalog production has.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const migrate = fileURLToPath(new URL("../../scripts/db/migrate.mjs", import.meta.url));

/** Apply every migration to the (empty) database at `databaseUrl`. */
export function applyMigrations(databaseUrl) {
  try {
    execFileSync(process.execPath, [migrate, "apply"], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGSSLMODE: "disable",
        MIGRATION_CONFIRMATION: "APPLY_SCHEMA_MIGRATIONS",
      },
      stdio: "pipe",
    });
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
    throw new Error(`MIGRATIONS_FAILED for ${new URL(databaseUrl).pathname}: ${output || error}`);
  }
}

/** The same server, another database name. */
export function databaseUrlFor(adminUrl, name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
