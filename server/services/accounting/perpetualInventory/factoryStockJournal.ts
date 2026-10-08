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
 *      Cr the container's expense accounts   the raw material received since
 *                                     the previous journal (factory container
 *                                     receipts, USD value), spread over what
 *                                     the container's FACTORY- vouchers
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
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction, DbTransaction } from "../../../db";
import { db } from "../../../db";
import { logger } from "../../../lib/logger";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
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
  skipped?: "not-active" | "supplier-partner" | "nothing-to-post";
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

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Credits for the raw material received in (after, through]: per container,
 * the receipt value spread over the expense accounts its FACTORY- vouchers
 * debited (Factory Import Cost when they debited none).
 */
async function receiptCreditsTx(
  tx: DbTransaction,
  companyId: number,
  after: string,
  through: string
): Promise<LinkedJournalLine[]> {
  const receipts = await rows<{ container_id: number; value: string }>(
    tx,
    sql`
      SELECT container_id, COALESCE(SUM(receipt_value_usd), 0)::text AS value
        FROM factory_container_receipts
       WHERE company_id = ${companyId} AND deleted_at IS NULL
         AND receipt_date > ${after}::date AND receipt_date <= ${through}::date
       GROUP BY container_id
       ORDER BY container_id
    `
  );
  const credits = new Map<number, Decimal>();
  let importCostAccountId: number | null = null;
  for (const receipt of receipts) {
    const value = toMoney(receipt.value).toDecimalPlaces(2);
    if (!value.gt(0)) continue;
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
      credits.set(importCostAccountId, (credits.get(importCostAccountId) ?? new MoneyDecimal(0)).plus(value));
      continue;
    }
    // Spread by share; the last account takes the rounding remainder.
    let allocated: Decimal = new MoneyDecimal(0);
    expensed.forEach((row, index) => {
      const share =
        index === expensed.length - 1
          ? value.minus(allocated)
          : value.times(toMoney(row.amount)).dividedBy(total).toDecimalPlaces(2);
      allocated = allocated.plus(share);
      credits.set(row.ledger_account_id, (credits.get(row.ledger_account_id) ?? new MoneyDecimal(0)).plus(share));
    });
  }
  const zero = new MoneyDecimal(0);
  return [...credits.entries()].map(([ledgerAccountId, amount]) => ({
    ledgerAccountId,
    debit: zero,
    credit: amount,
    narration: "Raw material received, capitalised from its expensed cost",
  }));
}

/** Posts (replacing today's earlier one) the factory stock journal of a company. */
export async function syncFactoryStockJournalTx(
  tx: DbTransaction,
  companyId: number,
  date: string = todayUtc()
): Promise<FactoryStockJournalResult> {
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

  const [previous] = await rows<{ date: string | null }>(
    tx,
    sql`
      SELECT MAX(voucher_date)::text AS date FROM vouchers
       WHERE company_id = ${companyId} AND voucher_number LIKE ${`GL-FACTORY-STOCK-${companyId}-%`}
         AND voucher_date < ${date}::date AND deleted_at IS NULL
    `
  );
  const cutover = await getInventoryCutover(tx, companyId);
  const after = previous?.date ?? dayBefore(cutover!.effectiveFrom);
  const receiptLines = await receiptCreditsTx(tx, companyId, after, date);
  const received = receiptLines.reduce((sum, line) => sum.plus(line.credit), new MoneyDecimal(0));

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

/** The evening run: today's journal for every company whose cut-over is applied. */
export async function runFactoryStockJournals(date: string = todayUtc()): Promise<FactoryStockJournalResult[]> {
  const companies = await rows<{ company_id: number }>(
    db,
    sql`SELECT company_id FROM gl_inventory_cutovers WHERE effective_from <= ${date}::date ORDER BY company_id`
  );
  const results: FactoryStockJournalResult[] = [];
  for (const { company_id } of companies) {
    try {
      results.push(await db.transaction((tx) => syncFactoryStockJournalTx(tx, company_id, date)));
    } catch (error: unknown) {
      logger.error("Factory stock journal failed", { module: "perpetual-inventory", companyId: company_id, error });
    }
  }
  return results;
}
