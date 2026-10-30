import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("supplier partner net position inclusion", () => {
  it("keeps Golden Coast customer/loan coverage while using the Excel-style cash and residual-equity view", () => {
    const source = read("server/routes/stats/goldenCoastResidualEquityProjection.ts");
    expect(source).toContain('"Customer"');
    expect(source).toContain('"Loan"');
    expect(source).toContain('"Loans"');
    expect(source).toContain("const netPosition = round2(forUsTotal - onUsTotal)");
    expect(source).toContain('residualFormula: "net_position_minus_hassan"');
    expect(source).toContain("const freshStartResidual = round2(netPosition - hassanClaim)");
    expect(source).toContain(
      "for (const accountId of currentTranslatedLedgerAccountIds(body)) existingIds.add(accountId)"
    );
  });

  it("does not let current monetary translation erase supplier-partner equity", () => {
    // The live translation of /api/stats/net-profit is applied by the
    // monetary overlay (four categories since the FX monetary valuation
    // feature); the route keeps the cash/bank compatibility fields.
    const overlay = read("server/services/accounting/monetaryFxReportOverlay.ts");
    expect(overlay).toContain("payload.equity?.includedInNetPosition === true");
    expect(overlay).toContain("plus(equityContribution)");
    expect(overlay).toContain("payload.netWorth = netPosition");
    const source = read("server/routes/stats/statsMultiCurrencyRoutes.ts");
    expect(source).toContain("currentTranslatedLedgerAccountIds");
    expect(source).toContain("currentCashBankTranslationDifference");
  });

  it("keeps historical/monthly and Excel calculations aligned", () => {
    const asOf = read("server/helpers/calculateNetPositionAsOf.ts");
    const excel = read("server/routes/stats/statsNetPositionRoutes.ts");
    for (const source of [asOf, excel]) {
      expect(source).toContain("classifyEquityAccounts");
      expect(source).toContain('a.accountType === "Loan"');
      expect(source).toContain('a.accountType === "Loans"');
      // Wave 10: customers come from the balance engine and are excluded for
      // supplier partners (the old customer-like ledger clause never admitted
      // an account: its helper listed every customer-like ledger as excluded).
      expect(source).toContain("customers: !isSupplierPartner");
      expect(source).toContain("equityContribution");
      expect(source).toContain("forUsTotal - onUsTotal + equityContribution");
    }
  });
});
