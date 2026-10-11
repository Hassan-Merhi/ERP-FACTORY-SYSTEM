/**
 * Which audit_log rows the retention job may ever remove.
 *
 * Wave 12 (owner decision 3) kept financial rows forever with a deny-list of
 * financial tables and prefixes; any table the list missed (retail_*, sp_*,
 * mix batches, new tables) was prunable. Phase 21 (A), AT5 (decided by
 * default, owner can override): the list is now an ALLOW-list of tables whose
 * audit rows are not financial and may be pruned. Every other table — every
 * ledger, party, stock, sales, payroll, factory, rental, retail, SP, settings
 * and user/permission table, and any table added later — is kept forever.
 * The same list is compiled into the database (erp_audit_log_is_financial,
 * auditLogAppendOnlyGuard.ts), so a retention statement that reached another
 * row is refused by the database as well. Adding a table here needs a review:
 * keeping a row costs storage, pruning one loses history.
 */
export const PRUNABLE_AUDIT_TABLES: readonly string[] = [
  // Remote support session views and controls (the retention job's target).
  "remote_support_sessions",
  // Report / export deliveries (who sent which report where), not the data.
  "reports",
  "location_whatsapp_stock_reports",
  "location_whatsapp_stock_deliveries",
  "location_whatsapp_stock_schedules",
];

export function isPrunableAuditTable(tableName: string): boolean {
  return PRUNABLE_AUDIT_TABLES.includes(tableName.trim().toLowerCase());
}

/** True for every table whose audit rows are kept forever (all but the allow-list). */
export function isFinancialAuditTable(tableName: string): boolean {
  return !isPrunableAuditTable(tableName);
}

/**
 * The transaction-local setting the retention job sets (`SET LOCAL
 * app.audit_log_maintenance = 'retention'`). With it, and only for a
 * non-financial row, the trigger lets a DELETE through. Nothing else in the
 * application sets it; UPDATE is never allowed.
 */
export const AUDIT_LOG_MAINTENANCE_SETTING = "app.audit_log_maintenance";
export const AUDIT_LOG_RETENTION_MODE = "retention";
