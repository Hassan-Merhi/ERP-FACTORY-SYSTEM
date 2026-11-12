/**
 * Runs the real Permissions Control Center store against a THROWAWAY database
 * prepared by scripts/permissions/validate-shadow-migration.sh (it sets
 * DATABASE_URL to that cluster). Never point this at a real database.
 *
 * Checks, through the application's own pool and tenant scope:
 *   - two administrators saving against the same revision: exactly one wins,
 *     the other gets 409 POLICY_STALE_REVISION and writes nothing;
 *   - a user override for someone outside the company is refused;
 *   - another company's scope sees none of these rules or audit rows;
 *   - the effective-permission read resolves the canonical role and stays on
 *     legacy decisions in shadow mode;
 *   - activation is refused while the operator switch is off, a stale mode
 *     change gets 409, and an authorized activation and rollback are both
 *     audited as policy_mode rows.
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
const { readEffectivePermissions, readV2PolicyStatus, setV2PolicyMode } = await import(
  "../../server/services/security/effectivePermissionStore"
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

  // Effective permissions: canonical role, legacy decisions while in shadow.
  const clerk = await inCompany(1, () => readEffectivePermissions(1, "clerk-a", {}));
  check(clerk.role === "Create Only" && clerk.mode === "shadow" && clerk.enforced === false, "effective read uses the canonical Create Only role in shadow mode");
  check(
    clerk.decisions["erp.suppliers"].edit.allowed === false && clerk.decisions["erp.suppliers"].create.allowed === true,
    "Create Only: supplier create allowed, supplier edit denied"
  );
  check(clerk.decisions["erp.vouchers"].create.allowed === false, "Create Only: unverified voucher create denied");
  let notMember: unknown = null;
  try {
    await inCompany(1, () => readEffectivePermissions(1, "clerk-b", {}));
  } catch (error) {
    notMember = error;
  }
  check(notMember instanceof V2PolicyError && notMember.status === 404, "effective read refuses a person outside the company");

  // Activation switch and audited mode changes.
  const status = await inCompany(1, () => readV2PolicyStatus(1));
  let refused: unknown = null;
  try {
    await inCompany(1, () => setV2PolicyMode({ actor, mode: "active", expectedRevision: status.revision, reason: "Activation without operator approval" }, {}));
  } catch (error) {
    refused = error;
  }
  check(refused instanceof V2PolicyError && refused.code === "PERMISSIONS_V2_ACTIVATION_NOT_AUTHORIZED", "activation refused while PERMISSIONS_V2_COMPANY_ACTIVATION is off");
  let stale: unknown = null;
  try {
    await inCompany(1, () => setV2PolicyMode({ actor, mode: "active", expectedRevision: status.revision - 1, reason: "Activation from a stale screen" }, { PERMISSIONS_V2_COMPANY_ACTIVATION: "enabled" }));
  } catch (error) {
    stale = error;
  }
  check(stale instanceof V2PolicyError && stale.code === "POLICY_STALE_REVISION", "a stale mode change gets 409 POLICY_STALE_REVISION");
  const unchanged = await inCompany(1, () => readV2PolicyStatus(1));
  check(unchanged.mode === "shadow" && unchanged.revision === status.revision, "refused mode changes wrote nothing");
  const activated = await inCompany(1, () =>
    setV2PolicyMode({ actor, mode: "active", expectedRevision: status.revision, reason: "Approved pilot activation drill" }, { PERMISSIONS_V2_COMPANY_ACTIVATION: "enabled" })
  );
  check(activated.mode === "active" && activated.revision === status.revision + 1, "authorized activation commits with a new revision");
  const rolledBack = await inCompany(1, () =>
    setV2PolicyMode({ actor, mode: "rolled_back", expectedRevision: activated.revision, reason: "Rollback drill back to legacy" }, {})
  );
  check(rolledBack.mode === "rolled_back", "rollback is allowed with the activation switch off");
  const modeAudit = (await inCompany(1, () => readV2Audit(1, 100))).filter((row: { subjectType: string }) => row.subjectType === "policy_mode");
  check(modeAudit.some((row: { subjectKey: string }) => row.subjectKey === "active") && modeAudit.some((row: { subjectKey: string }) => row.subjectKey === "rolled_back"), "activation and rollback are both in the audit");
  const otherStatus = await inCompany(2, () => readV2PolicyStatus(2));
  check(otherStatus.mode === "shadow", "company 2's policy mode is unaffected");
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
