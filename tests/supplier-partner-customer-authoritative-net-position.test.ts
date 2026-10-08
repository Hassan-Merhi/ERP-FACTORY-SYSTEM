import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("supplier partner customer Net Position", () => {
  // Wave 10 (one balance engine): the three Net Position paths read customers
  // from the engine and skip them for supplier-partner companies. The old
  // supplierPartnerCustomerNetPosition helper always returned no customer items
  // and every customer-like ledger id, so its account clause could never admit
  // a ledger; the paths now simply leave customers out, with the same result.
  it("excludes customers from Supplier Partner Net Position on every path", () => {
    const paths = [
      "server/routes/stats/statsNetProfitRoutes.ts",
      "server/helpers/calculateNetPositionAsOf.ts",
      "server/routes/stats/statsNetPositionRoutes.ts",
    ];

    for (const relativePath of paths) {
      const source = read(relativePath);
      expect(source).toContain("loadNetPositionParties");
      expect(source).toContain("customers: !isSupplierPartner");
      expect(source).toContain("parties.customerLedgerIds.has(a.id)");
      expect(source).not.toContain('startsWith("CUST-")');
      expect(source).toContain("isSupplierPartner");
    }
    expect(fs.existsSync(path.join(root, "server/helpers/supplierPartnerCustomerNetPosition.ts"))).toBe(false);
  });

  it("does not re-add customer balances in the live Golden Coast residual-equity projection", () => {
    const source = read("server/routes/stats/goldenCoastResidualEquityProjection.ts");
    expect(source).toContain('const ASSET_TYPES = new Set(["Asset", "Current Asset", "Fixed Asset", "Bank", "Cash"]);');
    expect(source).toContain("function isCustomerNetPositionAccount");
    expect(source).toContain("if (isCustomerNetPositionAccount(account)) continue;");
    expect(source).toContain("Customer balances are excluded from this Supplier Partner Net Position view");
  });

  it("does not render zero-value cash or bank rows after current translation", () => {
    const source = read("server/routes/stats/statsMultiCurrencyRoutes.ts");
    expect(source).toContain(".filter((row) => Math.abs(Number(row.value || 0)) >= 0.005)");
  });

  it("keeps the new SP cash-account labels covered by the shared translation registry and audit", () => {
    const translations = read("client/src/i18n/phase3RemainingTranslations.part25.ts");
    const registry = read("client/src/i18n/sharedUiPhase3Translations.ts");
    const audit = read("scripts/audit-i18n-phase14.mjs");
    expect(translations).toContain('en: "Opening Cash Account"');
    expect(translations).toContain('en: "GC Sales Cash"');
    expect(registry).toContain("phase3RemainingTranslationsPart25");
    expect(audit).toContain("phase3RemainingTranslations.part25.ts");
  });
});
