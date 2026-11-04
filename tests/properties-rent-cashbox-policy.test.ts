import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level regressions for the Properties-only policy. The full accounting
// integration test must also exercise real receipt and reversal vouchers.
const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Properties rent cashbox rollout policy", () => {
  it("does not auto-transfer new Properties rent receipts, including delayed scheduled posting", () => {
    const code = source("server/services/rental/rentalPaymentPostingService.ts");
    expect(code).toContain('mod !== "PROPERTIES" && cashAccountId && unit');
    expect(code).toContain('module !== "PROPERTIES" && firstRow.cashAccountId');
    expect(code).toContain("if (replayed) {");
  });

  it("does not auto-transfer new landlord guarantee receipts, but keeps historical reversal support", () => {
    const code = source("server/routes/rental/units-contracts/guarantees.ts");
    expect(code).toContain('if (module !== "PROPERTIES")');
    expect(code).toContain("reverseAutoTransfersTx");
    expect(code).not.toContain('if (cashAccountId && !(module === "ERP" || module === "FACTORY"))');
  });

  it("creates a scoped zero-opening Cash account and requires a valid receipt destination", () => {
    const code = source("server/routes/rental/rentalPaymentsAccrualRoutes.ts");
    expect(code).toContain('PROPERTIES_RENT_CASH_CODE = "PROP-RENT-CASH"');
    expect(code).toContain('openingBalance: "0"');
    expect(code).toContain('accountType: "Cash"');
    expect(code).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(code).toContain("validatePropertiesReceiptAccount(companyId, data.cashAccountId)");
    expect(code).toContain("validatePropertiesReceiptAccount(companyId, item.cashAccountId)");
  });

  it("shows tenant receivables green, tenant credits red, without changing rental arithmetic", () => {
    const page = source("client/src/pages/properties/PropertyRentalPage.tsx");
    expect(page).toContain('label: isPropertiesRental ? "TO COLLECT" : "OUTSTANDING"');
    expect(page).toContain('label: isPropertiesRental ? "OWED TO TENANTS" : "CREDIT"');
    expect(page).toContain("totalCredit += u.prepaidCredit ?? 0");
    expect(page).toContain("if (outstanding > 0) totalOwed += outstanding");
  });
});
