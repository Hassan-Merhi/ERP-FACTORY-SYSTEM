import { describe, expect, it } from "vitest";
import {
  PROPERTIES_RENT_CASH_CODE,
  isPropertiesReceiptAccountType,
  propertiesRentCashboxSetupValues,
  shouldRunRentalAutoTransfer,
} from "../server/services/rental/rentalCashboxPolicy";

describe("Properties rent cashbox policy", () => {
  it("keeps Properties receipts local while retaining ERP and Factory auto-transfer behavior", () => {
    expect(shouldRunRentalAutoTransfer("PROPERTIES")).toBe(false);
    expect(shouldRunRentalAutoTransfer("ERP")).toBe(true);
    expect(shouldRunRentalAutoTransfer("FACTORY")).toBe(true);
  });

  it("builds a zero-opening cashbox for the selected company without migrating old balances", () => {
    const first = propertiesRentCashboxSetupValues(41);
    const second = propertiesRentCashboxSetupValues(42);

    expect(first).toEqual({
      companyId: 41,
      code: PROPERTIES_RENT_CASH_CODE,
      name: "Properties Rent Cashbox",
      accountType: "Cash",
      subType: "Current Asset",
      openingBalance: "0",
      active: true,
      isHidden: false,
    });
    expect(second.companyId).toBe(42);
    expect(second.code).toBe(first.code);
    expect(second.openingBalance).toBe("0");
  });

  it("accepts only cash, bank and asset receipt destinations", () => {
    for (const type of ["Cash", "Bank", "Asset"]) {
      expect(isPropertiesReceiptAccountType(type)).toBe(true);
    }
    for (const type of ["Liability", "Income", "Expense", "Equity", ""]) {
      expect(isPropertiesReceiptAccountType(type)).toBe(false);
    }
  });
});
