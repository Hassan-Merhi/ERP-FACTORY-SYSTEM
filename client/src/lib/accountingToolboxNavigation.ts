/** Developer-only navigation catalog. Paths match the existing role-guarded routes. */
export type AccountingToolboxMode = "erp" | "factory" | "properties";
export type AccountingToolCategory = "Reconciliation" | "Reporting & history" | "Release & audit" | "Diagnostics & maintenance";
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

/** Existing maintenance routes, deliberately not remapped or redirected. The toolbox is Developer-only. */
export function getDeveloperMaintenanceLinks(mode: AccountingToolboxMode): AccountingToolLink[] {
  const item = (label: string, description: string, path: string): AccountingToolLink =>
    ({ label, description, path, category: "Diagnostics & maintenance" });
  if (mode === "erp") return [
    item("Orphaned Records", "Inspect records with missing references", "/orphaned-records"),
    item("Inventory Repair", "Review inventory discrepancies", "/inventory-repair"),
    item("Balance Repair", "Review ledger reconciliation and repair", "/balance-repair"),
    item("Convergence Reconciliation", "Review source evidence and reconciliations", "/convergence-reconciliation"),
    item("Import Cycle Diagnostics", "Investigate import-cycle problems", "/import-cycle-diagnostics"),
    item("Account Migration", "Restricted ledger migration tool", "/account-migration"),
    item("Deleted Items", "Inspect historical deletions and recovery", "/deleted-items"),
  ];
  if (mode === "factory") return [
    item("Orphaned Records", "Inspect records with missing references", "/factory/orphaned-records"),
    item("Inventory Repair", "Review inventory discrepancies", "/factory/inventory-repair"),
    item("Import Cycle Diagnostics", "Investigate import-cycle problems", "/factory/import-cycle-diagnostics"),
    item("Deleted Items", "Inspect historical deletions and recovery", "/factory/deleted-items"),
    item("Balance Repair", "Review ledger reconciliation and repair", "/balance-repair"),
    item("Net Position Details", "Inspect the factory net-position breakdown", "/factory/net-position-details"),
  ];
  return [
    item("Orphaned Records", "Inspect records with missing references", "/properties/orphaned-records"),
    item("Inventory Repair", "Review inventory discrepancies", "/properties/inventory-repair"),
    item("Import Cycle Diagnostics", "Investigate import-cycle problems", "/properties/import-cycle-diagnostics"),
    item("Deleted Items", "Inspect historical deletions and recovery", "/properties/deleted-items"),
    item("Balance Repair", "Review ledger reconciliation and repair", "/properties/balance-repair"),
    item("Net Position Details", "Inspect the properties net-position breakdown", "/properties/net-position-details"),
  ];
}
