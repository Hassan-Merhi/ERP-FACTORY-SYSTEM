/**
 * The daily factory stock journal (wave 8.4).
 *
 * The factory chain (raw material → mixes → bales) changes through some sixty
 * writers, several outside a transaction, and through cost recalculations that
 * rewrite raw, mix and bale costs together. Rather than a journal per writer,
 * the owner chose one derived journal per company per day,
 * GL-FACTORY-STOCK-{company}-{date}, that moves the three factory stock
 * accounts to the value the factory costing holds (factoryStockValuation, the
 * valuation the opening journal uses):
 *
 *   Dr/Cr Factory Raw Material Stock  value now less what the ledger holds
 *   Dr/Cr Factory Work in Progress    value now less what the ledger holds
 *   Dr/Cr Factory Finished Goods      value now less what the ledger holds
 *                                     (invoices and factory POS sales already
 *                                     credited it with the bales they sold)
 *      Cr Factory Goods in Transit   a receipt of a container the opening
 *                                     carried in transit, up to that amount
 *      Cr the container's expense accounts   the rest of the raw material
 *                                     received and not yet credited (factory
 *                                     container receipts, USD value; back-dated,
 *                                     edited and deleted receipts on the day
 *                                     of the change, wave 17 B), spread over
 *                                     what the container's FACTORY- vouchers
 *                                     expensed, or Factory Import Cost
 *      Dr/Cr Factory Waste and Write-off       the value changes writers tagged
 *      Dr/Cr Factory Stock Revaluation         by source since the previous
 *      Dr/Cr Factory Material Price Variance   journal (wave 11,
 *                                     services/factory/factoryStockValueEvents.ts):
 *                                     waste and removals, cost cascades and
 *                                     container cost recalculations, a mix's
 *                                     supplier rate against the landed cost
 *      Dr/Cr Production Variance      whatever is left: pressing and mixing
 *                                     yields and anything no writer tagged
 *
 * The valuation is the factory's state now, so the journal is posted for today
 * only, replaced whole when it is run again the same day, and never recomputed
 * for a past day. The scheduler runs it every evening for each company whose
 * cut-over is applied; Admins can run it on demand.
 *
 * Phase 28 (F9), the dated factory value ledger:
 *   - "today" is the company's business date (its timezone), not the UTC day;
 *   - every journal run records what the costing held, per stock account, in
 *     factory_stock_valuation_snapshots (one row per company and day, replaced
 *     with the journal), so the reconciliation of a past day compares the
 *     ledger with the costing of that day's journal instead of today's;
 *   - catch-up (catchUpFactoryStockJournalsTx, run by the evening runner before
 *     today's journal and on demand): a business day after the last journal
 *     with no journal of its own (a missed evening run) is posted, dated that
 *     day, when nothing in the factory changed after it ended (bales, mixes,
 *     adjustments, receipts and value events carry no later timestamp), so the
 *     costing now is that day's costing; later unchanged days get the same
 *     snapshot with no journal. A missed day after which the factory changed
 *     cannot be valued any more: it is reported (`notRecoverable`) and the
 *     next journal carries its movement, as before.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction, DbTransaction } from "../../../db";
import { db } from "../../../db";
import { isClosedPeriodError } from "../../../lib/closedPeriodError";
import { logger } from "../../../lib/logger";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { companyBusinessDate } from "../companyBusinessDate";
import { companyClosedThrough, isDateInClosedPeriod, runInCompanyPostingScope } from "../scheduledPostingScope";
import { isPerpetualInventoryActive } from "./cutover";
import { factoryStockValuation } from "./factoryValuation";
import {
  claimFactoryStockEventsTx,
  FACTORY_STOCK_EVENT_ACCOUNT,
  FACTORY_STOCK_EVENT_KINDS,
} from "../../factory/factoryStockValueEvents";
import {
  isSupplierPartnerCompany,
  ledgerBalancesByCode,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
  type LinkedJournalLine,
} from "./linkedJournal";

export const factoryStockJournalNumber = (companyId: number, date: string) => `GL-FACTORY-STOCK-${companyId}-${date}`;

const STOCK_ACCOUNTS = [
  { code: "FACTORY_RAW_MATERIAL_STOCK", valuation: "raw" },
  { code: "FACTORY_WIP", valuation: "wip" },
  { code: "FACTORY_FINISHED_GOODS", valuation: "finished" },
] as const;

const EXPLAINED_NARRATION: Record<string, string> = {
  FACTORY_WASTE_WRITE_OFF: "Factory stock written off: waste, removed and deleted bales",
  FACTORY_REVALUATION: "Factory stock revalued: container cost recalculations and cost cascades",
  FACTORY_MATERIAL_PRICE_VARIANCE: "Material price variance: mixes at the supplier rate against the landed cost",
};

export interface FactoryStockJournalResult {
  companyId: number;
  date: string;
  voucherId: number | null;
  /** Why nothing was posted, when nothing was. */
  skipped?: "not-active" | "supplier-partner" | "nothing-to-post" | "period-closed";
  /** The company's closed-books date, when the run was skipped as period-closed. */
  closedThrough?: string | null;
  accounts: Array<{ accountCode: string; target: string; ledgerBalance: string; amount: string }>;
  received: string;
  /** What is left for Production Variance, once the tagged changes have their own lines. */
  variance: string;
  /** The tagged value changes posted to their own accounts (debit positive), by account code. */
  explained: Record<string, string>;
  unvalued: number;
}

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Phase 28 (F9): records what the costing held for the journal of `date`. */
async function recordValuationSnapshotTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    date: string;
    raw: Decimal;
    wip: Decimal;
    finished: Decimal;
    unvalued: number;
    voucherId: number | null;
    basis: "journal" | "catch-up" | "catch-up-unchanged";
  }
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO factory_stock_valuation_snapshots
      (company_id, valuation_date, raw, wip, finished, unvalued, voucher_id, basis, recorded_at)
    VALUES (${params.companyId}, ${params.date}::date, ${params.raw.toFixed(2)}, ${params.wip.toFixed(2)},
            ${params.finished.toFixed(2)}, ${params.unvalued}, ${params.voucherId}, ${params.basis}, now())
    ON CONFLICT (company_id, valuation_date) DO UPDATE
      SET raw = EXCLUDED.raw, wip = EXCLUDED.wip, finished = EXCLUDED.finished, unvalued = EXCLUDED.unvalued,
          voucher_id = EXCLUDED.voucher_id, basis = EXCLUDED.basis, recorded_at = now()
  `);
}

/** Phase 28 (F9): the factory valuation a past day's journal recorded, or null. */
export async function factoryValuationSnapshotOn(
  executor: DatabaseOrTransaction,
  companyId: number,
  date: string
): Promise<{ raw: Decimal; wip: Decimal; finished: Decimal; basis: string } | null> {
  const [row] = await rows<{ raw: string; wip: string; finished: string; basis: string }>(
    executor,
    sql`SELECT raw::text AS raw, wip::text AS wip, finished::text AS finished, basis
          FROM factory_stock_valuation_snapshots WHERE company_id = ${companyId} AND valuation_date = ${date}::date`
  );
  return row
    ? { raw: toMoney(row.raw), wip: toMoney(row.wip), finished: toMoney(row.finished), basis: row.basis }
    : null;
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Whether anything the factory costing reads changed after the end of the
 * business day `date` (company timezone): bales and mixes updated, raw stock
 * created or deleted, adjustments, receipts and value events recorded.
 */
async function factoryChangedAfterTx(tx: DbTransaction, companyId: number, date: string): Promise<boolean> {
  const [row] = await rows<{ changed: boolean }>(
    tx,
    sql`
      WITH tz AS (
        SELECT COALESCE(NULLIF((SELECT timezone FROM company_settings WHERE company_id = ${companyId} LIMIT 1), ''),
                        'UTC') AS zone
      ),
      stamps AS (
        SELECT updated_at AS at FROM factory_bales WHERE company_id = ${companyId}
        UNION ALL SELECT updated_at FROM factory_mix_batches WHERE company_id = ${companyId}
        UNION ALL SELECT created_at FROM factory_raw_stock WHERE company_id = ${companyId}
        UNION ALL SELECT deleted_at FROM factory_raw_stock WHERE company_id = ${companyId} AND deleted_at IS NOT NULL
        UNION ALL SELECT created_at FROM factory_raw_material_adjustments WHERE company_id = ${companyId}
        UNION ALL SELECT deleted_at FROM factory_raw_material_adjustments
                   WHERE company_id = ${companyId} AND deleted_at IS NOT NULL
        UNION ALL SELECT created_at FROM factory_container_receipts WHERE company_id = ${companyId}
        UNION ALL SELECT deleted_at FROM factory_container_receipts
                   WHERE company_id = ${companyId} AND deleted_at IS NOT NULL
        UNION ALL SELECT created_at FROM factory_stock_value_events
                   WHERE company_id = ${companyId} AND kind <> ${FACTORY_RECEIPT_CREDIT_KIND}
      )
      SELECT EXISTS (
        SELECT 1 FROM stamps, tz WHERE (stamps.at AT TIME ZONE 'UTC' AT TIME ZONE tz.zone)::date > ${date}::date
      ) AS changed
    `
  );
  return Boolean(row?.changed);
}

export interface FactoryStockCatchUpResult {
  companyId: number;
  /** Missed business days whose journal was posted (dated that day), or given an unchanged snapshot. */
  posted: FactoryStockJournalResult[];
  unchangedDays: string[];
  /** Missed days that can no longer be valued: the next journal carries their movement. */
  notRecoverable: string[];
}

/**
 * Phase 28 (F9): posts the journals of missed business days before `today`
 * (see the module comment). Runs inside the caller's transaction (company
 * tenant scope).
 */
export async function catchUpFactoryStockJournalsTx(
  tx: DbTransaction,
  companyId: number,
  today: string
): Promise<FactoryStockCatchUpResult> {
  const result: FactoryStockCatchUpResult = { companyId, posted: [], unchangedDays: [], notRecoverable: [] };
  const [cut] = await rows<{ effective_from: string }>(
    tx,
    sql`SELECT effective_from::text AS effective_from FROM gl_inventory_cutovers WHERE company_id = ${companyId}`
  );
  if (!cut) return result;
  const [last] = await rows<{ last: string | null }>(
    tx,
    sql`SELECT GREATEST(
          (SELECT MAX(valuation_date) FROM factory_stock_valuation_snapshots WHERE company_id = ${companyId}),
          (SELECT MAX(voucher_date) FROM vouchers WHERE company_id = ${companyId} AND deleted_at IS NULL
              AND voucher_number LIKE ${`GL-FACTORY-STOCK-${companyId}-%`})
        )::text AS last`
  );
  const start = last?.last ? addDays(last.last, 1) : cut.effective_from;
  const missed: string[] = [];
  for (let day = start < cut.effective_from ? cut.effective_from : start; day < today; day = addDays(day, 1)) {
    missed.push(day);
    if (missed.length > 366) break;
  }
  if (missed.length === 0) return result;
  let firstUnchanged = -1;
  for (let index = 0; index < missed.length; index += 1) {
    if (!(await factoryChangedAfterTx(tx, companyId, missed[index]))) {
      firstUnchanged = index;
      break;
    }
  }
  if (firstUnchanged < 0) {
    result.notRecoverable = missed;
    return result;
  }
  result.notRecoverable = missed.slice(0, firstUnchanged);
  const [first, ...rest] = missed.slice(firstUnchanged);
  const journal = await syncFactoryStockJournalTx(tx, companyId, first, { basis: "catch-up" });
  result.posted.push(journal);
  const valuation = await factoryStockValuation(tx, companyId);
  for (const day of rest) {
    await recordValuationSnapshotTx(tx, {
      companyId,
      date: day,
      raw: valuation.raw,
      wip: valuation.wip,
      finished: valuation.finished,
      unvalued: valuation.unvalued.length,
      voucherId: null,
      basis: "catch-up-unchanged",
    });
    result.unchangedDays.push(day);
  }
  return result;
}

/** What the daily journals credited for a container's receipts (wave 17 B evidence rows). */
export const FACTORY_RECEIPT_CREDIT_KIND = "RECEIPT";
const FACTORY_RECEIPT_CREDIT_SOURCE = "factory-receipt-credit";

/** The containers the applied opening plan carried as factory goods in transit, with the amount. */
export async function openingFactoryGoodsInTransitTx(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<Map<number, Decimal>> {
  const [row] = await rows<{ carried: unknown }>(
    executor,
    sql`SELECT opening_plan -> 'factoryGoodsInTransit' AS carried FROM gl_inventory_cutovers
         WHERE company_id = ${companyId}`
  );
  const carried = new Map<number, Decimal>();
  if (!row || !Array.isArray(row.carried)) return carried;
  for (const entry of row.carried as Array<{ containerId: number; amount: string }>) {
    carried.set(Number(entry.containerId), toMoney(entry.amount));
  }
  return carried;
}

/** What the journals of days on or before `through` credited per container (debit negative). */
async function creditedReceiptsTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  through: string,
  inclusive: boolean
): Promise<Map<number, Decimal>> {
  const credited = await rows<{ container_id: string; amount: string }>(
    executor,
    sql`
      SELECT source_id AS container_id, SUM(amount)::text AS amount FROM factory_stock_value_events
       WHERE company_id = ${companyId} AND kind = ${FACTORY_RECEIPT_CREDIT_KIND}
         AND ${inclusive ? sql`journal_date <= ${through}::date` : sql`journal_date < ${through}::date`}
       GROUP BY source_id
    `
  );
  return new Map(credited.map((row) => [Number(row.container_id), toMoney(row.amount)]));
}

const clamp = (value: Decimal, max: Decimal): Decimal =>
  value.isNegative() ? new MoneyDecimal(0) : value.gt(max) ? max : value;

/**
 * What the ledger holds in Factory Goods in Transit for the containers the
 * opening carried, as of a date: the carried amounts less what the journals
 * up to that date cleared with their receipts (the reconciliation's expected
 * value).
 */
export async function factoryGoodsInTransitHeld(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOf: string
): Promise<Decimal> {
  const carried = await openingFactoryGoodsInTransitTx(executor, companyId);
  if (carried.size === 0) return new MoneyDecimal(0);
  const credited = await creditedReceiptsTx(executor, companyId, asOf, true);
  let held: Decimal = new MoneyDecimal(0);
  for (const [containerId, amount] of carried) {
    held = held.plus(amount.minus(clamp(credited.get(containerId) ?? new MoneyDecimal(0), amount)));
  }
  return held.toDecimalPlaces(2);
}

/**
 * Credits for the raw material received (wave 17 B, re-audit item 8):
 * per container, what its receipts are worth now to the books after the
 * cut-over less what earlier days' journals already credited for it, so a
 * receipt entered back-dated, edited or deleted after its day's journal is
 * credited (or reversed) in today's journal, on the change date; a past day's
 * journal is never touched. A receipt counts when it is live and dated on or
 * before `through`, and either dated on or after the cut-over or recorded
 * after the cut-over was applied (the opening valued the others as raw stock);
 * a receipt the opening valued that is deleted after the apply counts
 * negatively (its stock left the valuation). Before: receipts were credited
 * by receipt_date in (previous journal, today], so a back-dated receipt was
 * never credited and an edit or delete never reversed.
 *
 * The credit of a container the opening carried as factory goods in transit
 * goes to Factory Goods in Transit up to what the opening carried (wave 17 B,
 * item 5), the rest is spread over the expense accounts its FACTORY- vouchers
 * debited (Factory Import Cost when they debited none). Each container's
 * credit is recorded (factory_stock_value_events, kind RECEIPT, dated and
 * claimed by this journal; replaced when the journal is run again the same
 * day) as the evidence of what was credited.
 */
async function receiptCreditsTx(tx: DbTransaction, companyId: number, through: string): Promise<LinkedJournalLine[]> {
  await tx.execute(sql`
    DELETE FROM factory_stock_value_events
     WHERE company_id = ${companyId} AND kind = ${FACTORY_RECEIPT_CREDIT_KIND} AND journal_date = ${through}::date
  `);
  const receipts = await rows<{ container_id: number; value: string }>(
    tx,
    sql`
      SELECT r.container_id,
             COALESCE(SUM(CASE
               WHEN r.deleted_at IS NULL AND r.receipt_date <= ${through}::date
                    AND (r.receipt_date >= cut.effective_from OR r.created_at > cut.applied_at)
                 THEN r.receipt_value_usd
               WHEN r.deleted_at IS NOT NULL AND r.deleted_at > cut.applied_at
                    AND r.receipt_date < cut.effective_from AND r.created_at <= cut.applied_at
                 THEN -r.receipt_value_usd
               ELSE 0 END), 0)::text AS value
        FROM factory_container_receipts r
        JOIN gl_inventory_cutovers cut ON cut.company_id = r.company_id
       WHERE r.company_id = ${companyId}
       GROUP BY r.container_id
       ORDER BY r.container_id
    `
  );
  const credited = await creditedReceiptsTx(tx, companyId, through, false);
  const carried = await openingFactoryGoodsInTransitTx(tx, companyId);
  const credits = new Map<number, Decimal>();
  const add = (accountId: number, amount: Decimal) =>
    credits.set(accountId, (credits.get(accountId) ?? new MoneyDecimal(0)).plus(amount));
  let importCostAccountId: number | null = null;
  let transitAccountId: number | null = null;
  for (const receipt of receipts) {
    const before = credited.get(receipt.container_id) ?? new MoneyDecimal(0);
    const value = toMoney(receipt.value).toDecimalPlaces(2).minus(before);
    if (value.isZero()) continue;
    await tx.execute(sql`
      INSERT INTO factory_stock_value_events (company_id, event_date, kind, amount, source_type, source_id, journal_date)
      VALUES (${companyId}, ${through}::date, ${FACTORY_RECEIPT_CREDIT_KIND}, ${value.toFixed(2)},
              ${FACTORY_RECEIPT_CREDIT_SOURCE}, ${String(receipt.container_id)}, ${through}::date)
    `);
    // Factory goods in transit the opening carried for the container, used in receipt order.
    const carriedAmount = carried.get(receipt.container_id);
    const transit = carriedAmount
      ? clamp(before.plus(value), carriedAmount).minus(clamp(before, carriedAmount))
      : new MoneyDecimal(0);
    if (!transit.isZero()) {
      transitAccountId ??= (await systemAccountIdsTx(tx, companyId, ["FACTORY_GOODS_IN_TRANSIT"])).get(
        "FACTORY_GOODS_IN_TRANSIT"
      )!;
      add(transitAccountId, transit);
    }
    const rest = value.minus(transit);
    if (rest.isZero()) continue;
    const expensed = await rows<{ ledger_account_id: number; amount: string }>(
      tx,
      sql`
        SELECT ve.ledger_account_id, SUM(ve.debit_amount)::text AS amount
          FROM vouchers v
          JOIN voucher_entries ve ON ve.voucher_id = v.id
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = ${companyId}
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
           AND v.voucher_number ~ ${`^FACTORY-(IMPORT|COMM|FREIGHT|OC|POC)-${receipt.container_id}(-|$)`}
           AND ve.debit_amount > 0 AND la.account_type ILIKE '%expense%'
         GROUP BY ve.ledger_account_id
         ORDER BY ve.ledger_account_id
      `
    );
    const total = expensed.reduce((sum, row) => sum.plus(toMoney(row.amount)), new MoneyDecimal(0));
    if (!total.gt(0)) {
      importCostAccountId ??= (await systemAccountIdsTx(tx, companyId, ["FACTORY_IMPORT_COST"])).get(
        "FACTORY_IMPORT_COST"
      )!;
      add(importCostAccountId, rest);
      continue;
    }
    // Spread by share; the last account takes the rounding remainder.
    let allocated: Decimal = new MoneyDecimal(0);
    expensed.forEach((row, index) => {
      const share =
        index === expensed.length - 1
          ? rest.minus(allocated)
          : rest.times(toMoney(row.amount)).dividedBy(total).toDecimalPlaces(2);
      allocated = allocated.plus(share);
      add(row.ledger_account_id, share);
    });
  }
  const zero = new MoneyDecimal(0);
  return [...credits.entries()]
    .filter(([, amount]) => !amount.isZero())
    .map(([ledgerAccountId, amount]) => ({
      ledgerAccountId,
      debit: amount.isNegative() ? amount.negated() : zero,
      credit: amount.isNegative() ? zero : amount,
      narration:
        ledgerAccountId === transitAccountId
          ? "Factory goods in transit at the cut-over, received"
          : amount.isNegative()
            ? "Raw material receipt reversed: its capitalised cost back to expense"
            : "Raw material received, capitalised from its expensed cost",
    }));
}

/** Posts (replacing today's earlier one) the factory stock journal of a company. */
export async function syncFactoryStockJournalTx(
  tx: DbTransaction,
  companyId: number,
  requestedDate?: string,
  options: { basis?: "journal" | "catch-up" } = {}
): Promise<FactoryStockJournalResult> {
  // Phase 28 (F9): the company's business date by default (was the UTC day).
  const date = requestedDate ?? (await companyBusinessDate(companyId, tx));
  const empty = { accounts: [], received: "0.00", variance: "0.00", explained: {}, unvalued: 0 };
  // One run per company at a time.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gl_factory_stock_journal'), ${companyId})`);
  const number = factoryStockJournalNumber(companyId, date);
  await removeLinkedJournalTx(tx, companyId, number);
  if (!(await isPerpetualInventoryActive(tx, companyId, date))) {
    return { companyId, date, voucherId: null, skipped: "not-active", ...empty };
  }
  if (await isSupplierPartnerCompany(tx, companyId)) {
    return { companyId, date, voucherId: null, skipped: "supplier-partner", ...empty };
  }

  const valuation = await factoryStockValuation(tx, companyId);
  const held = await ledgerBalancesByCode(
    tx,
    companyId,
    STOCK_ACCOUNTS.map((account) => account.code),
    date
  );
  const accountIds = await systemAccountIdsTx(tx, companyId, [
    ...STOCK_ACCOUNTS.map((account) => account.code),
    "PRODUCTION_VARIANCE",
    ...FACTORY_STOCK_EVENT_KINDS.map((kind) => FACTORY_STOCK_EVENT_ACCOUNT[kind]),
  ]);
  const zero = new MoneyDecimal(0);
  const accounts = STOCK_ACCOUNTS.map((account) => {
    const target = valuation[account.valuation];
    const ledgerBalance = held.get(account.code) ?? zero;
    return { code: account.code, target, ledgerBalance, amount: target.minus(ledgerBalance).toDecimalPlaces(2) };
  });

  const receiptLines = await receiptCreditsTx(tx, companyId, date);
  const received = receiptLines.reduce((sum, line) => sum.plus(line.credit).minus(line.debit), new MoneyDecimal(0));

  // Debits less credits must be zero: the variance closes the journal. A
  // tagged change of the stock value (a write-off is negative) is the opposite
  // entry on its own account: a write-off of 100 debits Waste and Write-off 100.
  const moved = accounts.reduce((sum, account) => sum.plus(account.amount), new MoneyDecimal(0));
  const events = await claimFactoryStockEventsTx(tx, companyId, date);
  const explainedLines = FACTORY_STOCK_EVENT_KINDS.map((kind) => ({
    code: FACTORY_STOCK_EVENT_ACCOUNT[kind],
    amount: (events.get(kind) ?? zero).negated().toDecimalPlaces(2),
  }));
  const explained = explainedLines.reduce((sum, line) => sum.plus(line.amount), new MoneyDecimal(0));
  const variance = received.minus(moved).minus(explained);

  const lines: LinkedJournalLine[] = [
    ...accounts.map((account) => ({
      ledgerAccountId: accountIds.get(account.code)!,
      debit: account.amount.isPositive() ? account.amount : zero,
      credit: account.amount.isNegative() ? account.amount.negated() : zero,
      narration: "Factory stock at its costing value",
    })),
    ...receiptLines,
    ...explainedLines.map((line) => ({
      ledgerAccountId: accountIds.get(line.code)!,
      debit: line.amount.isPositive() ? line.amount : zero,
      credit: line.amount.isNegative() ? line.amount.negated() : zero,
      narration: EXPLAINED_NARRATION[line.code],
    })),
    {
      ledgerAccountId: accountIds.get("PRODUCTION_VARIANCE")!,
      debit: variance.isPositive() ? variance : zero,
      credit: variance.isNegative() ? variance.negated() : zero,
      narration: "Production variance: mixing and pressing differences not explained by a tagged change",
    },
  ];
  const voucherId = await postLinkedJournalTx(tx, {
    companyId,
    voucherNumber: number,
    voucherDate: date,
    description: ["Factory stock", date].join(" "),
    identity: { sourceType: "perpetual-factory-stock", sourceId: `${companyId}:${date}` },
    lines,
  });
  await recordValuationSnapshotTx(tx, {
    companyId,
    date,
    raw: valuation.raw,
    wip: valuation.wip,
    finished: valuation.finished,
    unvalued: valuation.unvalued.length,
    voucherId,
    basis: options.basis ?? "journal",
  });
  return {
    companyId,
    date,
    voucherId,
    ...(voucherId === null ? { skipped: "nothing-to-post" as const } : {}),
    accounts: accounts.map((account) => ({
      accountCode: account.code,
      target: account.target.toFixed(2),
      ledgerBalance: account.ledgerBalance.toFixed(2),
      amount: account.amount.toFixed(2),
    })),
    received: received.toFixed(2),
    variance: variance.toFixed(2),
    explained: Object.fromEntries(explainedLines.map((line) => [line.code, line.amount.toFixed(2)])),
    unvalued: valuation.unvalued.length,
  };
}

/**
 * The evening run: today's journal for every company whose cut-over is applied.
 * The companies are listed from the scheduler's scope; each company's journal
 * posts in that company's tenant scope (wave 18 A), so the closed-period guard
 * and the opening lock apply. A date in a closed period is skipped and
 * reported (`period-closed`), never forced.
 */
export async function runFactoryStockJournals(requestedDate?: string): Promise<FactoryStockJournalResult[]> {
  const companies = await rows<{ company_id: number }>(
    db,
    sql`SELECT company_id FROM gl_inventory_cutovers ORDER BY company_id`
  );
  const results: FactoryStockJournalResult[] = [];
  const periodClosed = (companyId: number, date: string, closedThrough: string | null): FactoryStockJournalResult => ({
    companyId,
    date,
    voucherId: null,
    skipped: "period-closed",
    closedThrough,
    accounts: [],
    received: "0.00",
    variance: "0.00",
    explained: {},
    unvalued: 0,
  });
  for (const { company_id } of companies) {
    // Phase 28 (F9): each company's own business date unless one is given.
    const date = requestedDate ?? (await companyBusinessDate(company_id));
    try {
      const result = await runInCompanyPostingScope(company_id, () =>
        db.transaction(async (tx) => {
          const closedThrough = await companyClosedThrough(company_id, tx);
          if (isDateInClosedPeriod(closedThrough, date)) return periodClosed(company_id, date, closedThrough);
          if (!(await isPerpetualInventoryActive(tx, company_id, date))) {
            return syncFactoryStockJournalTx(tx, company_id, date);
          }
          // Missed evening runs first (each dated its own day), then today.
          const catchUp = await catchUpFactoryStockJournalsTx(tx, company_id, date);
          if (catchUp.notRecoverable.length > 0) {
            logger.warn("Factory stock journal: missed days could not be valued; today's journal carries them", {
              module: "perpetual-inventory",
              companyId: company_id,
              days: catchUp.notRecoverable,
            });
          }
          return syncFactoryStockJournalTx(tx, company_id, date);
        })
      );
      if (result.skipped === "period-closed") {
        logger.warn("Factory stock journal skipped: date in a closed period", {
          module: "perpetual-inventory",
          companyId: company_id,
          date,
          closedThrough: result.closedThrough,
        });
      }
      results.push(result);
    } catch (error: unknown) {
      if (isClosedPeriodError(error)) {
        results.push(periodClosed(company_id, date, null));
        logger.warn("Factory stock journal skipped: the closed-period guard refused it", {
          module: "perpetual-inventory",
          companyId: company_id,
          date,
        });
        continue;
      }
      logger.error("Factory stock journal failed", { module: "perpetual-inventory", companyId: company_id, error });
    }
  }
  return results;
}
