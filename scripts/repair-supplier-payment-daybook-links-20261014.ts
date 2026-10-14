/**
 * One-time, nonfinancial legacy daybook link repair. No balance or voucher changes.
 * Company 12: factory payments #2/#3 have posted vouchers but their historical
 * SUPPLIER_PAYMENT daybook rows (11408,11409) have reference_table = NULL.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;

export function repairSupplierPaymentDaybookLinks20261014(): Promise<number> {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY), async () =>
    db.transaction(async (tx) => {
      const payments = await tx.execute(sql`
        SELECT p.id
          FROM factory_supplier_payments p
         WHERE p.company_id = ${COMPANY} AND p.id IN (2, 3)
         ORDER BY p.id
      `);
      if (payments.rows.length !== 2 || Number(payments.rows[0].id) !== 2 ||
          Number(payments.rows[1].id) !== 3) {
        throw new Error("Expected supplier payments #2 and #3 missing; no changes");
      }

      const voucherChecks = await tx.execute(sql`
        SELECT p.id,
               (SELECT COUNT(*) FROM vouchers v
                 WHERE v.company_id = p.company_id
                   AND v.deleted_at IS NULL AND v.optional = false
                   AND v.voucher_number LIKE 'FACTORY-PAY-' || p.id::text || '-%') AS vouchers
          FROM factory_supplier_payments p
         WHERE p.company_id = ${COMPANY} AND p.id IN (2, 3)
      `);
      if (voucherChecks.rows.length !== 2 ||
          voucherChecks.rows.some((row) => Number(row.vouchers) !== 1)) {
        throw new Error("Existing supplier payment vouchers do not uniquely match; no changes");
      }

      const rows = await tx.execute(sql`
        SELECT d.id, d.reference_id, d.reference_table, d.tx_type
          FROM factory_daybook_entries d
         WHERE d.company_id = ${COMPANY} AND d.id IN (11408, 11409)
         ORDER BY d.id FOR UPDATE
      `);
      if (rows.rows.length !== 2 ||
          Number(rows.rows[0].id) !== 11408 ||
          Number(rows.rows[0].reference_id) !== 2 ||
          Number(rows.rows[1].id) !== 11409 ||
          Number(rows.rows[1].reference_id) !== 3 ||
          rows.rows.some((row) => row.tx_type !== "SUPPLIER_PAYMENT" ||
            (row.reference_table !== null && row.reference_table !== "factory_supplier_payments"))) {
        throw new Error("Historical daybook source rows changed; no changes");
      }

      const updated = await tx.execute(sql`
        UPDATE factory_daybook_entries d
           SET reference_table = 'factory_supplier_payments'
         WHERE d.company_id = ${COMPANY}
           AND d.reference_table IS NULL
           AND ((d.id = 11408 AND d.reference_id = 2)
             OR (d.id = 11409 AND d.reference_id = 3))
           AND d.tx_type = 'SUPPLIER_PAYMENT'
        RETURNING d.id
      `);
      return updated.rows.length;
    })
  );
}
