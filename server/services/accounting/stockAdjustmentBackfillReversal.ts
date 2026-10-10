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

import type Decimal from "decimal.js";

import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { postBalancedVoucherTx } from "./centralPostingEngine";
import { companyBusinessDate } from "./companyBusinessDate";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import {
  STOCK_ADJUSTMENT_BACKFILL_NARRATION_PATTERN,
  stockAdjustmentBackfillReversalNumber,
} from "./perpetualInventory/stockAdjustments";
import { systemAccountIdsTx } from "./perpetualInventory/linkedJournal";
import { diagnoseSystemAccounts } from "./systemAccounts";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";

const postingDependencies = createDatabasePostingDependencies();

export const BACKFILL_REVERSAL_SOURCE_TYPE = "stock-adjustment-backfill-reversal";
export const BACKFILL_REVERSAL_OFFSET_CODES = ["OPENING_BALANCE_EQUITY", "INVENTORY_ADJUSTMENT"] as const;
export type BackfillReversalOffsetCode = (typeof BACKFILL_REVERSAL_OFFSET_CODES)[number];
/** The shortest reason accepted for reversing a company that is not a supplier partner. */
export const BACKFILL_REVERSAL_MIN_REASON = 10;

export const BACKFILL_REVERSAL_MESSAGES = {
  NOT_SUPPLIER_PARTNER:
    "This company is not a supplier partner: the opening inventory journal absorbs its backfill lines. Reverse them only with an explicit request and a reason.",
  REASON_REQUIRED: "A reason of at least 10 characters is required to reverse the backfill of this company.",
  OFFSET_ACCOUNT_UNAVAILABLE: "The contra account of the reversal is deleted; restore it before applying.",
  PERIOD_CLOSED: "The reversal date is in a closed fiscal period.",
  NOTHING_TO_APPLY: "There is no backfill line left to reverse.",
  PLAN_CHANGED: "The backfill reversal changed since it was reviewed; review it again before applying.",
} as const;

export type BackfillReversalBlocker = Exclude<keyof typeof BACKFILL_REVERSAL_MESSAGES, "PLAN_CHANGED">;

export class BackfillReversalRefusal extends Error {
  constructor(readonly code: keyof typeof BACKFILL_REVERSAL_MESSAGES) {
    super(BACKFILL_REVERSAL_MESSAGES[code]);
    this.name = "BackfillReversalRefusal";
  }
  get status(): number {
    return this.code === "NOTHING_TO_APPLY" || this.code === "REASON_REQUIRED" ? 400 : 409;
  }
}

export interface BackfillReversalOptions {
  offset?: BackfillReversalOffsetCode;
  allowNonSupplierPartner?: boolean;
  reason?: string | null;
}

type Side = { debit: string; credit: string };

export interface BackfillReversalPlan {
  companyId: number;
  supplierPartner: boolean;
  override: { allowNonSupplierPartner: boolean; reason: string | null };
  voucherDate: string;
  offsetAccount: { code: BackfillReversalOffsetCode; id: number | null; action: "use" | "create" };
  vouchers: {
    voucherId: number;
    voucherNumber: string;
    voucherType: string;
    voucherDate: string;
    reversalVoucherNumber: string;
    backfillLines: ({ entryId: number } & Side)[];
    /** The reversing journal: each backfill line swapped, then the contra for their net. */
    journal: {
      account: "INVENTORY" | BackfillReversalOffsetCode;
      /** The ledger account (null: the contra account the apply creates). */
      ledgerAccountId: number | null;
      /** The backfill line it reverses (null: the contra line). */
      entryId: number | null;
      debit: string;
      credit: string;
    }[];
  }[];
  alreadyReversed: { voucherId: number; voucherNumber: string; reversalVoucherId: number; lines: number }[];
  skipped: { voucherId: number; voucherNumber: string; reason: "NON_USD_VOUCHER" }[];
  total: { vouchers: number; lines: number; inventoryDebit: string; inventoryCredit: string };
  blockers: BackfillReversalBlocker[];
  planHash: string;
}

type LineRow = {
  entry_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  inventory_account_id: number;
  debit: string;
  credit: string;
  is_foreign: boolean;
  reversal_id: number | null;
} & Record<string, unknown>;

const ZERO = new MoneyDecimal(0);
const money = (value: Decimal) => value.toFixed(2);

function normalizeOptions(options: BackfillReversalOptions) {
  const offset: BackfillReversalOffsetCode = options.offset ?? "OPENING_BALANCE_EQUITY";
  if (!BACKFILL_REVERSAL_OFFSET_CODES.includes(offset)) throw new Error("Unknown reversal contra account");
  const allowNonSupplierPartner = options.allowNonSupplierPartner === true;
  const reason = typeof options.reason === "string" && options.reason.trim() ? options.reason.trim() : null;
  return { offset, allowNonSupplierPartner, reason };
}

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  options: BackfillReversalOptions
): Promise<BackfillReversalPlan> {
  const { offset, allowNonSupplierPartner, reason } = normalizeOptions(options);
  const company = await executor.execute<{ company_type: string | null } & Record<string, unknown>>(
    sql`SELECT company_type FROM companies WHERE id = ${companyId}`
  );
  const supplierPartner = company.rows[0]?.company_type === "supplier_partner";

  const offsetStatus = (await diagnoseSystemAccounts(executor, companyId)).find((status) => status.code === offset);
  const offsetDeleted = offsetStatus?.state === "deleted";
  const offsetAccount: BackfillReversalPlan["offsetAccount"] =
    offsetStatus && offsetStatus.state !== "missing" && offsetStatus.state !== "deleted"
      ? { code: offset, id: offsetStatus.accountId, action: "use" }
      : { code: offset, id: null, action: "create" };

  const voucherDate = await companyBusinessDate(companyId, executor);
  const closed = await executor.execute<{ closed: boolean } & Record<string, unknown>>(sql`
    SELECT COALESCE(MAX(period_end_date) >= ${voucherDate}::date, false) AS closed
      FROM fiscal_period_closures WHERE company_id = ${companyId} AND status = 'CLOSED'`);
  const periodClosed = Boolean(closed.rows[0]?.closed);

  const lines = await executor.execute<LineRow>(sql`
    SELECT ve.id AS entry_id, v.id AS voucher_id, v.voucher_number, v.voucher_type,
           v.voucher_date::text AS voucher_date, la.id AS inventory_account_id,
           COALESCE(ve.debit_amount, 0)::text AS debit, COALESCE(ve.credit_amount, 0)::text AS credit,
           (upper(COALESCE(NULLIF(btrim(v.currency), ''), 'USD')) <> 'USD'
             OR upper(COALESCE(ve.transaction_currency, 'USD')) <> 'USD') AS is_foreign,
           (SELECT r.id FROM vouchers r
             WHERE r.company_id = v.company_id
               AND r.voucher_number = 'STOCKADJ-BACKFILL-REV-' || v.id::text
               AND r.deleted_at IS NULL AND COALESCE(r.optional, false) = false
             ORDER BY r.id LIMIT 1) AS reversal_id
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id
     WHERE v.company_id = ${companyId}
       AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
       AND la.code = 'INVENTORY'
       AND ve.narration LIKE ${STOCK_ADJUSTMENT_BACKFILL_NARRATION_PATTERN}
       AND EXISTS (SELECT 1 FROM stock_adjustment_vouchers sav WHERE sav.voucher_id = v.id)
     ORDER BY v.id, ve.id`);

  const byVoucher = new Map<number, LineRow[]>();
  for (const row of lines.rows) {
    const group = byVoucher.get(row.voucher_id) ?? [];
    group.push(row);
    byVoucher.set(row.voucher_id, group);
  }

  const vouchers: BackfillReversalPlan["vouchers"] = [];
  const alreadyReversed: BackfillReversalPlan["alreadyReversed"] = [];
  const skipped: BackfillReversalPlan["skipped"] = [];
  let inventoryDebit = ZERO;
  let inventoryCredit = ZERO;
  let lineCount = 0;
  for (const [voucherId, group] of byVoucher) {
    const head = group[0];
    if (head.reversal_id !== null) {
      alreadyReversed.push({
        voucherId,
        voucherNumber: head.voucher_number,
        reversalVoucherId: Number(head.reversal_id),
        lines: group.length,
      });
      continue;
    }
    if (group.some((row) => row.is_foreign)) {
      skipped.push({ voucherId, voucherNumber: head.voucher_number, reason: "NON_USD_VOUCHER" });
      continue;
    }
    const journal: BackfillReversalPlan["vouchers"][number]["journal"] = [];
    let net = ZERO;
    for (const row of group) {
      // The reversal swaps the backfill line's sides.
      const debit = toMoney(row.credit).toDecimalPlaces(2);
      const credit = toMoney(row.debit).toDecimalPlaces(2);
      journal.push({
        account: "INVENTORY",
        ledgerAccountId: row.inventory_account_id,
        entryId: row.entry_id,
        debit: money(debit),
        credit: money(credit),
      });
      inventoryDebit = inventoryDebit.plus(debit);
      inventoryCredit = inventoryCredit.plus(credit);
      net = net.plus(debit).minus(credit);
    }
    if (!net.isZero()) {
      journal.push({
        account: offset,
        ledgerAccountId: offsetAccount.id,
        entryId: null,
        debit: money(net.isNegative() ? net.negated() : ZERO),
        credit: money(net.isPositive() ? net : ZERO),
      });
    }
    lineCount += group.length;
    vouchers.push({
      voucherId,
      voucherNumber: head.voucher_number,
      voucherType: head.voucher_type,
      voucherDate: head.voucher_date,
      reversalVoucherNumber: stockAdjustmentBackfillReversalNumber(voucherId),
      backfillLines: group.map((row) => ({
        entryId: row.entry_id,
        debit: money(toMoney(row.debit)),
        credit: money(toMoney(row.credit)),
      })),
      journal,
    });
  }

  const blockers: BackfillReversalBlocker[] = [];
  if (!supplierPartner && !allowNonSupplierPartner) blockers.push("NOT_SUPPLIER_PARTNER");
  if (!supplierPartner && allowNonSupplierPartner && (reason?.length ?? 0) < BACKFILL_REVERSAL_MIN_REASON) {
    blockers.push("REASON_REQUIRED");
  }
  if (offsetDeleted) blockers.push("OFFSET_ACCOUNT_UNAVAILABLE");
  if (vouchers.length > 0 && periodClosed) blockers.push("PERIOD_CLOSED");
  if (vouchers.length === 0) blockers.push("NOTHING_TO_APPLY");

  const body = {
    companyId,
    supplierPartner,
    override: { allowNonSupplierPartner, reason },
    voucherDate,
    offsetAccount,
    vouchers,
    alreadyReversed,
    skipped,
    total: {
      vouchers: vouchers.length,
      lines: lineCount,
      inventoryDebit: money(inventoryDebit),
      inventoryCredit: money(inventoryCredit),
    },
    blockers,
  };
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
