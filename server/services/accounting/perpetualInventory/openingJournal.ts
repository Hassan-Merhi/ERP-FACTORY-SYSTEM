/**
 * Opening inventory journal for the perpetual-inventory cut-over (wave 8).
 *
 * Under the periodic method the stock on hand was never in the ledger: its cost
 * went to expense when it was bought. At the cut-over that stock is
 * capitalised once, dated the eve of the cut-over:
 *
 *   Dr Goods in Transit              purchase cost of POs not yet offloaded
 *   Dr Inventory                     ERP stock (sub-ledger value as of the eve)
 *   Dr Factory Raw Material Stock    remaining kg × landed USD cost per kg
 *   Dr Factory Work in Progress      open mix-batch kg × mix cost per kg,
 *                                    plus bales awaiting pressing
 *   Dr Factory Finished Goods        bales held, at their recorded cost
 *      Cr Opening Balance Equity     the total
 *
 * Each line posts the difference between that value and what the ledger
 * already holds on the account as of the eve (credit and debit notes have
 * always posted to Inventory), so nothing already in the ledger is counted
 * twice; a line whose ledger balance exceeds its value credits the account.
 * A supplier-partner company's Goods in Transit and Inventory are left alone.
 *
 * The plan is read-only. Rows that carry no cost are listed, never valued at a
 * guess. Applying requires an Owner, PERPETUAL_INVENTORY_POSTING_READY, and a
 * cut-over date that is today or earlier (the factory figures are current
 * values; the ERP figure is computed as of the eve). It posts the journal and
 * records the cut-over in one transaction, once per company.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { voucherEntries } from "@shared/schema";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { calculateHistoricalLocationInventory } from "../../../routes/helpers/inventoryHistoryHelpers";
import { infrastructurePostingIdentity, insertInfrastructureVoucherTx } from "../infrastructureVoucherIdentity";
import { ensureSystemAccounts } from "../systemAccounts";
import { ledgerBalancesByCode } from "./linkedJournal";
import { factoryBaleMirrorStockItemIds, factoryStockValuation, type UnvaluedRow } from "./factoryValuation";
import { DEFAULT_PERPETUAL_INVENTORY_FROM, PERPETUAL_INVENTORY_POSTING_READY, getInventoryCutover } from "./cutover";

export interface OpeningJournalLine {
  accountCode: string;
  /** What the account should hold at the cut-over. */
  target: string;
  /** What the ledger already holds on the account as of the eve (debit positive). */
  ledgerBalance: string;
  /** What the journal posts: target minus ledger balance (positive debits the account). */
  amount: string;
  basis: string;
}

export type { UnvaluedRow } from "./factoryValuation";

export interface OpeningInventoryPlan {
  companyId: number;
  effectiveFrom: string;
  /** The journal's date: the eve of the cut-over. */
  journalDate: string;
  lines: OpeningJournalLine[];
  total: string;
  unvalued: UnvaluedRow[];
  /** Bales already marked sold on orders that are not finalized: shipped but not yet invoiced. */
  soldNotInvoiced: { bales: number; cost: string };
  /** Supplier-partner company: ERP stock is carried in sp_stock and not capitalised here. */
  supplierPartner: boolean;
  alreadyApplied: boolean;
  postingReady: boolean;
}

export class OpeningJournalRefusal extends Error {
  constructor(
    readonly code: "POSTING_NOT_READY" | "ALREADY_APPLIED" | "CUTOVER_IN_FUTURE" | "INVALID_DATE",
    message: string
  ) {
    super(message);
    this.name = "OpeningJournalRefusal";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as unknown as T[];
}

/**
 * ERP stock in hand as of a date (as computeStockInHand values it), leaving out
 * the stock items that mirror factory bales: the factory values those bales.
 */
async function erpStockInHandExcludingBaleMirror(companyId: number, asOf: string): Promise<Decimal> {
  const mirror = await factoryBaleMirrorStockItemIds(db, companyId);
  const locations = await rows<{ id: number }>(sql`
    SELECT id FROM locations WHERE company_id = ${companyId} AND active = true AND deleted_at IS NULL
  `);
  let value: Decimal = new MoneyDecimal(0);
  for (const location of locations) {
    for (const item of await calculateHistoricalLocationInventory(location.id, companyId, asOf)) {
      if (mirror.has(item.stockItemId)) continue;
      value = value.plus(toMoney(item.quantity).times(toMoney(item.averageRate)));
    }
  }
  return value.toDecimalPlaces(2);
}

/** The opening journal's debit side: the lines it debits, and equity when the lines net to a credit. */
function openingDebitTotal(plan: Pick<OpeningInventoryPlan, "lines" | "total">): Decimal {
  const debits = plan.lines.reduce(
    (sum, line) => (toMoney(line.amount).isPositive() ? sum.plus(line.amount) : sum),
    new MoneyDecimal(0)
  );
  const net = toMoney(plan.total);
  return net.isNegative() ? debits.plus(net.negated()) : debits;
}

/** Read-only: the opening inventory journal for one company. */
export async function planOpeningInventoryJournal(
  companyId: number,
  effectiveFrom: string = DEFAULT_PERPETUAL_INVENTORY_FROM
): Promise<OpeningInventoryPlan> {
  if (!ISO_DATE.test(effectiveFrom)) throw new OpeningJournalRefusal("INVALID_DATE", "Invalid date");
  const journalDate = dayBefore(effectiveFrom);
  // Supplier-partner companies carry their stock in their own sp_stock
  // accounts already; their ERP stock is not capitalised a second time.
  const company = await rows<{ company_type: string | null }>(
    sql`SELECT company_type FROM companies WHERE id = ${companyId}`
  );
  const supplierPartner = company[0]?.company_type === "supplier_partner";
  const erpStock = supplierPartner
    ? new MoneyDecimal(0)
    : await erpStockInHandExcludingBaleMirror(companyId, journalDate);

  const factory = await factoryStockValuation(db, companyId);
  const { unvalued } = factory;
  const rawValue = factory.raw;
  const wipValue = factory.wip;
  const finishedValue = factory.finished;

  // Goods in transit on the eve: what Purchases absorbed for POs dated before
  // the cut-over whose container had not been offloaded by then. Their stock
  // arrives after the cut-over, and STOCK-IN credits goods in transit for them.
  const transit = supplierPartner
    ? []
    : await rows<{ purchases: string }>(sql`
        SELECT COALESCE(SUM(ve.debit_amount), 0)::text AS purchases
          FROM purchase_orders po
          JOIN containers c ON c.id = po.container_id AND c.company_id = po.company_id
          JOIN vouchers v ON v.id = po.voucher_id AND v.company_id = po.company_id AND v.deleted_at IS NULL
                             AND COALESCE(v.optional, false) = false
          JOIN voucher_entries ve ON ve.voucher_id = v.id
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.code = 'PURCHASES'
         WHERE po.company_id = ${companyId} AND v.voucher_date < ${effectiveFrom}
           AND (c.offload_date IS NULL OR c.offload_date >= ${effectiveFrom})
      `);
  const goodsInTransit = toMoney(transit[0]?.purchases ?? 0).toDecimalPlaces(2);

  const targets: Array<{ accountCode: string; target: Decimal; basis: string }> = [
    // A supplier-partner company's ERP inventory accounts are left as they are.
    ...(supplierPartner
      ? []
      : [
          {
            accountCode: "GOODS_IN_TRANSIT",
            target: goodsInTransit,
            basis: "purchase cost of POs not yet offloaded",
          },
          { accountCode: "INVENTORY", target: erpStock, basis: `ERP stock in hand as of ${journalDate}` },
        ]),
    {
      accountCode: "FACTORY_RAW_MATERIAL_STOCK",
      target: rawValue.toDecimalPlaces(2),
      basis: "remaining kg × landed USD cost per kg",
    },
    {
      accountCode: "FACTORY_WIP",
      target: wipValue.toDecimalPlaces(2),
      basis: "open mix-batch kg × mix cost per kg, and bales awaiting pressing",
    },
    {
      accountCode: "FACTORY_FINISHED_GOODS",
      target: finishedValue.toDecimalPlaces(2),
      basis: "bales held, at their recorded cost",
    },
  ];

  // What the ledger already holds on these accounts as of the eve: their
  // opening balances and every active posting (credit and debit notes, for
  // one, have always posted to Inventory). The journal posts only the
  // difference, so nothing already in the ledger is counted twice.
  const ledgerBalance = await ledgerBalancesByCode(
    db,
    companyId,
    targets.map((line) => line.accountCode),
    journalDate
  );
  const lines: OpeningJournalLine[] = targets
    .map((line) => {
      const balance = ledgerBalance.get(line.accountCode) ?? new MoneyDecimal(0);
      return {
        accountCode: line.accountCode,
        target: line.target.toFixed(2),
        ledgerBalance: balance.toFixed(2),
        amount: line.target.minus(balance).toFixed(2),
        basis: line.basis,
      };
    })
    .filter((line) => !toMoney(line.amount).isZero());
  const total = lines.reduce((sum, line) => sum.plus(line.amount), new MoneyDecimal(0));

  return {
    companyId,
    effectiveFrom,
    journalDate,
    lines,
    total: total.toFixed(2),
    unvalued,
    soldNotInvoiced: factory.soldNotInvoiced,
    supplierPartner,
    alreadyApplied: (await getInventoryCutover(db, companyId)) !== null,
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
  };
}

/**
 * Posts the opening journal and records the cut-over, in one transaction.
 * `postingReady` exists for tests; the route always passes the real flag.
 */
export async function applyOpeningInventoryJournal(
  companyId: number,
  effectiveFrom: string,
  appliedBy: string,
  options: { postingReady?: boolean; today?: string } = {}
): Promise<{ plan: OpeningInventoryPlan; voucherId: number | null }> {
  if (!(options.postingReady ?? PERPETUAL_INVENTORY_POSTING_READY)) {
    throw new OpeningJournalRefusal(
      "POSTING_NOT_READY",
      "Perpetual inventory posting is not complete yet; the cut-over cannot be applied"
    );
  }
  if (!ISO_DATE.test(effectiveFrom)) throw new OpeningJournalRefusal("INVALID_DATE", "Invalid date");
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (effectiveFrom > today) {
    throw new OpeningJournalRefusal("CUTOVER_IN_FUTURE", "The cut-over can be applied on or after its date");
  }

  const plan = await planOpeningInventoryJournal(companyId, effectiveFrom);
  if (plan.alreadyApplied) {
    throw new OpeningJournalRefusal("ALREADY_APPLIED", "The cut-over is already applied for this company");
  }

  const voucherId = await db.transaction(async (tx) => {
    // Serializes concurrent applies for the company; the primary key refuses a second row.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('gl_inventory_cutover'), ${companyId})`);
    if (await getInventoryCutover(tx, companyId)) {
      throw new OpeningJournalRefusal("ALREADY_APPLIED", "The cut-over is already applied for this company");
    }
    let id: number | null = null;
    if (plan.lines.length > 0) {
      const codes = [...plan.lines.map((line) => line.accountCode), "OPENING_BALANCE_EQUITY"];
      const statuses = await ensureSystemAccounts(tx, companyId, codes);
      const accountId = new Map<string, number>();
      for (const status of statuses) {
        if (status.state === "missing" || status.state === "deleted") {
          throw new Error("A required system account is not available");
        }
        accountId.set(status.code, status.accountId);
      }
      const { voucher } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId,
          voucherNumber: `GL-INVENTORY-OPENING-${companyId}`,
          voucherType: "Journal",
          voucherDate: plan.journalDate,
          description: ["Opening inventory at the perpetual-inventory cut-over", effectiveFrom].join(" "),
          totalAmount: openingDebitTotal(plan).toFixed(2),
          currency: "USD",
          exchangeRate: "1",
        },
        infrastructurePostingIdentity("perpetual-inventory-opening", companyId)
      );
      id = voucher.id;
      // A line whose ledger balance exceeds its target credits the account.
      const sides = (amount: string) => {
        const value = toMoney(amount);
        return value.isNegative()
          ? { debitAmount: "0.00", creditAmount: value.negated().toFixed(2) }
          : { debitAmount: value.toFixed(2), creditAmount: "0.00" };
      };
      const equity = toMoney(plan.total).negated().toFixed(2);
      await tx.insert(voucherEntries).values([
        ...plan.lines.map((line) => ({
          voucherId: id!,
          ledgerAccountId: accountId.get(line.accountCode)!,
          ...sides(line.amount),
          narration: line.basis,
        })),
        ...(toMoney(equity).isZero()
          ? []
          : [
              {
                voucherId: id,
                ledgerAccountId: accountId.get("OPENING_BALANCE_EQUITY")!,
                ...sides(equity),
                narration: "Stock on hand capitalised at the cut-over",
              },
            ]),
      ]);
    }
    await tx.execute(sql`
      INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_voucher_id, opening_plan, applied_by)
      VALUES (${companyId}, ${effectiveFrom}, ${id}, ${JSON.stringify(plan)}::jsonb, ${appliedBy})
    `);
    return id;
  });
  return { plan, voucherId };
}
