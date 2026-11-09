import { describe, expect, it } from "vitest";
import {
  HASSAN_PROPERTIES_REPORTING_COMPANY_ID,
  hasHassanPropertiesHistoricalReportingPolicy,
} from "../client/src/properties/config/historicalRentReportingPolicy";
import {
  belongsToHistoricalRentSnapshot,
  historicalRentSnapshotTotal,
} from "../client/src/pages/properties/property-rental/historicalRentSnapshot";
import {
  PROPERTIES_LEGACY_RENTAL_REDIRECTS,
  PROPERTIES_NAVIGATION,
  PROPERTIES_RENTAL_TABS,
  canNavigateProperties,
  canUsePropertiesCapability,
} from "../client/src/properties/config/propertiesNavigation";
import { rentalUnitTotals } from "../client/src/properties/hooks/useRentalOverview";
import type { Unit } from "../client/src/pages/properties/property-rental/types";

describe("Properties unification source regression contracts", () => {
  const properties = { id: 13, code: "HP", companyType: "properties" as const, role: "Admin" };
  it("scopes the dated snapshot by verified stable company identity", () => {
    expect(HASSAN_PROPERTIES_REPORTING_COMPANY_ID).toBe(13);
    expect(hasHassanPropertiesHistoricalReportingPolicy(properties)).toBe(true);
    expect(hasHassanPropertiesHistoricalReportingPolicy({ ...properties, id: 14 })).toBe(false);
    expect(hasHassanPropertiesHistoricalReportingPolicy({ ...properties, code: "OTHER" })).toBe(false);
    expect(hasHassanPropertiesHistoricalReportingPolicy({ ...properties, companyType: "erp" })).toBe(false);
    expect(hasHassanPropertiesHistoricalReportingPolicy(null)).toBe(false);
  });

  it("keeps 26 October voucher-backed rent and ended leases, not later or non-cash rows", () => {
    const baseline = { amount: "10.25", paymentDate: "2026-10-26", voucherId: 11, postingStatus: "POSTED" };
    const rows = [
      { ...baseline, reconciliationCategory: "ACTIVE_RENT" },
      { ...baseline, reconciliationCategory: "ENDED_RENT", amount: "20" },
      { ...baseline, paymentDate: "2026-10-27", reconciliationCategory: "ACTIVE_RENT" },
      { ...baseline, voucherId: null, reconciliationCategory: "ACTIVE_RENT" },
      { ...baseline, reconciliationCategory: "GUARANTEE" },
      { ...baseline, postingStatus: "SCHEDULED", reconciliationCategory: "ACTIVE_RENT" },
    ];
    expect(rows.map(belongsToHistoricalRentSnapshot)).toEqual([true, true, false, false, false, false]);
    expect(historicalRentSnapshotTotal(rows)).toBe(30.25);
  });

  it("keeps all three rental tabs and replacement aliases", () => {
    expect(PROPERTIES_RENTAL_TABS.map((tab) => tab.value)).toEqual(["warehouses", "shops", "payments"]);
    expect(PROPERTIES_LEGACY_RENTAL_REDIRECTS["/properties/rental/shops"])
      .toBe("/properties/rentals?tab=shops");
    expect(PROPERTIES_LEGACY_RENTAL_REDIRECTS["/properties/rental/payments"])
      .toBe("/properties/rentals?tab=payments");
    expect(PROPERTIES_NAVIGATION.filter((entry) => entry.navigation === "pinned")).toHaveLength(6);
    expect(PROPERTIES_NAVIGATION.find((entry) => entry.path === "/properties/dashboard")?.navigation).toBe("hidden");
  });

  it("respects selected-company roles for routes, search, and transfer visibility", () => {
    const developer = { role: "Developer" };
    expect(canNavigateProperties("/properties/transfer", developer, properties)).toBe(false);
    expect(canUsePropertiesCapability("developer", developer, { ...properties, role: "Developer" })).toBe(true);
    expect(canNavigateProperties("/properties/transfer", developer, { ...properties, role: "Developer" })).toBe(true);
    expect(canNavigateProperties("/properties/settings", { role: "User" }, properties)).toBe(true);
    expect(canNavigateProperties("/properties/my-settings", { role: "ERP Tester" }, { ...properties, role: "ERP Tester" })).toBe(false);
    expect(canNavigateProperties("/properties/rentals", developer, { ...properties, companyType: "factory" })).toBe(false);
  });

  it("keeps projected Factory/ERP leases out of Properties financial summaries", () => {
    const unit = {
      id: 1, locationGroup: "A", unitNumber: "1", unitType: "WAREHOUSE",
      contract: { status: "ACTIVE", guaranteeAmount: "50", rentalAmount: "100" },
      outstanding: 20, totalPaid: 60, prepaidCredit: 5,
    } as Unit;
    const totals = rentalUnitTotals([unit, { ...unit, id: 2, isInternalLeaseProjection: true }]);
    expect(totals).toEqual({
      totalGuarantee: 50,
      totalOwed: 20,
      totalCredit: 5,
      totalPaid: 60,
      totalMonthlyRent: 100,
    });
  });
});
