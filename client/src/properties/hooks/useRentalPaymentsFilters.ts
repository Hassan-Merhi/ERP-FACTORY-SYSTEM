import { useMemo, useState } from "react";
import { searchAny } from "@shared/searchNormalization";
import { isRentalDayInPeriod, rentalPeriodStart } from "@/properties/config/rentalReportingPresentation";
import type { PaymentRow } from "@/pages/properties/RentalPaymentsLog";
import type { PaymentsPeriod } from "@/pages/properties/property-rental/components/PropertiesPaymentsPremium";

export const RECONCILIATION_VIEWS = [
  { key: "HISTORICAL_RENT", label: "Rent through 26 Oct" },
  { key: "ACTIVE_RENT", label: "Active rent" },
  { key: "GUARANTEE", label: "Guarantee movements" },
  { key: "ENDED_RENT", label: "Ended leases" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "OTHER", label: "Other / billing adjustments" },
  { key: "ALL", label: "All records" },
] as const;
export type ReconciliationView = (typeof RECONCILIATION_VIEWS)[number]["key"];

/** Display-only filtering using the configured company business calendar.
 * No server posting dates, recorded transaction dates, or allocations change.
 */
export function useRentalPaymentsFilters(
  payments: readonly PaymentRow[],
  isPropertiesPayments: boolean,
  paymentsAllRecordsOnly: boolean,
) {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<PaymentsPeriod>("all");
  const [selectedUnit, setSelectedUnit] = useState("all");
  const [selectedTenant, setSelectedTenant] = useState("all");
  const [reconciliationView, setReconciliationView] = useState<ReconciliationView>("HISTORICAL_RENT");
  const effectiveView: ReconciliationView = paymentsAllRecordsOnly
    ? "ALL"
    : reconciliationView === "HISTORICAL_RENT"
      ? "ACTIVE_RENT"
      : reconciliationView;

  const viewPayments = useMemo(() => {
    if (!isPropertiesPayments || effectiveView === "ALL") return payments;
    if (effectiveView === "OTHER") {
      return payments.filter((p) =>
        p.reconciliationCategory === "OTHER" ||
        (p.voucherId == null && p.reconciliationCategory === "ACTIVE_RENT")
      );
    }
    return payments.filter((p) => p.reconciliationCategory === effectiveView);
  }, [payments, isPropertiesPayments, effectiveView]);

  const unitOptions = useMemo(() => {
    const uniqueUnits = new Map<string, string>();
    payments.forEach((payment) => {
      if (payment.unitId != null && !uniqueUnits.has(String(payment.unitId))) {
        uniqueUnits.set(
          String(payment.unitId),
          [payment.unitNumber, payment.locationGroup].filter(Boolean).join(" — ") || `Unit ${payment.unitId}`
        );
      }
    });
    return [...uniqueUnits.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [payments]);

  const tenantOptions = useMemo(
    () => [...new Set(payments.map((p) => p.tenantName).filter((name): name is string => Boolean(name)))]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: value })),
    [payments],
  );

  const filtered = useMemo(() => {
    const since = rentalPeriodStart(period);
    return viewPayments.filter((p) => {
      if (search.trim() && !searchAny(
        search, p.tenantName, p.unitNumber, p.locationGroup, p.notes,
        p.sourceModule, String(p.voucherId ?? "")
      )) return false;
      if (isPropertiesPayments && selectedUnit !== "all" && String(p.unitId) !== selectedUnit) return false;
      if (isPropertiesPayments && selectedTenant !== "all" && p.tenantName !== selectedTenant) return false;
      if (isPropertiesPayments && !isRentalDayInPeriod(p.paymentDate, since)) return false;
      return true;
    });
  }, [viewPayments, search, period, selectedUnit, selectedTenant, isPropertiesPayments]);

  const noFilters = !search.trim() && period === "all" && selectedUnit === "all" && selectedTenant === "all";
  return {
    search, setSearch, period, setPeriod, selectedUnit, setSelectedUnit,
    selectedTenant, setSelectedTenant, reconciliationView, setReconciliationView,
    effectiveView, viewPayments, unitOptions, tenantOptions, filtered, noFilters,
  };
}
