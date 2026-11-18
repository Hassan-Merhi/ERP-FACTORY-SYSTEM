// Extracted from ./openingJournal.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { type DatabaseOrTransaction, db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { companyStockValuationAsOf } from "../../inventory/stockValuation";
import { ledgerBalancesByCode } from "./linkedJournal";
import { factoryStockValuation, type UnvaluedRow } from "./factoryValuation";
import { DEFAULT_PERPETUAL_INVENTORY_FROM, getInventoryCutover, PERPETUAL_INVENTORY_POSTING_READY } from "./cutover";

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
  /**
   * The ERP stock behind the INVENTORY target, as of the eve (2dp text):
   * stock in hand (negative stock not subtracting), the provisional value of
   * negative stock, and values on rows outside the valuation policy. The
   * target is their sum, the signed sub-ledger. Null for a supplier partner.
   */
  erpStock: { stockInHand: string; shortageValue: string; otherValues: string; subLedgerTotal: string } | null;
  /** Supplier-partner company: ERP stock is carried in sp_stock and not capitalised here. */
  supplierPartner: boolean;
  /** The purchase orders the Goods in Transit line carries (dated before the cut-over, not offloaded by then). */
  goodsInTransitPurchaseOrderIds: number[];
  /** Factory containers the Factory Goods in Transit line carries, with the amount (wave 17 B). */
  factoryGoodsInTransit: Array<{ containerId: number; amount: string }>;
  alreadyApplied: boolean;
  postingReady: boolean;
}

export class OpeningJournalRefusal extends Error {
  constructor(
    readonly code:
      | "POSTING_NOT_READY"
      | "ALREADY_APPLIED"
      | "CUTOVER_IN_FUTURE"
      | "DOCUMENTS_ON_OR_AFTER_CUTOVER"
      | "READINESS_BLOCKERS"
      | "FACTORY_READINESS_BLOCKERS"
      | "INVALID_DATE",
    message: string
  ) {
    super(message);
    this.name = "OpeningJournalRefusal";
  }
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

/** The opening journal's debit side: the lines it debits, and equity when the lines net to a credit. */
export function openingDebitTotal(plan: Pick<OpeningInventoryPlan, "lines" | "total">): Decimal {
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
  effectiveFrom: string = DEFAULT_PERPETUAL_INVENTORY_FROM,
  executor: DatabaseOrTransaction = db
): Promise<OpeningInventoryPlan> {
  if (!ISO_DATE.test(effectiveFrom)) throw new OpeningJournalRefusal("INVALID_DATE", "Invalid date");
  const journalDate = dayBefore(effectiveFrom);
  // Supplier-partner companies carry their stock in their own sp_stock
  // accounts already; their ERP stock is not capitalised a second time.
  const company = await rows<{ company_type: string | null }>(
    executor,
    sql`SELECT company_type FROM companies WHERE id = ${companyId}`
  );
  const supplierPartner = company[0]?.company_type === "supplier_partner";
  // The signed ERP sub-ledger as of the eve (the policy is stockValuation's:
  // every non-deleted location, active or not, bale mirror left out).
  const valuation = supplierPartner ? null : await companyStockValuationAsOf(executor, companyId, journalDate);
  const erpStock = toMoney(valuation?.subLedgerTotal ?? 0);
  const erpStockDetail = valuation && {
    stockInHand: valuation.total,
    shortageValue: valuation.excluded.shortageValue,
    otherValues: toMoney(valuation.excluded.shortRowValue).plus(valuation.excluded.negativeValue).toFixed(2),
    subLedgerTotal: valuation.subLedgerTotal,
  };

  const factory = await factoryStockValuation(executor, companyId);
  const { unvalued } = factory;
  const rawValue = factory.raw;
  const wipValue = factory.wip;
  const finishedValue = factory.finished;

  // Goods in transit on the eve: what Purchases absorbed for POs dated before
  // the cut-over whose container had not been offloaded by then. Their stock
  // arrives after the cut-over, and STOCK-IN credits goods in transit for them.
  const transit = supplierPartner
    ? []
    : await rows<{ purchases: string; purchase_order_ids: number[] | null }>(
        executor,
        sql`
        SELECT COALESCE(SUM(ve.debit_amount), 0)::text AS purchases,
               array_agg(DISTINCT po.id ORDER BY po.id) AS purchase_order_ids
          FROM purchase_orders po
          JOIN containers c ON c.id = po.container_id AND c.company_id = po.company_id
          JOIN vouchers v ON v.id = po.voucher_id AND v.company_id = po.company_id AND v.deleted_at IS NULL
                             AND COALESCE(v.optional, false) = false
          JOIN voucher_entries ve ON ve.voucher_id = v.id
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.code = 'PURCHASES'
         WHERE po.company_id = ${companyId} AND v.voucher_date < ${effectiveFrom}
           AND (c.offload_date IS NULL OR c.offload_date >= ${effectiveFrom})
      `
      );
  const goodsInTransit = toMoney(transit[0]?.purchases ?? 0).toDecimalPlaces(2);
  const goodsInTransitPurchaseOrderIds = (transit[0]?.purchase_order_ids ?? []).map(Number);
  const factoryGoodsInTransit = await factoryGoodsInTransitAtEve(executor, companyId, effectiveFrom);
  const factoryTransitTotal = factoryGoodsInTransit.reduce((sum, row) => sum.plus(row.amount), new MoneyDecimal(0));

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
          {
            accountCode: "INVENTORY",
            target: erpStock.toDecimalPlaces(2),
            basis: `ERP stock sub-ledger (total_value) as of ${journalDate}`,
          },
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
    {
      accountCode: "FACTORY_GOODS_IN_TRANSIT",
      target: factoryTransitTotal.toDecimalPlaces(2),
      basis: "expensed cost of factory containers not yet received",
    },
  ];

  // What the ledger already holds on these accounts as of the eve: their
  // opening balances and every active posting (credit and debit notes, for
  // one, have always posted to Inventory). The journal posts only the
  // difference, so nothing already in the ledger is counted twice.
  const ledgerBalance = await ledgerBalancesByCode(
    executor,
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
    erpStock: erpStockDetail,
    supplierPartner,
    goodsInTransitPurchaseOrderIds,
    factoryGoodsInTransit: factoryGoodsInTransit.map((row) => ({
      containerId: row.containerId,
      amount: row.amount.toFixed(2),
    })),
    alreadyApplied: (await getInventoryCutover(executor, companyId)) !== null,
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
  };
}

/**
 * Factory goods in transit on the eve (see the module comment): per factory
 * container not fully received, what its FACTORY- vouchers dated before the
 * cut-over debited to expense less the USD value of its receipts dated before
 * it, when positive.
 */
export async function factoryGoodsInTransitAtEve(
  executor: DatabaseOrTransaction,
  companyId: number,
  effectiveFrom: string
): Promise<Array<{ containerId: number; amount: Decimal }>> {
  const found = await rows<{ container_id: number; expensed: string; received: string }>(
    executor,
    sql`
      WITH expensed AS (
        SELECT substring(v.voucher_number FROM '^FACTORY-(?:IMPORT|COMM|FREIGHT|OC|POC)-([0-9]+)(?:-|$)')::int
                 AS container_id,
               SUM(ve.debit_amount) AS amount
          FROM vouchers v
          JOIN voucher_entries ve ON ve.voucher_id = v.id AND ve.debit_amount > 0
          JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = ${companyId}
                                 AND la.account_type ILIKE '%expense%'
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
           AND COALESCE(v.effective_date, v.voucher_date) < ${effectiveFrom}::date
           AND v.voucher_number ~ '^FACTORY-(IMPORT|COMM|FREIGHT|OC|POC)-[0-9]+(-|$)'
         GROUP BY 1
      )
      SELECT e.container_id, e.amount::text AS expensed,
             COALESCE((SELECT SUM(r.receipt_value_usd) FROM factory_container_receipts r
                        WHERE r.company_id = ${companyId} AND r.container_id = e.container_id
                          AND r.deleted_at IS NULL AND r.receipt_date < ${effectiveFrom}::date), 0)::text AS received
        FROM expensed e
        JOIN factory_containers fc ON fc.id = e.container_id AND fc.company_id = ${companyId}
       WHERE fc.deleted_at IS NULL AND COALESCE(fc.status, '') <> 'OFFLOADED'
       ORDER BY e.container_id
    `
  );
  return found
    .map((row) => ({
      containerId: Number(row.container_id),
      amount: toMoney(row.expensed).minus(toMoney(row.received)).toDecimalPlaces(2),
    }))
    .filter((row) => row.amount.gt(0));
}
