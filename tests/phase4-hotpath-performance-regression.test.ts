import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("Phase 4 hot-path performance regressions", () => {
  it("targets one ledger account instead of rebuilding company-wide revaluation", () => {
    const source = read("server/services/accounting/cashLedgerAccountSummaryService.ts");
    const route = read("server/routes/accountCurrencyRoutes.ts");

    expect(source).toContain("ve.ledger_account_id = $2");
    expect(source).toContain("loadLedgerAccount(companyId, accountId)");
    expect(source).toContain("loadLedgerAggregate(companyId, accountId)");
    expect(source).not.toContain("getCashBankRevaluation");
    expect(route).toContain("getCashLedgerAccountSummary(companyId, id)");
  });

  it("aggregates /api/accounts/all movements in PostgreSQL instead of materializing voucher rows", () => {
    const source = read("server/routes/accounts/all.ts");

    expect(source).toContain("voucherEntries.fixedAssetId");
    expect(source).toContain("voucherEntries.employeeId");
    expect(source).toContain(".groupBy(");
    expect(source).not.toContain("companyVoucherIds");
    expect(source).not.toContain("const allEntries =");
    expect(source).toContain("suppliers.length === 0");
  });

  it("keeps bale-scan success-path lookups bounded", () => {
    const source = read("server/routes/factory/customer-orders/bale-scanning/scan.ts");

    expect(source).not.toContain("matchingProductsByName");
    expect(source).not.toContain("const [alreadyAdded]");
    expect(source).toContain("reservedInThisOrder");
    expect(source).toContain("const activeOrderCheck");
    // The conditional per-scan overload count this used to pin moved into
    // getProformaCapacitySnapshot, which answers it with one aggregate query.
    // Bounded now means the scan calls that snapshot once, and only when the
    // order is actually linked to a proforma.
    expect(source.match(/getProformaCapacitySnapshot\(tx/g)).toHaveLength(1);
    expect(source).toContain("if (order.proformaIdUsed) {");
  });
});
