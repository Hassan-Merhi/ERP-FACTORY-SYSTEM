import { describe, expect, it } from "vitest";
import {
  hasSingleUsdBasis,
  isRentalDayInPeriod,
  paymentDayKey,
  rentalPeriodStart,
  rentalReportingFigure,
} from "../client/src/properties/config/rentalReportingPresentation";
import {
  HISTORICAL_RENT_CUTOFF,
  belongsToHistoricalRentSnapshot,
} from "../client/src/pages/properties/property-rental/historicalRentSnapshot";
import { hasHassanPropertiesHistoricalReportingPolicy } from "../client/src/properties/config/historicalRentReportingPolicy";

describe("Phase 8 rental financial presentation", () => {
  it("does not sum mixed, blank or mislabeled currencies as USD", () => {
    expect(hasSingleUsdBasis([{ currency: "USD" }, { currency: "usd" }, {}])).toBe(true);
    expect(hasSingleUsdBasis([{ currency: "USD" }, { currency: "CDF" }])).toBe(false);
    expect(hasSingleUsdBasis([{ currency: " USD " }, { currency: "ZMW" }])).toBe(false);
    expect(hasSingleUsdBasis([])).toBe(true);
  });

  it("preserves calculation provenance without converting financial values", () => {
    expect(rentalReportingFigure(300, "contract-paid")).toEqual({
      amount: 300, currency: "USD", basis: "contract-paid", asOfDate: null,
    });
    expect(rentalReportingFigure(null, "reconciled-account-balances")).toMatchObject({
      amount: null, currency: "USD", basis: "reconciled-account-balances",
    });
  });

  it("uses the configured company calendar date for month and year starts", () => {
    expect(rentalPeriodStart("month", "2026-11-09")).toBe("2026-11-01");
    expect(rentalPeriodStart("year", "2026-11-09")).toBe("2026-01-01");
    expect(rentalPeriodStart("all", "2026-11-09")).toBeNull();
  });

  it("includes the last 30 business-calendar days across leap-year and year boundaries", () => {
    expect(rentalPeriodStart("30days", "2024-03-01")).toBe("2024-02-01");
    expect(rentalPeriodStart("30days", "2026-01-01")).toBe("2025-12-03");
  });

  it("filters by recorded YYYY-MM-DD, independent of browser time zone", () => {
    expect(paymentDayKey("2026-11-01T00:00:00.000Z")).toBe("2026-11-01");
    expect(isRentalDayInPeriod("2026-11-01T00:00:00.000Z", "2026-11-01")).toBe(true);
    expect(isRentalDayInPeriod("2026-10-31T23:59:59Z", "2026-11-01")).toBe(false);
    expect(paymentDayKey("2026-02-30")).toBeNull();
    expect(isRentalDayInPeriod("invalid", "2026-11-01")).toBe(false);
  });

  it("keeps historical snapshot immutable and voucher-backed, not tied to a display name", () => {
    expect(HISTORICAL_RENT_CUTOFF).toBe("2026-10-26");
    const posted = { amount: "100", paymentDate: "2026-10-26", voucherId: 42, postingStatus: "POSTED", reconciliationCategory: "ENDED_RENT" };
    expect(belongsToHistoricalRentSnapshot(posted)).toBe(true);
    expect(belongsToHistoricalRentSnapshot({ ...posted, paymentDate: "2026-10-27" })).toBe(false);
    expect(belongsToHistoricalRentSnapshot({ ...posted, voucherId: null })).toBe(false);
    expect(hasHassanPropertiesHistoricalReportingPolicy({
      id: 13, code: "HP", companyType: "properties",
    })).toBe(true);
    expect(hasHassanPropertiesHistoricalReportingPolicy({
      id: 13, code: "HP", companyType: "factory",
    })).toBe(false);
    expect(hasHassanPropertiesHistoricalReportingPolicy({
      id: 13, code: "OTHER", companyType: "properties",
    })).toBe(false);
  });
});
