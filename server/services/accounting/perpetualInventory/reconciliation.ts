/**
 * Perpetual-inventory reconciliation (wave 8.5, wave 11).
 *
 * Once a company's cut-over is applied, the ledger carries its stock. This
 * report compares, account by account, what the ledger holds as of a date with
 * what the stock sub-ledgers say it should hold:
 *
 *   Inventory                  the ERP stock sub-ledger: SUM(inventory.total_value)
 *                              over the company's non-deleted locations, bale
 *                              mirror left out (stockValuation.subLedgerTotal),
 *                              signed: the provisional value of negative stock
 *                              is included, because the short issue already
 *                              credited Inventory with it. As of a past date
 *                              the sub-ledger is replayed backwards from the
 *                              stored values (companyStockValuationAsOf).
 *   Goods in Transit           what the vouchers of POs dated on or before the
 *                              date, whose container was not offloaded by then,
 *                              debited to Purchases
 *   Factory Raw Material,      the factory costing (factoryStockValuation),
 *   WIP, Finished Goods        which the daily factory journal posts to. The
 *                              factory costing has no history, so a past date
 *                              compares the ledger then with the costing now:
 *                              the line's basis says so and `asOfBasis` is
 *                              "current" (not "as-of"), so a reader does not
 *                              take its difference for a ledger error.
 *   Factory Goods in Transit   what the opening carried for factory containers
 *                              not yet received, less what the daily factory
 *                              journals up to the date cleared with their
 *                              receipts (wave 17 B)
 *
 * Why the factory side is not replayed (wave 11 follow-up): the costing is
 * rewritten in place. Raw stock keeps only its current received/used kg
 * (deductions, mix edits and deletes change them with no dated movement),
 * container cost recalculations and the cost cascade overwrite raw, mix and
 * bale costs, and a bale's status changes (pressed, reserved, sold, written
 * off) carry no dated history. A past factory valuation would therefore be a
 * guess; the dated record of what the costing was is the daily
 * GL-FACTORY-STOCK journal itself.
 *
 * The ledger side books each voucher on its effective date when it has one
 * (ledgerBalancesByCode). The report lists factory invoices that carry no
 * ledger journal. It is read-only: a difference is shown, never posted.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  companyStockValuation,
  companyStockValuationAsOf,
  type CompanyStockValuation,
} from "../../inventory/stockValuation";
import { getInventoryCutover } from "./cutover";
import { listUnpostedFactoryInvoices, type UnpostedFactoryInvoice } from "./factoryInvoice";
import { factoryGoodsInTransitHeld } from "./factoryStockJournal";
import { factoryStockValuation } from "./factoryValuation";
import { isSupplierPartnerCompany, ledgerBalancesByCode } from "./linkedJournal";
import { retailInventoryReconciliationTx } from "../../retail/retailInventoryJournal";

export interface ReconciliationLine {
  accountCode: string;
  ledger: string;
  subLedger: string;
  difference: string;
  basis: string;
  /**
   * "as-of": the sub-ledger side is valued as of the report date; "current":
   * it is today's value (the factory costing on a past date, see above).
   */
  asOfBasis: "as-of" | "current";
}

export interface PerpetualInventoryReconciliation {
  companyId: number;
  asOf: string;
  cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
  supplierPartner: boolean;
  lines: ReconciliationLine[];
  unpostedFactoryInvoices: UnpostedFactoryInvoice[];
  /** True when every line agrees to the cent and no invoice is unposted. */
  reconciled: boolean;
}

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

/** The ERP stock sub-ledger as of a date: live for today or later, else replayed. */
async function erpStockSubLedger(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOf: string,
  today: string
): Promise<CompanyStockValuation> {
  return asOf >= today
    ? companyStockValuation(executor, companyId)
    : companyStockValuationAsOf(executor, companyId, asOf);
}

function inventoryBasis(valuation: CompanyStockValuation): string {
  const parts = [`ERP stock sub-ledger (total_value): stock in hand ${valuation.total}`];
  if (!toMoney(valuation.excluded.shortageValue).isZero()) {
    parts.push(`provisional value of negative stock ${valuation.excluded.shortageValue}`);
  }
  const anomalies = toMoney(valuation.excluded.shortRowValue).plus(toMoney(valuation.excluded.negativeValue));
  if (!anomalies.isZero()) parts.push(`values on rows outside the policy ${anomalies.toFixed(2)}`);
  return parts.join("; ");
}

async function goodsInTransitAsOf(executor: DatabaseOrTransaction, companyId: number, asOf: string): Promise<Decimal> {
  const [row] = await rows<{ purchases: string }>(
    executor,
    sql`
      SELECT COALESCE(SUM(ve.debit_amount), 0)::text AS purchases
        FROM purchase_orders po
        JOIN containers c ON c.id = po.container_id AND c.company_id = po.company_id
        JOIN vouchers v ON v.id = po.voucher_id AND v.company_id = po.company_id AND v.deleted_at IS NULL
                       AND COALESCE(v.optional, false) = false
                       AND COALESCE(v.effective_date, v.voucher_date) <= ${asOf}
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.code = 'PURCHASES'
       WHERE po.company_id = ${companyId} AND (c.offload_date IS NULL OR c.offload_date > ${asOf})
    `
  );
  return toMoney(row?.purchases ?? 0).toDecimalPlaces(2);
}

export async function reconcilePerpetualInventory(
  executor: DatabaseOrTransaction,
  companyId: number,
  asOf: string = new Date().toISOString().slice(0, 10)
): Promise<PerpetualInventoryReconciliation> {
  const cutover = await getInventoryCutover(executor, companyId);
  const supplierPartner = await isSupplierPartnerCompany(executor, companyId);
  const today = new Date().toISOString().slice(0, 10);
  const factory = await factoryStockValuation(executor, companyId);
  const factoryHistorical = asOf < today;
  const factoryBasis = factoryHistorical
    ? `factory costing today, not as of ${asOf} (the factory costing keeps no history; the difference includes every factory movement since)`
    : "factory costing";
  const erpStock = supplierPartner ? null : await erpStockSubLedger(executor, companyId, asOf, today);
  const expected: Array<{ accountCode: string; value: Decimal; basis: string; current?: boolean }> = [
    ...(erpStock === null
      ? []
      : [
          {
            accountCode: "INVENTORY",
            value: toMoney(erpStock.subLedgerTotal),
            basis: inventoryBasis(erpStock),
          },
          {
            accountCode: "GOODS_IN_TRANSIT",
            value: await goodsInTransitAsOf(executor, companyId, asOf),
            basis: "purchase cost of POs not yet offloaded",
          },
        ]),
    {
      accountCode: "FACTORY_RAW_MATERIAL_STOCK",
      value: factory.raw,
      basis: `${factoryBasis}: raw material`,
      current: factoryHistorical,
    },
    {
      accountCode: "FACTORY_WIP",
      value: factory.wip,
      basis: `${factoryBasis}: work in progress`,
      current: factoryHistorical,
    },
    {
      accountCode: "FACTORY_FINISHED_GOODS",
      value: factory.finished,
      basis: `${factoryBasis}: finished goods`,
      current: factoryHistorical,
    },
    {
      accountCode: "FACTORY_GOODS_IN_TRANSIT",
      value: await factoryGoodsInTransitHeld(executor, companyId, asOf),
      basis: "expensed cost of factory containers not received at the cut-over, less their receipts since",
    },
  ];
  const ledger = await ledgerBalancesByCode(
    executor,
    companyId,
    expected.map((line) => line.accountCode),
    asOf
  );
  const lines = expected.map((line) => {
    const held = ledger.get(line.accountCode) ?? new MoneyDecimal(0);
    return {
      accountCode: line.accountCode,
      ledger: held.toFixed(2),
      subLedger: line.value.toFixed(2),
      difference: held.minus(line.value).toFixed(2),
      basis: line.basis,
      asOfBasis: line.current ? ("current" as const) : ("as-of" as const),
    };
  });
  // Wave 17 (D): RETAIL-INVENTORY against the Retail stock sub-ledger (today's value; it keeps no history).
  const retail = await retailInventoryReconciliationTx(executor, companyId, asOf);
  if (retail.applicable) {
    lines.push({
      accountCode: "RETAIL-INVENTORY",
      ledger: retail.ledger,
      subLedger: retail.subLedger,
      difference: retail.difference,
      basis: `Retail stock sub-ledger (quantity × average cost)${retail.opening ? "" : "; the Retail inventory opening is not applied"}`,
      asOfBasis: asOf < today ? "current" : "as-of",
    });
  }
  const unpostedFactoryInvoices = await listUnpostedFactoryInvoices(executor, companyId);
  return {
    companyId,
    asOf,
    cutover: cutover ? { effectiveFrom: cutover.effectiveFrom, openingVoucherId: cutover.openingVoucherId } : null,
    supplierPartner,
    lines,
    unpostedFactoryInvoices,
    reconciled: lines.every((line) => toMoney(line.difference).isZero()) && unpostedFactoryInvoices.length === 0,
  };
}
