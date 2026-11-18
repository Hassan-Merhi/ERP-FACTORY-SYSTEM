import { useHubQueryState } from "@/hooks/use-hub-query-state";

/**
 * ERP Payroll keeps its open tabs in the URL, the same two-level scheme as Factory Payroll:
 * `?section=` picks the top tab and `?tab=` the sub-tab inside it (Advances + Deductions and
 * Run Payroll). A link without them opens the first tab of each level.
 */
export const PAYROLL_SECTIONS = ["employees", "workers", "advances", "run-payroll"] as const;
export type PayrollSection = (typeof PAYROLL_SECTIONS)[number];

export const PAYROLL_ADVANCES_TABS = ["advances", "repayments", "worker-deductions"] as const;
export type PayrollAdvancesTab = (typeof PAYROLL_ADVANCES_TABS)[number];

export const PAYROLL_RUN_TABS = ["run", "history"] as const;
export type PayrollRunTab = (typeof PAYROLL_RUN_TABS)[number];

export function usePayrollSection() {
  return useHubQueryState<PayrollSection>({
    key: "section",
    allowedValues: PAYROLL_SECTIONS,
    defaultValue: "employees",
    clearKeys: ["tab"],
  });
}

export function usePayrollAdvancesTab() {
  return useHubQueryState<PayrollAdvancesTab>({
    key: "tab",
    allowedValues: PAYROLL_ADVANCES_TABS,
    defaultValue: "advances",
  });
}

export function usePayrollRunTab() {
  return useHubQueryState<PayrollRunTab>({
    key: "tab",
    allowedValues: PAYROLL_RUN_TABS,
    defaultValue: "run",
  });
}

export function isPayrollSection(value: string): value is PayrollSection {
  return (PAYROLL_SECTIONS as readonly string[]).includes(value);
}

export function isPayrollAdvancesTab(value: string): value is PayrollAdvancesTab {
  return (PAYROLL_ADVANCES_TABS as readonly string[]).includes(value);
}
