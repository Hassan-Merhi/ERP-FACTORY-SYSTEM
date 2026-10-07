/**
 * Perpetual-inventory reconciliation (wave 8.5).
 *
 * Once a company's cut-over is applied, the ledger carries its stock. This
 * report compares, account by account, what the ledger holds today with what
 * the stock sub-ledgers say it should hold:
 *
 *   Inventory                  ERP stock in hand (inventory rows of active
 *                              locations), leaving out the bale mirror
 *   Goods in Transit           what the vouchers of POs whose container is not
 *                              offloaded debited to Purchases
 *   Factory Raw Material,      the factory costing (factoryStockValuation),
 *   WIP, Finished Goods        which the daily factory journal posts to
 *
 * and lists factory invoices that carry no ledger journal. It is read-only: a
 * difference is shown, never posted.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getInventoryCutover } from "./cutover";
import { listUnpostedFactoryInvoices, type UnpostedFactoryInvoice } from "./factoryInvoice";
import { factoryBaleMirrorStockItemIds, factoryStockValuation } from "./factoryValuation";
import { isSupplierPartnerCompany, ledgerBalancesByCode } from "./linkedJournal";

export interface ReconciliationLine {
  accountCode: string;
  ledger: string;
  subLedger: string;
  difference: string;
  basis: string;
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

async function erpStockNow(executor: DatabaseOrTransaction, companyId: number): Promise<Decimal> {
  const mirror = await factoryBaleMirrorStockItemIds(executor, companyId);
  const stock = await rows<{ stock_item_id: number; value: string }>(
    executor,
    sql`
      SELECT i.stock_item_id, SUM(i.quantity * i.average_rate)::text AS value
        FROM inventory i JOIN locations l ON l.id = i.location_id
       WHERE l.company_id = ${companyId} AND l.active = true AND l.deleted_at IS NULL
       GROUP BY i.stock_item_id
    `
  );
  return stock
    .filter((row) => !mirror.has(row.stock_item_id))
    .reduce((sum, row) => sum.plus(toMoney(row.value)), new MoneyDecimal(0))
    .toDecimalPlaces(2);
}

async function goodsInTransitNow(executor: DatabaseOrTransaction, companyId: number): Promise<Decimal> {
  const [row] = await rows<{ purchases: string }>(
    executor,
    sql`
      SELECT COALESCE(SUM(ve.debit_amount), 0)::text AS purchases
        FROM purchase_orders po
        JOIN containers c ON c.id = po.container_id AND c.company_id = po.company_id
        JOIN vouchers v ON v.id = po.voucher_id AND v.company_id = po.company_id AND v.deleted_at IS NULL
                       AND COALESCE(v.optional, false) = false
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.code = 'PURCHASES'
       WHERE po.company_id = ${companyId} AND c.offload_date IS NULL
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
  const factory = await factoryStockValuation(executor, companyId);
  const expected: Array<{ accountCode: string; value: Decimal; basis: string }> = [
    ...(supplierPartner
      ? []
      : [
          { accountCode: "INVENTORY", value: await erpStockNow(executor, companyId), basis: "ERP stock in hand" },
          {
            accountCode: "GOODS_IN_TRANSIT",
            value: await goodsInTransitNow(executor, companyId),
            basis: "purchase cost of POs not yet offloaded",
          },
        ]),
    { accountCode: "FACTORY_RAW_MATERIAL_STOCK", value: factory.raw, basis: "factory costing: raw material" },
    { accountCode: "FACTORY_WIP", value: factory.wip, basis: "factory costing: work in progress" },
    { accountCode: "FACTORY_FINISHED_GOODS", value: factory.finished, basis: "factory costing: finished goods" },
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
    };
  });
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
