import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { technicalProfitNettingLines } from "../server/services/intercompany/technicalProfitNetting";
import {
  presentIntercompanyAccount,
  showInIntercompanyAccountsOverview,
} from "../client/src/pages/accountslegacy/intercompanyAccountPresentation";
import type { Account } from "../client/src/pages/accounts/accountTypes";

function ledger(code: string, name: string, balance = 0): Account {
  return {
    id: code,
    accountId: 1,
    code,
    name,
    type: "ledger",
    balance,
    balanceSide: balance >= 0 ? "Dr" : "Cr",
    active: true,
  };
}

describe("simple intercompany account presentation", () => {
  it("keeps the operational parent intercompany debit and supplier visible", () => {
    const parent = ledger("IC-AR-24", "Intercompany Receivable - TEST HADI", 50928.75);
    const supplier = { ...ledger("33", "Testing Main Parent Company"), type: "supplier" };
    expect(showInIntercompanyAccountsOverview(parent, "properties")).toBe(true);
    expect(presentIntercompanyAccount(parent, "properties").name).toBe("Intercompany - TEST HADI");
    expect(showInIntercompanyAccountsOverview(supplier, "properties")).toBe(true);
  });

  it("does not show technical source sale, COGS or in-transit helper accounts", () => {
    for (const item of [
      ledger("IC-SALES-24", "Intercompany Sales - TEST HADI", -50928.75),
      ledger("IC-COGS-24", "Intercompany Cost of Goods Sold - TEST HADI", 50928.75),
      ledger("IC-GIT-22", "Intercompany Goods in Transit - Parent", 50928.75),
      ledger("IC-PURCH-24", "Original Purchases for TEST HADI"),
      ledger("IC-CHARGE-24", "Confirmed Container Charges Payable - TEST HADI"),
      ledger("IC-AP-22", "Intercompany Payable - Parent"),
    ]) {
      expect(showInIntercompanyAccountsOverview(item, "erp")).toBe(false);
    }
    expect(showInIntercompanyAccountsOverview(ledger("INVENTORY", "Stock Inventory"), "erp")).toBe(true);
    expect(showInIntercompanyAccountsOverview(ledger("IC-GIT-22", "Goods in Transit"), "factory")).toBe(true);
  });
});

describe("cent-exact technical profit normalization", () => {
  it("eliminates internal sale and cost equally without touching supplier or intercompany accounts", () => {
    const amount = 50928.75;
    const saleId = 4098, cogsId = 4100;
    const lines = technicalProfitNettingLines(saleId, cogsId, String(amount));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ledgerAccountId: saleId, debit: amount.toFixed(2) });
    expect(lines[1]).toMatchObject({ ledgerAccountId: cogsId, credit: amount.toFixed(2) });
    const saleAfter = -amount + Number(lines[0].debit ?? 0);
    const cogsAfter = amount - Number(lines[1].credit ?? 0);
    expect(saleAfter).toBe(0);
    expect(cogsAfter).toBe(0);
    expect(lines.every((line) => !line.supplierId && !line.bankAccountId)).toBe(true);
  });
  it("reverses the technical elimination on cancellation", () => {
    const reverse = technicalProfitNettingLines(4098, 4100, "-50928.75");
    expect(reverse[0]).toMatchObject({ ledgerAccountId: 4100, debit: "50928.75" });
    expect(reverse[1]).toMatchObject({ ledgerAccountId: 4098, credit: "50928.75" });
  });
  it("the live import, price edit, cancellation and old-PO action all retain netting", () => {
    const files = [
      "server/services/intercompany/containerTradingImport.ts",
      "server/services/intercompany/tradeSync.ts",
      "server/services/intercompany/phase5Cancel.ts",
      "server/services/intercompany/legacyProfitNetting.ts",
      "server/routes/import/intercompany-phase5.ts",
    ].map((path) => readFileSync(path, "utf8"));
    expect(files[0]).toContain("technicalProfitNetting: true");
    expect(files[0]).toContain("technicalProfitNettingLines(");
    expect(files[1]).toContain("isNettedIntercompanyTradeTx");
    expect(files[2]).toContain("isNettedIntercompanyTradeTx");
    expect(files[3]).toContain("ic-technical-profit-normalized:");
    expect(files[4]).toContain("normalize-internal-profit");
  });
});
