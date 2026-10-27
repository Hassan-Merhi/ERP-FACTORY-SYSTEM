import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("client/src/pages/AccountMigration.tsx", "utf8");
const route = readFileSync("server/routes/admin/import-export/account-migration.ts", "utf8");
const safeRoutes = readFileSync("server/routes/admin/accountMigrationSafeRoutes.ts", "utf8");

describe("account migration source-company picker", () => {
  it("loads source ledgers through the dedicated authorized migration read", () => {
    expect(page).toContain("/api/admin/account-migration/accounts/${encodeURIComponent(srcCompanyId)}");
    expect(page).not.toContain("/api/ledger-accounts?companyId=");
  });

  it("requires company membership and transaction-local scoped RLS for that read", () => {
    expect(route).toContain("await assertCompaniesAccess(context.userId, [companyId])");
    expect(route).toContain("set_config('app.company_scope_maintenance', 'off', true)");
    expect(route).toContain("set_config('app.authorized_company_ids', ${String(companyId)}, true)");
    expect(route).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(route).toContain("isNull(ledgerAccounts.deletedAt)");
    expect(route).toContain('requireRole("Admin", "Developer")');
  });

  it("offers a persisted return-to-Properties action after navigation and new ERP transactions", () => {
    expect(page).toContain('"/api/admin/account-migration/pending"');
    expect(page).toContain("Active migrations — move accounts back");
    expect(page).toContain("setUndoTarget(migration)");
    expect(page).toContain("undoTarget.movedVoucherIds");
    expect(page).not.toContain("setLastResult");
    expect(safeRoutes).toContain('"/api/admin/account-migration/pending"');
    expect(safeRoutes).toContain("getAccessibleCompanyIds(context.userId)");
    expect(safeRoutes).toContain("!undone.has(saved.migrationId)");
  });

  it("surfaces source-account request failures instead of showing a false empty state", () => {
    expect(page).toContain("isError: srcAccountsError");
    expect(page).toContain("Accounts could not be loaded.");
    expect(page).toContain("refetchSrcAccounts");
  });
});
