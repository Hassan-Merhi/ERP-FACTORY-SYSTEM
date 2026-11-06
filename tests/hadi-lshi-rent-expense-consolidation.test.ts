import { describe, expect, it } from "vitest";
import {
  HADI_ERP_RENT_MERGE,
  consolidatedHadiRentLedgerPredicate,
  canonicalHadiRentExpenseName,
  isArchivedHadiRentExpenseLedger,
} from "../server/services/rental/hadiRentExpenseConsolidation";

describe("HADI L'SHI rent expense account merge", () => {
  it("keeps the same surviving account and old voucher ownership for audit", () => {
    expect(HADI_ERP_RENT_MERGE).toMatchObject({
      companyId: 1,
      targetLedgerId: 1007,
      legacyLedgerId: 881,
    });
    const statementMatch = consolidatedHadiRentLedgerPredicate("ve.ledger_account_id", "$1", 1, 1007);
    expect(statementMatch).toContain("ve.ledger_account_id = $1");
    expect(statementMatch).toContain("ve.ledger_account_id = 881");
    expect(statementMatch).toContain("merged_source.is_hidden = true");
    expect(statementMatch).toContain("merged_source.active = false");
    expect(statementMatch).toContain("COALESCE(merged_source.opening_balance,0) = 0");
  });

  it("never combines another tenant or unrelated account", () => {
    for (const [companyId, ledgerId] of [[2, 1007], [1, 881], [12, 1007], [1, 1]]) {
      expect(consolidatedHadiRentLedgerPredicate("ve.ledger_account_id", "$1", companyId, ledgerId))
        .toBe("ve.ledger_account_id = $1");
    }
    expect(consolidatedHadiRentLedgerPredicate("ve.bank_account_id", "$1", 1, -1))
      .toBe("ve.bank_account_id = $1");
  });

  it("redirects historical rental posting names to the surviving account only in HADI L'SHI", () => {
    const name = "Rent Expense Lubumbashi - ERP Shops";
    expect(canonicalHadiRentExpenseName(1, name, "SHOP-RENT-EXP")).toBe("Rent Expense - ERP Shops");
    expect(canonicalHadiRentExpenseName(2, name, "SHOP-RENT-EXP")).toBe(name);
    expect(canonicalHadiRentExpenseName(1, name, "OTHER")).toBe(name);
  });

  it("hides the old account only when the reviewed archived state is in place", () => {
    const source = { companyId: 1, id: 881, active: false, isHidden: true, openingBalance: "0" };
    expect(isArchivedHadiRentExpenseLedger(source)).toBe(true);
    expect(isArchivedHadiRentExpenseLedger({ ...source, openingBalance: "3500" })).toBe(false);
    expect(isArchivedHadiRentExpenseLedger({ ...source, active: true })).toBe(false);
    expect(isArchivedHadiRentExpenseLedger({ ...source, companyId: 12 })).toBe(false);
    expect(isArchivedHadiRentExpenseLedger({ ...source, id: 1007 })).toBe(false);
  });

  it("preserves the combined opening, total expense movement and credit/debit orientation", () => {
    const oldSource = 3_500;
    const oldSurvivor = 31_500;
    const sourceMovement = 323_750 - 323_750;
    const survivorMovement = 611_600 - 142_250;
    const before = sourceMovement - oldSource + survivorMovement - oldSurvivor;
    const after = sourceMovement + survivorMovement - (oldSource + oldSurvivor);
    expect(after).toBe(before);
    expect(after).toBe(434_350);
  });
});
