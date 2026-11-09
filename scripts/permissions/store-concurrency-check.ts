/**
 * Runs the real Permissions Control Center store against a THROWAWAY database
 * prepared by scripts/permissions/validate-shadow-migration.sh (it sets
 * DATABASE_URL to that cluster). Never point this at a real database.
 *
 * Checks, through the application's own pool and tenant scope:
 *   - two administrators saving against the same revision: exactly one wins,
 *     the other gets 409 POLICY_STALE_REVISION and writes nothing;
 *   - a user override for someone outside the company is refused;
 *   - another company's scope sees none of these rules or audit rows.
 */
// The throwaway database already carries the application's company-scope
// functions (installed by validate-shadow-migration.sh), but not the full
// production schema the startup RLS bridge expects. Mark the bridge as applied
// before the database module loads so only the shadow store is exercised.
(globalThis as Record<symbol, unknown>)[Symbol.for("erp.company-scope-rls-readiness.applied")] = true;

const { pool } = await import("../../server/db");
const { createTenantDatabaseScope, runWithDatabaseScopeRuntimeContext } = await import(
  "../../server/services/security/databaseScopeRuntimeContext"
);
const { V2PolicyError, readV2Audit, readV2Roles, saveV2Rules } = await import(
  "../../server/services/security/accessControlV2Store"
);

const inCompany = <T>(companyId: number, work: () => Promise<T>) =>
  runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(companyId, [], "active-company"), work);

function check(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
  console.log(`PASS  ${message}`);
}

async function main() {
  const actor = { companyId: 1, userId: "admin-a" };
  const start = await inCompany(1, () => readV2Roles(1));
  const change = (decision: "allow" | "deny") => ({ resource: "erp.suppliers" as const, action: "create" as const, decision });
  const attempts = await Promise.allSettled([
    inCompany(1, () =>
      saveV2Rules({ actor, subject: { kind: "role", roleKey: "Create Only" }, changes: [change("allow")], expectedRevision: start.revision, reason: "First administrator change" })
    ),
    inCompany(1, () =>
      saveV2Rules({ actor, subject: { kind: "role", roleKey: "Create Only" }, changes: [change("deny")], expectedRevision: start.revision, reason: "Second administrator change" })
    ),
  ]);
  const won = attempts.filter((a) => a.status === "fulfilled");
  const lost = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
  check(won.length === 1 && lost.length === 1, "concurrent saves on one revision: exactly one succeeds");
  const loss = lost[0]?.reason;
  check(loss instanceof V2PolicyError && loss.status === 409 && loss.code === "POLICY_STALE_REVISION", "the other save gets 409 POLICY_STALE_REVISION");

  const after = await inCompany(1, () => readV2Roles(1));
  check(after.revision === start.revision + 1, `revision advanced exactly once (${start.revision} -> ${after.revision})`);
  check(after.rules.filter((r: { roleKey: string }) => r.roleKey === "Create Only").length === 1, "only the winning rule was stored");

  let outsider: unknown = null;
  try {
    await inCompany(1, () =>
      saveV2Rules({ actor, subject: { kind: "user", userId: "clerk-b" }, changes: [change("allow")], expectedRevision: after.revision, reason: "Override for a user of another company" })
    );
  } catch (error) {
    outsider = error;
  }
  check(outsider !== null, "an override for a user outside the company is refused");

  const otherRoles = await inCompany(2, () => readV2Roles(2));
  const otherAudit = await inCompany(2, () => readV2Audit(2, 100));
  check(otherRoles.rules.length === 0 && otherAudit.length === 0, "company 2 sees none of company 1's rules or audit");
  const audit = await inCompany(1, () => readV2Audit(1, 100));
  check(audit.length >= 1, `company 1 audit recorded the change (${audit.length} row(s))`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
