/**
 * Wave 12 (audit trail, owner decision 3): which audit_log rows the retention
 * job may ever remove.
 *
 * audit_log is append-only. The only deletion allowed is the scheduled
 * retention job, and it may only remove rows that are NOT about financial
 * data: rows whose table_name is in FINANCIAL_AUDIT_TABLES, or starts with one
 * of FINANCIAL_AUDIT_TABLE_PREFIXES, are kept forever. The same list is
 * compiled into the database trigger (auditLogAppendOnlyGuard.ts), so a
 * retention statement that reached a financial row would be refused by the
 * database as well. When in doubt a table belongs here: keeping a row costs
 * storage, pruning one loses history.
 */
export const FINANCIAL_AUDIT_TABLES: readonly string[] = [
  // Ledger
  "vouchers",
  "voucher_entries",
  "ledger_accounts",
  "bank_accounts",
  "fixed_assets",
  "accounting_postings",
  "accounting_posting_requests",
  "exchange_rates",
  "fiscal_period_closures",
  "fiscal_periods",
  "gl_inventory_cutovers",
  "company_data_reset",
  "companies",
  "company_settings",
  "inter_company_transfers",
  "credit_notes",
  "credit_note_items",
  "recurring_journals",
  // Parties
  "customers",
  "suppliers",
  "employees",
  // Sales, purchases, stock
  "sales",
  "sales_items",
  "pos_sales",
  "purchase_orders",
  "po_line_items",
  "supplier_proformas",
  "containers",
  "container_sales",
  "bales",
  "inventory",
  // Payroll
  "salary_advances",
  "salary_advance_deductions",
  "erp_payroll_runs",
  "erp_payroll_run_items",
  "insurance_reset",
  "insurance_members",
];

/** Families of financial tables kept forever whatever their exact name. */
export const FINANCIAL_AUDIT_TABLE_PREFIXES: readonly string[] = [
  "voucher",
  "ledger",
  "bank_",
  "fiscal_",
  "accounting_",
  "customer_",
  "supplier_",
  "employee_",
  "stock_",
  "inventory_",
  "payroll",
  "salary_",
  "erp_payroll",
  "factory_",
  "container_",
  "property_",
  "rental_",
  "pos_",
  "purchase_",
  "sales_",
  "credit_note",
  "intercompany",
  "inter_company",
  "opening_balance",
  "company_",
];

export function isFinancialAuditTable(tableName: string): boolean {
  const name = tableName.trim().toLowerCase();
  return (
    FINANCIAL_AUDIT_TABLES.includes(name) || FINANCIAL_AUDIT_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * The transaction-local setting the retention job sets (`SET LOCAL
 * app.audit_log_maintenance = 'retention'`). With it, and only for a
 * non-financial row, the trigger lets a DELETE through. Nothing else in the
 * application sets it; UPDATE is never allowed.
 */
export const AUDIT_LOG_MAINTENANCE_SETTING = "app.audit_log_maintenance";
export const AUDIT_LOG_RETENTION_MODE = "retention";
