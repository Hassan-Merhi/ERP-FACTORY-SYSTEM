import { describe, expect, it } from "vitest";
import {
  canNavigateProperties,
  canUsePropertiesCapability,
  propertiesEffectiveRole,
} from "../client/src/properties/config/propertiesNavigation";
import {
  rentalCurrencyEvidence,
  hasVerifiedUsdBasis,
} from "../client/src/properties/config/rentalCurrencyBasis";
import { hasSingleUsdBasis } from "../client/src/properties/config/rentalReportingPresentation";
import { paymentHistoryTsv, reconciledHistoryTsv, propertiesAccountBalanceSplit, accountBalanceHistoryBridge } from "../client/src/pages/properties/property-rental/paymentsReceiptMath";
import { HISTORICAL_RENT_CUTOFF, belongsToHistoricalRentSnapshot } from "../client/src/pages/properties/property-rental/historicalRentSnapshot";
import { hasHassanPropertiesHistoricalReportingPolicy } from "../client/src/properties/config/historicalRentReportingPolicy";

const hp = { id: 13, code: "HP", companyType: "properties" as const, role: "Admin" };
const staleDeveloper = { role: "Developer", currentRole: "Developer" };

describe("Phase 14 selected-company frontend capability parity", () => {
  it("denies all Properties routes when selected company or its assignment is missing", () => {
    expect(propertiesEffectiveRole(staleDeveloper, null)).toBeNull();
    expect(canUsePropertiesCapability("workspace", staleDeveloper, null)).toBe(false);
    expect(canNavigateProperties("/properties/transfer", staleDeveloper, null)).toBe(false);
    expect(canNavigateProperties("/properties/settings", staleDeveloper, { ...hp, role: undefined })).toBe(false);
    expect(canNavigateProperties("/properties/daybook", staleDeveloper, { ...hp, role: "" })).toBe(false);
    expect(canNavigateProperties("/properties/accounts", staleDeveloper, { ...hp, companyType: "factory" })).toBe(false);
  });

  it("enforces selected-company role instead of stale privileged session role", () => {
    expect(propertiesEffectiveRole(staleDeveloper, { ...hp, role: "Manager" })).toBe("Manager");
    expect(canNavigateProperties("/properties/transfer", staleDeveloper, { ...hp, role: "Manager" })).toBe(false);
    expect(canNavigateProperties("/properties/settings", staleDeveloper, { ...hp, role: "Manager" })).toBe(false);
    expect(canNavigateProperties("/properties/rentals", staleDeveloper, { ...hp, role: "Manager" })).toBe(true);
    expect(canNavigateProperties("/properties/settings", { role: "User" }, hp)).toBe(true);
    expect(canNavigateProperties("/properties/transfer", { role: "User" }, { ...hp, role: "Developer" })).toBe(true);
    expect(canNavigateProperties("/properties/my-settings", staleDeveloper, { ...hp, role: "ERP Tester" })).toBe(false);
  });
});

describe("Phase 14 read-only financial/currency parity", () => {
  it("distinguishes USD, recorded foreign currency and unknown currency", () => {
    expect(rentalCurrencyEvidence(" usd ")).toBe("USD");
    expect(rentalCurrencyEvidence("CDF")).toBe("NON_USD");
    expect(rentalCurrencyEvidence("")).toBe("UNKNOWN");
    expect(rentalCurrencyEvidence(null)).toBe("UNKNOWN");
    expect(hasVerifiedUsdBasis([{ currency: "USD" }, { currency: "usd" }])).toBe(true);
    expect(hasVerifiedUsdBasis([{ currency: "USD" }, {}])).toBe(false);
    expect(hasSingleUsdBasis([{ currency: "USD" }, { currency: "CDF" }])).toBe(false);
    expect(hasVerifiedUsdBasis([])).toBe(true);
  });

  it("will not label unknown or foreign-currency history with USD columns", () => {
    const row = { id: 7, paymentDate: "2026-10-26", amount: "20.00", voucherId: 4, cashAccountId: 3, postingStatus: "POSTED" };
    for (const currency of [undefined, "", "CDF"]) {
      expect(() => paymentHistoryTsv([{ ...row, currency }])).toThrow(/mixed-currency/);
      expect(() => reconciledHistoryTsv([{ ...row, currency }], { aliCashLedgerId: 3, threeAccountsTotal: 2000 })).toThrow(/mixed-currency/);
    }
    expect(paymentHistoryTsv([{ ...row, currency: "USD" }])).toContain("Cash Received (USD)");
  });

  it("keeps posted voucher history and recorded guarantee overlap separate from account balances", () => {
    expect(HISTORICAL_RENT_CUTOFF).toBe("2026-10-26");
    expect(hasHassanPropertiesHistoricalReportingPolicy(hp)).toBe(true);
    expect(hasHassanPropertiesHistoricalReportingPolicy({ ...hp, id: 14 })).toBe(false);
    const paid = { id: 1, amount: "50", paymentDate: "2026-10-26", voucherId: 11, cashAccountId: 5, postingStatus: "POSTED", reconciliationCategory: "ACTIVE_RENT", currency: "USD" };
    expect(belongsToHistoricalRentSnapshot(paid)).toBe(true);
    expect(belongsToHistoricalRentSnapshot({ ...paid, paymentDate: "2026-10-27" })).toBe(false);
    const guarantee = { ...paid, id: 2, amount: "25", receiptKind: "GUARANTEE_DEPOSIT", reconciliationCategory: "GUARANTEE" };
    expect(belongsToHistoricalRentSnapshot(guarantee)).toBe(false);
    const bridge = accountBalanceHistoryBridge([paid, guarantee], [5]);
    expect(bridge.cashAndLiabilityOverlap).toBe(2500);
    expect(bridge.history.cash).toBe(7500);
    expect(propertiesAccountBalanceSplit(5000, 2500, 2500, 0)).toEqual({
      rentAndCashBalance: 7500, depositBalance: 2500, accountSum: 10000,
    });
  });
});
