/**
 * Read-only database schema verification.
 *
 * Answers one question: does this database match the schema this release was
 * built for? It never creates, alters or repairs anything. Used by:
 *   - server/schema/startupSchemaGate.mjs (every server start, fail closed);
 *   - scripts/db/migrate.mjs verify (operators and CI).
 *
 * Checks, in order:
 *   1. migration history: public.schema_migrations exists, every migration in
 *      migrations/ is recorded with a matching SHA-256, nothing unknown or out
 *      of order (a database that is behind must be migrated first, a database
 *      that is ahead belongs to a newer release);
 *   2. catalog: every table, column, constraint, index, function, trigger, RLS
 *      flag and policy in migrations/manifest/schema.tsv exists with the same
 *      definition (extra legacy objects are allowed and only counted);
 *   3. tenant isolation probes: company-scope RLS fails closed without a tenant
 *      identity, and voucher entries carry their voucher's company.
 */
import {
  loadMigrations,
  readHistory,
  readManifest,
  reconcileHistory,
  SCHEMA_MANIFEST,
} from "./migrationRegistry.mjs";
import { compareSnapshots, summariseComparison, takeCatalogSnapshot } from "./schemaCatalog.mjs";

const MAX_LISTED = 25;

/**
 * @param {{ query: Function }} client a dedicated client (not a pool)
 * @param {{ catalog?: boolean, probes?: boolean, manifestFile?: string }} [options]
 * @returns {Promise<{ ok: boolean, problems: string[], summary: Record<string, unknown> }>}
 */
export async function verifyDatabaseSchema(client, { catalog = true, probes = true, manifestFile = SCHEMA_MANIFEST } = {}) {
  const problems = [];
  const summary = {};
  const migrations = loadMigrations();
  summary.migrations = migrations.length;

  const history = await readHistory(client);
  if (!history.exists) {
    problems.push(
      "public.schema_migrations does not exist: this database has never been migrated or adopted. " +
        "Fresh database: run `npm run db:migrate`. Existing ERP database: run `npm run db:adopt` (see docs/database-migrations.md)."
    );
    return { ok: false, problems, summary };
  }
  try {
    const { applied, pending } = reconcileHistory(migrations, history.rows);
    summary.applied = applied.length;
    summary.adopted = history.rows.filter((row) => row.mode === "adopted").map((row) => row.id);
    if (pending.length) {
      problems.push(`Pending migrations not applied: ${pending.map((m) => m.id).join(", ")}. Run \`npm run db:migrate\` before starting this release.`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (catalog) {
    const expected = readManifest(manifestFile);
    const actual = await takeCatalogSnapshot(client);
    const result = compareSnapshots(expected, actual);
    summary.catalog = summariseComparison(result);
    for (const entry of result.missing.slice(0, MAX_LISTED)) problems.push(`missing ${entry.kind} ${entry.identity}`);
    if (result.missing.length > MAX_LISTED) problems.push(`... and ${result.missing.length - MAX_LISTED} more missing objects`);
    for (const change of result.changed.slice(0, MAX_LISTED)) {
      problems.push(`changed ${change.expected.kind} ${change.expected.identity}: expected ${change.expected.raw} but found ${change.actual.raw}`);
    }
    if (result.changed.length > MAX_LISTED) problems.push(`... and ${result.changed.length - MAX_LISTED} more changed objects`);
    summary.extraObjects = result.extra.length;
  }

  if (probes && problems.length === 0) {
    problems.push(...(await runTenantIsolationProbes(client)));
  }

  return { ok: problems.length === 0, problems, summary };
}

/**
 * Behavioural tenant-isolation checks that a catalog comparison cannot express.
 * Runs in a read-only transaction that is always rolled back.
 */
export async function runTenantIsolationProbes(client) {
  const problems = [];
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL search_path = public");
    // Missing tenant scope must be an error, never an all-company view.
    await client.query(`
      DO $fail_closed_probe$
      BEGIN
        PERFORM set_config('app.company_scope_maintenance', 'off', true);
        PERFORM set_config('app.current_company_id', '', true);
        PERFORM set_config('app.authorized_company_ids', '', true);
        BEGIN
          PERFORM erp_current_company_id();
        EXCEPTION WHEN SQLSTATE '22023' THEN
          RETURN;
        END;
        RAISE EXCEPTION 'Company-scope RLS did not fail closed without a tenant identity';
      END
      $fail_closed_probe$;
    `);
  } catch (error) {
    problems.push(`Company-scope RLS probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
  if (problems.length) return problems;

  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    const mismatch = await client.query(`
      SELECT COUNT(*)::int AS mismatch_count
        FROM public.voucher_entries ve
        JOIN public.vouchers v ON v.id = ve.voucher_id
       WHERE ve.company_id IS DISTINCT FROM v.company_id
    `);
    if (Number(mismatch.rows[0]?.mismatch_count ?? 0) !== 0) {
      problems.push("Voucher-entry company scope is out of sync with parent vouchers.");
    }
  } catch (error) {
    problems.push(`Voucher-entry company-scope probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
  return problems;
}
