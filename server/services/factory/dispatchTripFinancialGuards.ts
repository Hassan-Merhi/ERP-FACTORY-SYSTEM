/**
 * Company-scoped protective reads for the new dispatch financial lifecycle.
 *
 * These checks are safe before the manual Phase 2 TablePlus SQL is applied.
 * Critical paths call them INSIDE the same customer-order lock transaction as
 * their writes, not in a UI-only check.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction, DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";

export async function tripFinancialSchemaInstalledTx(tx: DbTransaction): Promise<boolean> {
  const [row] = resultRows(await tx.execute(sql`
    SELECT to_regclass('public.factory_dispatch_trip_financials') IS NOT NULL AS installed
  `));
  return row?.installed === true;
}

export async function hasLiveFinancialTripTx(
  tx: DbTransaction, companyId: number, orderId: number, dispatchId?: number
): Promise<boolean> {
  if (!(await tripFinancialSchemaInstalledTx(tx))) return false;
  const [row] = resultRows(await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM factory_dispatch_trip_financials
       WHERE company_id = ${companyId} AND order_id = ${orderId}
         AND status IN ('POSTED', 'CONSOLIDATED')
         ${dispatchId ? sql`AND dispatch_id = ${dispatchId}` : sql``}
    ) AS found
  `));
  return row?.found === true;
}

export async function hasAnyPhysicalDispatchTx(
  tx: DbTransaction, companyId: number, orderId: number
): Promise<boolean> {
  const [row] = resultRows(await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM factory_loading_dispatches
       WHERE company_id = ${companyId} AND order_id = ${orderId}
         AND status <> 'CANCELLED'
    ) AS found
  `));
  return row?.found === true;
}

/** Reject removal/repricing of the precise signed bale, not a valid unshipped one. */
export async function isPostedDispatchBaleTx(
  tx: DbTransaction, companyId: number, orderId: number, baleId: number
): Promise<boolean> {
  if (!(await tripFinancialSchemaInstalledTx(tx))) return false;
  const [row] = resultRows(await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM factory_dispatch_trip_financial_bales b
        JOIN factory_dispatch_trip_financials f
          ON f.id=b.financial_id AND f.company_id=b.company_id
         AND f.order_id=b.order_id AND f.dispatch_id=b.dispatch_id
       WHERE b.company_id=${companyId} AND b.order_id=${orderId}
         AND b.bale_id=${baleId} AND b.snapshot_revision=f.snapshot_revision
         AND f.status IN ('POSTED','CONSOLIDATED')
    ) AS found
  `));
  return row?.found === true;
}

/**
 * A source-owned voucher (including an offsetting reversal) must never be
 * edited, retired or reversed through the generic voucher editor: that would
 * desynchronize the trip's immutable POST/REVERSAL record from the ledger.
 */
export async function isDispatchFinancialVoucherTx(
  executor: DatabaseOrTransaction, companyId: number, voucherId: number
): Promise<boolean> {
  const [schema] = resultRows(await executor.execute(sql`
    SELECT to_regclass('public.factory_dispatch_trip_postings') IS NOT NULL AS installed
  `));
  if (schema?.installed !== true) return false;
  const [row] = resultRows(await executor.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM factory_dispatch_trip_postings
       WHERE company_id=${companyId}
         AND voucher_ids @> jsonb_build_array(${voucherId}::integer)
    ) AS found
  `));
  return row?.found === true;
}
