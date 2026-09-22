import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * Wave 2 accounting/inventory integrity regression contract.
 *
 * These assertions deliberately pin the company-ownership boundary for every
 * offload charge type that can reference another accounting record. The
 * prepaid guard runs before the legacy offload handler, so a foreign prepaid
 * id is rejected before vouchers, inventory, offload charges or prepaid usage
 * can be mutated. The paid-now and unpaid-payable branches validate ownership
 * inside the offload transaction itself.
 */
describe("SP offload charge company isolation", () => {
  const index = source("server/routes/sp/index.ts");
  const guard = source("server/routes/sp/spOffloadPrepaidCompanyGuard.ts");
  const offload = source("server/routes/sp/spOffloadRoutes.ts");

  it("mounts the prepaid company guard before the mutating offload handler", () => {
    const guardMount = index.indexOf("registerSpOffloadPrepaidCompanyGuard(app)");
    const offloadMount = index.indexOf("registerSpOffloadRoutes(app)");

    expect(guardMount).toBeGreaterThan(-1);
    expect(offloadMount).toBeGreaterThan(-1);
    expect(guardMount).toBeLessThan(offloadMount);
  });

  it("requires prepaid_used references to belong to the active company", () => {
    expect(guard).toContain('charge?.chargeType === "prepaid_used"');
    expect(guard).toContain("FROM sp_prepaid_charges");
    expect(guard).toContain("AND company_id = ${companyId}");
    expect(guard).toContain("not found for this company");
  });

  it("keeps paid_now bank references company scoped inside the transaction", () => {
    expect(offload).toContain('charge.chargeType === "paid_now"');
    expect(offload).toContain("eq(bankAccounts.companyId, companyId)");
    expect(offload).toContain("Bank account #${charge.creditBankAccountId} not found for this company");
  });

  it("keeps unpaid_payable ledger references company scoped and excludes deleted ledgers", () => {
    expect(offload).toContain('charge.chargeType === "unpaid_payable"');
    expect(offload).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(offload).toContain("isNull(ledgerAccounts.deletedAt)");
    expect(offload).toContain("Ledger account #${charge.creditLedgerAccountId} not found for this company");
  });
});
