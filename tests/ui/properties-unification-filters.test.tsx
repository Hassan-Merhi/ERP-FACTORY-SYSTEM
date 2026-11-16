import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  isRentalDayInRange,
  rentalPeriodBounds,
} from "../../client/src/properties/config/rentalReportingPresentation";
import { useRentalPaymentsFilters } from "../../client/src/properties/hooks/useRentalPaymentsFilters";
import type { PaymentRow } from "../../client/src/pages/properties/RentalPaymentsLog";

function payment(id: number, date: string, unitId = 1, tenantName = "Tenant A"): PaymentRow {
  return {
    id, paymentDate: date, amount: "100", forYear: 2026, forMonth: 11,
    notes: null, contractId: id, unitId, currency: "USD",
    cashAccountId: 1, voucherId: id, tenantName, unitNumber: String(unitId),
    locationGroup: "Warehouse", sourceModule: "PROPERTIES",
  };
}

describe("Phase 12 rental period boundaries", () => {
  it("includes today and the first day of month but never future rows", () => {
    const bounds = rentalPeriodBounds("month", "2026-11-09")!;
    expect(bounds).toEqual({ since: "2026-11-01", through: "2026-11-09" });
    expect(isRentalDayInRange("2026-11-01T00:00:00Z", bounds)).toBe(true);
    expect(isRentalDayInRange("2026-11-09T23:59:59Z", bounds)).toBe(true);
    expect(isRentalDayInRange("2026-11-10", bounds)).toBe(false);
    expect(isRentalDayInRange("2026-10-31", bounds)).toBe(false);
    expect(isRentalDayInRange("2026-02-30", bounds)).toBe(false);
  });

  it("handles leap days, year crossing, and inclusive last 30 days", () => {
    const leap = rentalPeriodBounds("30days", "2024-03-01")!;
    expect(leap).toEqual({ since: "2024-02-01", through: "2024-03-01" });
    expect(isRentalDayInRange("2024-02-29", leap)).toBe(true);
    expect(isRentalDayInRange("2024-03-02", leap)).toBe(false);
    const year = rentalPeriodBounds("30days", "2026-01-01")!;
    expect(year.since).toBe("2025-12-03");
    expect(isRentalDayInRange("2025-12-02", year)).toBe(false);
    expect(rentalPeriodBounds("year", "2026-11-09")).toEqual({
      since: "2026-01-01", through: "2026-11-09",
    });
    expect(rentalPeriodBounds("all", "2026-11-09")).toBeNull();
    expect(rentalPeriodBounds("month", "invalid")).toBeNull();
  });
});

describe("Phase 12 company-scoped rental filters", () => {
  it("drops stale search, period, unit and tenant on company switching", async () => {
    const companyOne = [payment(1, "2026-11-09", 11, "Alice")];
    const companyTwo = [payment(2, "2026-11-09", 22, "Bob")];
    const { result, rerender } = renderHook(
      ({ rows, companyId }) => useRentalPaymentsFilters(rows, true, companyId),
      { initialProps: { rows: companyOne, companyId: 1 } },
    );
    act(() => {
      result.current.setSearch("Alice");
      result.current.setPeriod("month");
      result.current.setSelectedUnit("11");
      result.current.setSelectedTenant("Alice");
    });
    expect(result.current.selectedUnit).toBe("11");
    expect(result.current.selectedTenant).toBe("Alice");

    rerender({ rows: companyTwo, companyId: 2 });
    await waitFor(() => {
      expect(result.current.search).toBe("");
      expect(result.current.period).toBe("all");
      expect(result.current.selectedUnit).toBe("all");
      expect(result.current.selectedTenant).toBe("all");
      expect(result.current.filtered.map((row) => row.id)).toEqual([2]);
      expect(result.current.noFilters).toBe(true);
    });
  });

  it("clears removed selections instead of reactivating them after a refetch", async () => {
    const selected = payment(1, "2026-11-09", 11, "Alice");
    const replacement = payment(2, "2026-11-09", 22, "Bob");
    const { result, rerender } = renderHook(
      ({ rows }) => useRentalPaymentsFilters(rows, true, 1),
      { initialProps: { rows: [selected, replacement] } },
    );
    act(() => {
      result.current.setSelectedUnit("11");
      result.current.setSelectedTenant("Alice");
    });
    rerender({ rows: [replacement] });
    await waitFor(() => {
      expect(result.current.selectedUnit).toBe("all");
      expect(result.current.selectedTenant).toBe("all");
      expect(result.current.filtered.map((row) => row.id)).toEqual([2]);
    });
    rerender({ rows: [selected, replacement] });
    expect(result.current.selectedUnit).toBe("all");
    expect(result.current.selectedTenant).toBe("all");
  });
});
