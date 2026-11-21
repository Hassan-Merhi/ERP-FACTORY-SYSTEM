/**
 * Reversal of main's stock adjustment boot backfill, as a reviewed Owner tool
 * (accounting audit phase 20, production item B2).
 *
 * main's 2bf7351 balanced every old one-sided stock adjustment voucher at boot
 * by mirroring each adjustment line onto the canonical INVENTORY account,
 * debit and credit swapped, narrated "Inventory side (backfill) - …"
 * (STOCK_ADJUSTMENT_BACKFILL_NARRATION_PREFIX), with no review and no audit.
 * In an ERP company the opening inventory journal absorbs those lines at the
 * cut-over. A supplier-partner company keeps its stock in sp_stock and its
 * INVENTORY account should carry nothing, so there the lines are reversed:
 *
 * - planStockAdjustmentBackfillReversal (read-only): every live backfill line
 *   of the company still to reverse, grouped by its voucher, with the
 *   reversing journal each voucher gets, the vouchers already reversed, the
 *   vouchers skipped (not USD), blockers and a sha256 plan hash;
 * - applyStockAdjustmentBackfillReversal: current company only, one
 *   transaction (company scope, advisory lock, the original vouchers locked
 *   FOR UPDATE as edits lock them), the plan derived again and applied only
 *   when its hash is the reviewed one (PLAN_CHANGED). Each voucher gets ONE
 *   reversing journal `STOCKADJ-BACKFILL-REV-{voucherId}` through the central
 *   posting engine (balanced, closed-period guarded, posting identity
 *   `stock-adjustment-backfill-reversal:{company}:{voucher}`), dated on the
 *   company's business date. The original lines are never edited or deleted.
 *   One audit row holds every reversed line and every journal, in the same
 *   transaction.
 * - Idempotent: a voucher with a live reversal journal is listed as already
 *   reversed and never reversed twice; a re-apply finds nothing to reverse
 *   (NOTHING_TO_APPLY). syncStockAdjustmentInventoryTx keeps the backfill
 *   lines of a reversed voucher (they are neutralised by the reversal), so an
 *   edit cannot leave the reversal alone on INVENTORY.
 *
 * Decided by default (owner can override):
 * - The reversing journal's contra is OPENING_BALANCE_EQUITY. Under periodic
 *   inventory the contra of a one-sided stock adjustment is the stock
 *   sub-ledger, outside the ledger; the backfill moved it onto INVENTORY. A
 *   balanced reversal must land it on a ledger account; the equity side the
 *   opening inventory journal also uses keeps the adjustment's profit and loss
 *   exactly as it was before the backfill. `offset=INVENTORY_ADJUSTMENT` is the
 *   alternative (the difference then reaches profit and loss).
 * - Supplier-partner companies only. Another company is refused
 *   (NOT_SUPPLIER_PARTNER: the opening plan absorbs its lines) unless the
 *   request sets `allowNonSupplierPartner` with a written reason, which the
 *   plan, its hash and the audit row carry.
 * - Vouchers whose backfill lines are not all USD are skipped (NON_USD_VOUCHER)
 *   and left for a reviewed manual entry.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { writeAuditEvent } from "../audit";
import { postBalancedVoucherTx } from "./centralPostingEngine";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import { systemAccountIdsTx } from "./perpetualInventory/linkedJournal";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import {
  derivePlanPart1,
  BACKFILL_REVERSAL_MESSAGES,
  ZERO,
  money,
  type BackfillReversalOptions,
  type BackfillReversalPlan,
} from "./derivePlanPart1";
export {
  BACKFILL_REVERSAL_OFFSET_CODES,
  BACKFILL_REVERSAL_MIN_REASON,
  BACKFILL_REVERSAL_MESSAGES,
  type BackfillReversalOffsetCode,
  type BackfillReversalBlocker,
  type BackfillReversalOptions,
  type BackfillReversalPlan,
} from "./derivePlanPart1";

const postingDependencies = createDatabasePostingDependencies();

export const BACKFILL_REVERSAL_SOURCE_TYPE = "stock-adjustment-backfill-reversal";

export class BackfillReversalRefusal extends Error {
  constructor(readonly code: keyof typeof BACKFILL_REVERSAL_MESSAGES) {
    super(BACKFILL_REVERSAL_MESSAGES[code]);
    this.name = "BackfillReversalRefusal";
  }
  get status(): number {
    return this.code === "NOTHING_TO_APPLY" || this.code === "REASON_REQUIRED" ? 400 : 409;
  }
}

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  options: BackfillReversalOptions
): Promise<BackfillReversalPlan> {
  const { body } = await derivePlanPart1(executor, companyId, options);
  return { ...body, planHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

/** Read-only plan for the company. */
export function planStockAdjustmentBackfillReversal(
  companyId: number,
  options: BackfillReversalOptions = {},
  executor: DatabaseOrTransaction = db
): Promise<BackfillReversalPlan> {
  return derivePlan(executor, companyId, options);
}

/** Applies the reviewed plan for the company in one transaction, audited in it. */
export function applyStockAdjustmentBackfillReversal(
  companyId: number,
  options: BackfillReversalOptions & { planHash: string; actor: { userId: string; username: string } }
): Promise<BackfillReversalPlan & { reversals: { voucherId: number; reversalVoucherId: number }[] }> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BACKFILL_REVERSAL_SOURCE_TYPE}), ${companyId})`);
    // Lock what the plan names as an edit locks it, then derive it again under the locks.
    const first = await derivePlan(tx, companyId, options);
    const ids = first.vouchers.map((row) => row.voucherId);
    if (ids.length > 0) {
      await tx.execute(sql`
        SELECT id FROM vouchers
         WHERE company_id = ${companyId}
           AND id IN (${sql.join(
             ids.map((id) => sql`${id}`),
             sql`, `
           )})
         ORDER BY id FOR UPDATE`);
    }
    const plan = await derivePlan(tx, companyId, options);
    if (plan.planHash !== options.planHash) throw new BackfillReversalRefusal("PLAN_CHANGED");
    if (plan.blockers.length) throw new BackfillReversalRefusal(plan.blockers[0]);

    const accounts = await systemAccountIdsTx(tx, companyId, [plan.offsetAccount.code]);
    const offsetAccountId = accounts.get(plan.offsetAccount.code)!;
    const reversals: { voucherId: number; reversalVoucherId: number }[] = [];
    for (const voucher of plan.vouchers) {
      const narration = `Reversal of stock adjustment backfill - ${voucher.voucherNumber}`;
      const total = voucher.journal.reduce((sum, line) => sum.plus(line.debit), ZERO);
      const posted = await postBalancedVoucherTx(
        tx,
        {
          voucher: {
            companyId,
            voucherNumber: voucher.reversalVoucherNumber,
            voucherType: "Journal",
            voucherDate: plan.voucherDate,
            totalAmount: money(total),
            description: narration,
            currency: "USD",
            sourceModule: "ERP",
          },
          entries: voucher.journal.map((line) => ({
            ledgerAccountId: line.entryId === null ? offsetAccountId : line.ledgerAccountId,
            debitAmount: line.debit,
            creditAmount: line.credit,
            narration: line.entryId === null ? narration : `${narration} (line ${line.entryId})`,
          })),
          source: {
            sourceType: BACKFILL_REVERSAL_SOURCE_TYPE,
            sourceId: String(voucher.voucherId),
            idempotencyKey: `${BACKFILL_REVERSAL_SOURCE_TYPE}:${companyId}:${voucher.voucherId}`,
          },
          actor: {
            userId: options.actor.userId,
            username: options.actor.username,
            reason: plan.override.reason ?? "Stock adjustment backfill reversal",
          },
        },
        postingDependencies
      );
      reversals.push({ voucherId: voucher.voucherId, reversalVoucherId: Number(posted.voucher.id) });
    }

    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "create",
        tableName: "vouchers",
        recordId: null,
        recordIdentifier: "stock-adjustment-backfill-reversal",
        changes: {
          backfillLines: {
            old: plan.vouchers.map((v) => ({ voucherId: v.voucherId, lines: v.backfillLines, reversed: false })),
            new: plan.vouchers.map((v) => ({ voucherId: v.voucherId, lines: v.backfillLines, reversed: true })),
          },
          reversalJournals: {
            old: null,
            new: plan.vouchers.map((v) => ({
              ...reversals.find((r) => r.voucherId === v.voucherId),
              voucherNumber: v.reversalVoucherNumber,
              voucherDate: plan.voucherDate,
              journal: v.journal,
            })),
          },
          offsetAccount: { new: { ...plan.offsetAccount, id: offsetAccountId } },
          override: { new: plan.override },
          total: { new: plan.total },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, reversals };
  });
}
