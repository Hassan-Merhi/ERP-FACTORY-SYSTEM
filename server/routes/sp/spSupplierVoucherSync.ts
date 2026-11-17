import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, pool, type DatabaseOrTransaction } from "../../db";
import { writeAuditEvent } from "../../services/audit";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";

/** A Goods-OTW voucher whose supplier differs from its container's, as the repair would change it. */
export interface SpSupplierLinkRepairVoucher {
  containerId: number;
  containerNumber: string | null;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  effectiveDate: string | null;
  optional: boolean;
  periodClosed: boolean;
  header: { from: number | null; to: number | null } | null;
  lines: {
    entryId: number;
    ledgerAccountId: number;
    debit: string;
    credit: string;
    from: number | null;
    to: number | null;
  }[];
}

export interface SpSupplierLinkRepairPlan {
  companyId: number;
  vouchers: SpSupplierLinkRepairVoucher[];
  /** Vouchers in a closed period: listed, never changed (the apply skips them). */
  closedPeriodVoucherIds: number[];
  planHash: string;
}

export class SpSupplierLinkRepairRefusal extends Error {
  constructor(
    readonly code: "PLAN_CHANGED" | "NOTHING_TO_APPLY",
    message: string
  ) {
    super(message);
    this.name = "SpSupplierLinkRepairRefusal";
  }
}

type LinkRow = {
  container_id: number;
  container_number: string | null;
  container_supplier: number | null;
  voucher_id: number;
  voucher_number: string;
  voucher_date: string;
  effective_date: string | null;
  voucher_supplier: number | null;
  optional: boolean;
  period_closed: boolean;
  entry_id: number | null;
  ledger_account_id: number | null;
  debit: string | null;
  credit: string | null;
  entry_supplier: number | null;
};

async function loadLinkRows(executor: DatabaseOrTransaction, companyId: number, lock: boolean): Promise<LinkRow[]> {
  const result = await executor.execute<LinkRow & Record<string, unknown>>(sql`
    SELECT c.id AS container_id, c.container_number, c.supplier_id AS container_supplier,
           v.id AS voucher_id, v.voucher_number, v.voucher_date::text AS voucher_date,
           v.effective_date::text AS effective_date, v.supplier_id AS voucher_supplier,
           COALESCE(v.optional, false) AS optional,
           COALESCE((
             SELECT max(fc.period_end_date) FROM fiscal_period_closures fc
              WHERE fc.company_id = v.company_id AND fc.status = 'CLOSED'
           ) >= LEAST(v.voucher_date, COALESCE(v.effective_date, v.voucher_date)), false) AS period_closed,
           ve.id AS entry_id, ve.ledger_account_id, ve.debit_amount::text AS debit,
           ve.credit_amount::text AS credit, ve.supplier_id AS entry_supplier
      FROM sp_containers c
      JOIN vouchers v ON v.id = c.goods_otw_voucher_id AND v.company_id = c.company_id AND v.deleted_at IS NULL
      LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
       AND ve.supplier_id IS DISTINCT FROM c.supplier_id
       AND EXISTS (SELECT 1 FROM ledger_accounts la
                    WHERE la.id = ve.ledger_account_id AND la.company_id = c.company_id
                      AND la.sub_type = 'sp_otw_clearing')
     WHERE c.company_id = ${companyId}
       AND c.goods_otw_voucher_id IS NOT NULL
       AND (v.supplier_id IS DISTINCT FROM c.supplier_id OR ve.id IS NOT NULL)
     ORDER BY v.id, ve.id
     ${lock ? sql`FOR UPDATE OF v` : sql``}
  `);
  return result.rows as unknown as LinkRow[];
}

async function deriveSpSupplierLinkPlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  lock: boolean
): Promise<SpSupplierLinkRepairPlan> {
  const byVoucher = new Map<number, SpSupplierLinkRepairVoucher>();
  for (const row of await loadLinkRows(executor, companyId, lock)) {
    let voucher = byVoucher.get(row.voucher_id);
    if (!voucher) {
      voucher = {
        containerId: row.container_id,
        containerNumber: row.container_number,
        voucherId: row.voucher_id,
        voucherNumber: row.voucher_number,
        voucherDate: row.voucher_date,
        effectiveDate: row.effective_date,
        optional: row.optional,
        periodClosed: row.period_closed,
        header:
          row.voucher_supplier === row.container_supplier
            ? null
            : { from: row.voucher_supplier, to: row.container_supplier },
        lines: [],
      };
      byVoucher.set(row.voucher_id, voucher);
    }
    if (row.entry_id !== null && row.ledger_account_id !== null) {
      voucher.lines.push({
        entryId: row.entry_id,
        ledgerAccountId: row.ledger_account_id,
        debit: row.debit ?? "0",
        credit: row.credit ?? "0",
        from: row.entry_supplier,
        to: row.container_supplier,
      });
    }
  }
  const vouchers = [...byVoucher.values()];
  const planHash = createHash("sha256")
    .update(
      JSON.stringify(
        vouchers.map((voucher) => [voucher.voucherId, voucher.periodClosed, voucher.header, voucher.lines])
      )
    )
    .digest("hex");
  return {
    companyId,
    vouchers,
    closedPeriodVoucherIds: vouchers.filter((voucher) => voucher.periodClosed).map((voucher) => voucher.voucherId),
    planHash,
  };
}

/** Read-only: the Goods-OTW vouchers whose supplier differs from their container's, as the repair would change them. */
export function planSpSupplierVoucherLinkRepair(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<SpSupplierLinkRepairPlan> {
  return deriveSpSupplierLinkPlan(executor, companyId, false);
}

/**
 * Applies the plan for one company in one transaction (company scope asserted,
 * advisory lock): the plan is derived again under row locks and, when
 * `planHash` is given, applied only when it is the reviewed one. Vouchers in a
 * closed period are left as they are. One audit row in the transaction lists
 * every header and line before and after. Returns the plan that was applied.
 */
export async function applySpSupplierVoucherLinkRepair(
  companyId: number,
  options: { planHash?: string; actor: { userId: string | number; username: string } }
): Promise<SpSupplierLinkRepairPlan & { appliedVoucherIds: number[] }> {
  return db.transaction(async (tx) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sp-supplier-voucher-link-repair-v2'), ${companyId})`);
    const plan = await deriveSpSupplierLinkPlan(tx, companyId, true);
    if (options.planHash !== undefined && options.planHash !== plan.planHash) {
      throw new SpSupplierLinkRepairRefusal(
        "PLAN_CHANGED",
        "The supplier link repair plan changed since it was reviewed; review it again before applying"
      );
    }
    const applied = plan.vouchers.filter((voucher) => !voucher.periodClosed);
    for (const voucher of applied) {
      if (voucher.header) {
        await tx.execute(
          sql`UPDATE vouchers SET supplier_id = ${voucher.header.to} WHERE id = ${voucher.voucherId} AND company_id = ${companyId}`
        );
      }
      for (const line of voucher.lines) {
        await tx.execute(
          sql`UPDATE voucher_entries SET supplier_id = ${line.to} WHERE id = ${line.entryId} AND voucher_id = ${voucher.voucherId}`
        );
      }
    }
    if (applied.length > 0) {
      await writeAuditEvent(
        {
          userId: options.actor.userId,
          username: options.actor.username,
          companyId,
          action: "update",
          tableName: "vouchers",
          recordIdentifier: "sp-supplier-voucher-link-repair",
          changes: {
            lines: {
              old: applied.map((voucher) => ({
                voucherId: voucher.voucherId,
                voucherNumber: voucher.voucherNumber,
                headerSupplierId: voucher.header?.from,
                lines: voucher.lines.map((line) => ({ entryId: line.entryId, supplierId: line.from })),
              })),
              new: applied.map((voucher) => ({
                voucherId: voucher.voucherId,
                headerSupplierId: voucher.header?.to,
                lines: voucher.lines.map((line) => ({
                  entryId: line.entryId,
                  supplierId: line.to,
                  debit: line.debit,
                  credit: line.credit,
                })),
              })),
            },
          },
          metadata: { planHash: plan.planHash, skippedClosedPeriodVoucherIds: plan.closedPeriodVoucherIds },
        },
        tx
      );
    }
    return { ...plan, appliedVoucherIds: applied.map((voucher) => voucher.voucherId) };
  });
}

/**
 * The SP migration finalize's link repair for the target company: the audited
 * apply without a reviewed hash (the finalize verifies the result). Returns
 * how many vouchers were changed.
 */
export async function repairSpSupplierVoucherLinks(
  companyId: number,
  actor: { userId: string | number; username: string }
): Promise<number> {
  const result = await applySpSupplierVoucherLinkRepair(companyId, { actor });
  return result.appliedVoucherIds.length;
}

/** Counts SP Goods-OTW supplier links that differ from their container. */
export async function getSpSupplierVoucherLinkGapCount(companyId: number): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM sp_containers c
       JOIN vouchers v ON v.id = c.goods_otw_voucher_id AND v.company_id = c.company_id
      WHERE c.company_id = $1
        AND c.goods_otw_voucher_id IS NOT NULL
        AND (
          v.supplier_id IS DISTINCT FROM c.supplier_id
          OR EXISTS (
            SELECT 1
              FROM voucher_entries ve
              JOIN ledger_accounts la ON la.id = ve.ledger_account_id
             WHERE ve.voucher_id = v.id
               AND la.company_id = c.company_id
               AND la.sub_type = 'sp_otw_clearing'
               AND ve.supplier_id IS DISTINCT FROM c.supplier_id
          )
        )`,
    [companyId]
  );

  return Number(result.rows[0]?.count ?? 0);
}
