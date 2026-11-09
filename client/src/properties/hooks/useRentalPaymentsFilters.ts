import { useEffect, useMemo, useRef, useState } from "react";
import { searchAny } from "@shared/searchNormalization";
import { isRentalDayInRange, rentalPeriodBounds } from "@/properties/config/rentalReportingPresentation";
import type { PaymentRow } from "@/pages/properties/RentalPaymentsLog";
import type { PaymentsPeriod } from "@/pages/properties/property-rental/components/PropertiesPaymentsPremium";

/** Display-only filtering using the configured company business calendar.
 * No server posting dates, recorded transaction dates, or allocations change.
 */
export function useRentalPaymentsFilters(
  payments: readonly PaymentRow[],
  isPropertiesPayments: boolean,
  companyId?: number | null,
) {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<PaymentsPeriod>("all");
  const [selectedTenantState, setSelectedTenant] = useState("all");
  const [selectedUnitState, setSelectedUnit] = useState("all");
  const previousCompanyId = useRef(companyId);
  const companyChanged = previousCompanyId.current !== companyId;

  // Reset only after a real company transition, not after every payment refetch.
  // The render-time guard prevents stale selections/search from flashing in the new company.
  useEffect(() => {
    if (previousCompanyId.current === companyId) return;
    previousCompanyId.current = companyId;
    setSearch("");
    setPeriod("all");
    setSelectedUnit("all");
    setSelectedTenant("all");
  }, [companyId]);
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

  const selectedUnit = !companyChanged && unitOptions.some((option) => option.value === selectedUnitState)
    ? selectedUnitState : "all";
  const selectedTenant = !companyChanged && tenantOptions.some((option) => option.value === selectedTenantState)
    ? selectedTenantState : "all";
  const effectiveSearch = companyChanged ? "" : search;
  const effectivePeriod = companyChanged ? "all" : period;

  // A removed unit/tenant must not silently re-activate if the option later returns.
  useEffect(() => {
    if (companyChanged) return;
    if (selectedUnitState !== "all" && selectedUnit === "all") setSelectedUnit("all");
    if (selectedTenantState !== "all" && selectedTenant === "all") setSelectedTenant("all");
  }, [companyChanged, selectedUnitState, selectedUnit, selectedTenantState, selectedTenant]);

  const filtered = useMemo(() => {
    const bounds = rentalPeriodBounds(effectivePeriod);
    return payments.filter((p) => {
      if (effectiveSearch.trim() && !searchAny(
        effectiveSearch, p.tenantName, p.unitNumber, p.locationGroup, p.notes,
        p.sourceModule, String(p.voucherId ?? "")
      )) return false;
      if (isPropertiesPayments && selectedUnit !== "all" && String(p.unitId) !== selectedUnit) return false;
      if (isPropertiesPayments && selectedTenant !== "all" && p.tenantName !== selectedTenant) return false;
      if (isPropertiesPayments && effectivePeriod !== "all" &&
          (!bounds || !isRentalDayInRange(p.paymentDate, bounds))) return false;
      return true;
    });
  }, [payments, effectiveSearch, effectivePeriod, selectedUnit, selectedTenant, isPropertiesPayments]);

  const noFilters = !effectiveSearch.trim() && effectivePeriod === "all" && selectedUnit === "all" && selectedTenant === "all";
  return {
    search: effectiveSearch, setSearch, period: effectivePeriod, setPeriod, selectedUnit, setSelectedUnit,
    selectedTenant, setSelectedTenant,
    unitOptions, tenantOptions, filtered, noFilters,
  };
}
