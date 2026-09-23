import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("client/src/pages/AccountMigration.tsx", "utf8");

describe("account migration source-company picker", () => {
  it("loads source ledgers through the authorized cross-company ledger read", () => {
    expect(page).toContain(
      "/api/ledger-accounts?companyId=${encodeURIComponent(srcCompanyId)}&includeHidden=true"
    );
    expect(page).not.toContain("/api/admin/account-migration/accounts/${srcCompanyId}");
  });

  it("surfaces source-account request failures instead of showing a false empty state", () => {
    expect(page).toContain("isError: srcAccountsError");
    expect(page).toContain("Accounts could not be loaded.");
    expect(page).toContain("refetchSrcAccounts");
  });
});
