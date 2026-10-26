/** Developer-only navigation catalog. Paths match the existing role-guarded routes. */
export type AccountingToolboxMode = "erp" | "factory" | "properties";
export type AccountingToolCategory = "Reconciliation" | "Reporting & history" | "Release & audit";
export interface AccountingToolLink {
  label: string;
  description: string;
  path: string;
  category: AccountingToolCategory;
}

export function getAccountingToolLinks(mode: AccountingToolboxMode): AccountingToolLink[] {
  const root = mode === "erp" ? "/accounting" : `/${mode}/accounting`;
  const link = (slug: string, label: string, description: string, category: AccountingToolCategory): AccountingToolLink =>
    ({ path: `${root}/${slug}`, label, description, category });
  return [
    link("open-items", "Open Items", "Outstanding and unapplied items", "Reconciliation"),
    link("cash-bank", "Bank & Cash Reconciliation", "Cash and bank reconciliation", "Reconciliation"),
    link("monetary-fx", "Multi-Currency Accounting", "FX and monetary balance review", "Reconciliation"),
    ...(mode === "erp" ? [
      link("erp-inventory", "Inventory & COGS Accounting", "ERP stock and cost-of-sales checks", "Reconciliation"),
      link("factory-production", "Factory Production Accounting", "Factory production accounting checks", "Reconciliation"),
    ] : mode === "factory" ? [
      link("production", "Factory Production Accounting", "Factory production accounting checks", "Reconciliation"),
    ] : []),
    link("rentals", "Rental Accounting", "Rental accounting review", "Reconciliation"),
    link("consolidation", "Intercompany & Consolidation", "Group and intercompany reporting", "Reporting & history"),
    link("history", "Historical Accounting", "Historical accounting review", "Reporting & history"),
    link("statements", "Financial Statements", "Financial statements and reporting", "Reporting & history"),
    link("fiscal-review", "Fiscal Closing & Audit", "Fiscal close and audit review", "Release & audit"),
    link("dashboard", "Unified Accounting Dashboard", "Accounting overview and readiness", "Reporting & history"),
    link("rollout", "Unified Accounting Rollout", "Release readiness and review metadata", "Release & audit"),
  ];
}
