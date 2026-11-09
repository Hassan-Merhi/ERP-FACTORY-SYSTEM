import { useMemo } from "react";
import type { Unit } from "@/pages/properties/property-rental/types";

/** Read-only display totals: exclude Factory/ERP projections from Properties landlord totals. */
export function rentalUnitTotals(units: readonly Unit[]) {
  let totalGuarantee = 0;
  let totalOwed = 0;
  let totalCredit = 0;
  let totalPaid = 0;
  let totalMonthlyRent = 0;
  for (const u of units) {
    if (u.isInternalLeaseProjection || !u.contract) continue;
    totalGuarantee += Number((u.guaranteeRemaining ?? u.contract.guaranteeAmount) || 0);
    const outstanding = u.outstanding ?? 0;
    if (outstanding > 0) totalOwed += outstanding;
    totalCredit += u.prepaidCredit ?? 0;
    totalPaid += u.totalPaid ?? 0;
    if (u.contract.status === "ACTIVE" || !u.contract.status) {
      totalMonthlyRent += Number(u.contract.rentalAmount || 0);
    }
  }
  return { totalGuarantee, totalOwed, totalCredit, totalPaid, totalMonthlyRent };
}

export function useRentalOverview(units: readonly Unit[]) {
  return useMemo(() => rentalUnitTotals(units), [units]);
}

export function useGroupedRentalUnits(units: readonly Unit[]) {
  return useMemo(() => {
    const groups = new Map<string, Unit[]>();
    units.forEach((u) => {
      if (!groups.has(u.locationGroup)) groups.set(u.locationGroup, []);
      groups.get(u.locationGroup)!.push(u);
    });
    const naturalCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    return Array.from(groups.entries())
      .sort(([a], [b]) => naturalCmp(a, b))
      .map(([grp, us]) => [grp, [...us].sort((a, b) => naturalCmp(a.unitNumber, b.unitNumber))] as [string, Unit[]]);
  }, [units]);
}
