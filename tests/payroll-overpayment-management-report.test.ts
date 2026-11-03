import { describe, expect, it } from "vitest";
import {
  isExcludedFromCompany12ManagementReports,
  OCTOBER_2026_PAYROLL_OVERPAYMENT_ACCOUNT,
} from "../server/lib/payrollOverpaymentReporting";
import { classifyNetPositionAccounts, getAccountNetBalance, type AccountLike } from "../server/netPositionHelper";

const asset = (id: number, name: string, companyId = 12): AccountLike => ({
  id, companyId, name, code: null, accountType: "Asset", openingBalance: "0",
  openingBalanceSide: "Dr",
});

describe("company-12 payroll overpayment management reporting", () => {
  it("excludes only the exact October 2026 company-12 receivable", () => {
    const target = asset(1, OCTOBER_2026_PAYROLL_OVERPAYMENT_ACCOUNT);
    expect(isExcludedFromCompany12ManagementReports(12, target)).toBe(true);
    expect(isExcludedFromCompany12ManagementReports(13, target)).toBe(false);
    expect(isExcludedFromCompany12ManagementReports(12, asset(2, "Payroll Overpayments Receivable - November 2026"))).toBe(false);
    expect(isExcludedFromCompany12ManagementReports(12, asset(3, "Regular Receivable"))).toBe(false);
  });

  it("removes the line and $435.81 from management Net Position without changing posted balances", () => {
    const accounts = [asset(1, OCTOBER_2026_PAYROLL_OVERPAYMENT_ACCOUNT), asset(2, "Cash Drawer")];
    const balances = new Map([[1, { debit: 435.81, credit: 0 }], [2, { debit: 1000, credit: 0 }]]);
    const projected = classifyNetPositionAccounts(accounts, balances);
    expect(projected.forUsTotal).toBe(1000);
    expect(projected.forUsAccounts.map((row) => row.name)).toEqual(["Cash Drawer"]);
    // The posting is still in the GL: only management projection excludes it.
    expect(getAccountNetBalance(accounts[0], balances)).toBe(435.81);
    expect(balances.get(1)?.debit).toBe(435.81);
    // Another tenant's identically named asset is not affected.
    const otherCompany = classifyNetPositionAccounts(
      [asset(1, OCTOBER_2026_PAYROLL_OVERPAYMENT_ACCOUNT, 13)],
      balances
    );
    expect(otherCompany.forUsTotal).toBe(435.81);
  });
});
