import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

const adminRoutes = readModuleFamily("server/routes/adminRoutes.ts");
const safeRoutes = readModuleFamily("server/routes/admin/accountMigrationSafeRoutes.ts");
const controlReferences = readModuleFamily("server/routes/admin/accountMigrationControlReferences.ts");

describe("account migration POS control safety", () => {
  it("registers the safe execute and undo handlers before the legacy migration routes", () => {
    expect(adminRoutes).toContain("registerAccountMigrationSafeRoutes(app)");
    expect(adminRoutes.indexOf("registerAccountMigrationSafeRoutes(app)")).toBeLessThan(
      adminRoutes.indexOf("registerImportExportRoutes(app)")
    );
  });

  it("detaches source-company cash-account references before moving ledger accounts", () => {
    expect(controlReferences).toContain("set({ cashAccountId: null })");
    expect(controlReferences).toContain("delete(userLocationCashAccounts)");
    // Scope to the execute handler. (Previously this matched the *undo* handler's
    // account move further down the single file, which only held by layout.)
    // Execute moves the accounts first (the ledger integrity guard requires it),
    // then detaches the source-company control references in the same transaction.
    const executeStart = safeRoutes.indexOf('"/api/admin/account-migration/execute"');
    const transactionStart = safeRoutes.indexOf(".transaction(", executeStart);
    const accountMove = safeRoutes.indexOf(".update(ledgerAccounts)", transactionStart);
    const detachCall = safeRoutes.indexOf(
      "const controls = await detachAccountMigrationControlReferences",
      accountMove
    );
    expect(executeStart).toBeGreaterThan(-1);
    expect(transactionStart).toBeGreaterThan(executeStart);
    expect(accountMove).toBeGreaterThan(transactionStart);
    expect(detachCall).toBeGreaterThan(accountMove);
  });

  it("persists the control snapshot and restores it during undo", () => {
    expect(safeRoutes).toContain("controls,");
    expect(safeRoutes).toContain("ACCOUNT_MIGRATION_EXECUTE_SAFE");
    expect(safeRoutes).toContain("restoreAccountMigrationControlReferences");
    expect(controlReferences).toContain("insert(userLocationCashAccounts)");
  });

  it("opens a transaction-local RLS scope for the authorized source and destination companies", () => {
    expect(safeRoutes).toContain("assertCompaniesAccess(context.userId, [sourceCompanyId, destinationCompanyId])");
    expect(safeRoutes).toContain("set_config('app.company_scope_maintenance', 'off', true)");
    expect(safeRoutes).toContain("set_config('app.current_company_id'");
    expect(safeRoutes).toContain("set_config('app.authorized_company_ids'");
    expect(safeRoutes).not.toContain("set_config('app.company_scope_maintenance', 'on', true)");
    expect(safeRoutes.match(/applyAccountMigrationDatabaseScope\(tx, databaseScope\)/g)).toHaveLength(2);
  });

  it("returns canonical company-access failures instead of exposing an RLS database error", () => {
    expect(safeRoutes).toContain("error instanceof CompanyAccessError");
    expect(safeRoutes).toContain("code: error.code");
  });

  it("keeps legacy undo compatibility for migrations made before the safety fix", () => {
    expect(safeRoutes).toContain("if (!audit) return next()");
    expect(safeRoutes).toContain("if (!saved) return next()");
  });
});
