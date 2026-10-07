/**
 * ERP purchases under perpetual inventory (wave 8.2).
 *
 * The purchase documents keep posting as they always have: the PO voucher
 * debits Purchases when it is imported (the container is still on the way),
 * and the offload posts its charges (duties, transport, transfer, additional,
 * office) on their own vouchers while the stock sub-ledger receives the goods
 * at their landed value. Two linked journals carry that cost to the balance
 * sheet:
 *
 *   GIT-PO-{purchaseOrderId}, dated with the PO voucher:
 *     Dr Goods in Transit / Cr Purchases — what the PO voucher debited to
 *     Purchases.
 *
 *   STOCK-IN-{containerId}, dated with the offload:
 *     Dr Inventory          the value the stock sub-ledger received
 *                           (container_offload_items of active offloads)
 *     Cr Goods in Transit   the container's POs that are in transit: a PO with
 *                           a GIT-PO journal, or one dated before the cut-over
 *                           (the opening journal carried it as in transit)
 *     Cr each account an offload charge voucher debited, by that amount
 *     Cr/Dr Purchases       the difference, so a PO and its landed value that
 *                           do not agree stay visible in Purchases
 *
 * Both journals are derived from the current state of their documents and
 * replaced whole by syncPurchaseOrderGitTx / syncContainerStockInTx, which the
 * create, edit, offload and reverse paths call. Nothing is posted for a
 * supplier-partner company or a document dated before the company's cut-over.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
  type LinkedJournalLine,
} from "./linkedJournal";

export const purchaseOrderGitVoucherNumber = (purchaseOrderId: number) => `GIT-PO-${purchaseOrderId}`;
export const containerStockInVoucherNumber = (containerId: number) => `STOCK-IN-${containerId}`;

const zero = () => new MoneyDecimal(0);

async function rows<T>(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as unknown as T[];
}

interface PurchaseOrderCost {
  purchaseOrderId: number;
  voucherDate: string | null;
  /** What the PO voucher debited to Purchases. */
  purchases: Decimal;
}

/** What each of the given POs' vouchers debited to Purchases, and their dates. */
async function purchaseOrderCosts(
  tx: DbTransaction,
  companyId: number,
  where: ReturnType<typeof sql>
): Promise<PurchaseOrderCost[]> {
  const result = await rows<{ id: number; voucher_date: string | null; purchases: string }>(
    tx,
    sql`
      SELECT po.id, v.voucher_date::text AS voucher_date,
             COALESCE(SUM(ve.debit_amount) FILTER (WHERE la.code = 'PURCHASES'), 0)::text AS purchases
        FROM purchase_orders po
        LEFT JOIN vouchers v ON v.id = po.voucher_id AND v.company_id = po.company_id AND v.deleted_at IS NULL
                                AND COALESCE(v.optional, false) = false
        LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
        LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE po.company_id = ${companyId} AND ${where}
       GROUP BY po.id, v.voucher_date
    `
  );
  return result.map((row) => ({
    purchaseOrderId: row.id,
    voucherDate: row.voucher_date,
    purchases: toMoney(row.purchases),
  }));
}

/** Posts (replacing any earlier one) the goods-in-transit journal of a PO. */
export async function syncPurchaseOrderGitTx(
  tx: DbTransaction,
  companyId: number,
  purchaseOrderId: number
): Promise<number | null> {
  const number = purchaseOrderGitVoucherNumber(purchaseOrderId);
  await removeLinkedJournalTx(tx, companyId, number);
  const [cost] = await purchaseOrderCosts(tx, companyId, sql`po.id = ${purchaseOrderId}`);
  if (!cost?.voucherDate || !cost.purchases.gt(0)) return null;
  if (!(await isPerpetualInventoryActive(tx, companyId, cost.voucherDate))) return null;
  if (await isSupplierPartnerCompany(tx, companyId)) return null;

  const accounts = await systemAccountIdsTx(tx, companyId, ["GOODS_IN_TRANSIT", "PURCHASES"]);
  return postLinkedJournalTx(tx, {
    companyId,
    voucherNumber: number,
    voucherDate: cost.voucherDate,
    description: ["Goods in transit", number].join(" - "),
    identity: { sourceType: "perpetual-po-git", sourceId: purchaseOrderId },
    lines: [
      {
        ledgerAccountId: accounts.get("GOODS_IN_TRANSIT")!,
        debit: cost.purchases,
        credit: zero(),
        narration: "Purchased goods in transit",
      },
      {
        ledgerAccountId: accounts.get("PURCHASES")!,
        debit: zero(),
        credit: cost.purchases,
        narration: "Purchase cost carried to goods in transit",
      },
    ],
  });
}

/** Removes a PO's goods-in-transit journal (the PO was deleted). */
export async function removePurchaseOrderGitTx(
  tx: DbTransaction,
  companyId: number,
  purchaseOrderId: number
): Promise<void> {
  await removeLinkedJournalTx(tx, companyId, purchaseOrderGitVoucherNumber(purchaseOrderId));
}

/** Posts (replacing any earlier one) the stock-in journal of a container's offload. */
export async function syncContainerStockInTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<number | null> {
  const number = containerStockInVoucherNumber(containerId);
  await removeLinkedJournalTx(tx, companyId, number);

  const [container] = await rows<{ offload_date: string | null; location_id: number | null }>(
    tx,
    sql`
      SELECT COALESCE(c.offload_date::text, (
               SELECT max(co.offloaded_at)::date::text FROM container_offloads co WHERE co.container_id = c.id
             )) AS offload_date,
             (SELECT co.location_id FROM container_offloads co
               WHERE co.container_id = c.id ORDER BY co.id DESC LIMIT 1) AS location_id
        FROM containers c
       WHERE c.id = ${containerId} AND c.company_id = ${companyId}
    `
  );
  if (!container?.offload_date) return null;
  if (!(await isPerpetualInventoryActive(tx, companyId, container.offload_date))) return null;
  if (await isSupplierPartnerCompany(tx, companyId)) return null;

  const [received] = await rows<{ value: string }>(
    tx,
    sql`
      SELECT COALESCE(SUM(coi.total_value), 0)::text AS value
        FROM container_offload_items coi
        JOIN container_offloads co ON co.id = coi.offload_id
        JOIN containers c ON c.id = co.container_id
       WHERE co.container_id = ${containerId} AND c.company_id = ${companyId} AND co.optional = false
    `
  );
  const value = toMoney(received?.value ?? 0).toDecimalPlaces(2);
  if (!value.gt(0)) return null;

  // In transit: POs with their own GIT journal, and POs dated before the
  // cut-over, which the opening journal carried as goods in transit.
  const cutover = await getInventoryCutover(tx, companyId);
  const pos = await purchaseOrderCosts(tx, companyId, sql`po.container_id = ${containerId}`);
  let inTransit: Decimal = zero();
  for (const po of pos) {
    if (!po.voucherDate) continue;
    const carriedByOpening = cutover !== null && po.voucherDate < cutover.effectiveFrom;
    const [git] = await rows<{ id: number }>(
      tx,
      sql`SELECT id FROM vouchers WHERE company_id = ${companyId}
           AND voucher_number = ${purchaseOrderGitVoucherNumber(po.purchaseOrderId)}`
    );
    if (git || carriedByOpening) inTransit = inTransit.plus(po.purchases);
  }

  // Charges booked by the offload: whatever account each charge voucher debited.
  const charges = await rows<{ ledger_account_id: number; amount: string }>(
    tx,
    sql`
      SELECT ve.ledger_account_id, SUM(ve.debit_amount)::text AS amount
        FROM accounting_posting_requests apr
        JOIN vouchers v ON v.id = apr.voucher_id AND v.company_id = ${companyId} AND v.deleted_at IS NULL
                           AND COALESCE(v.optional, false) = false
        JOIN voucher_entries ve ON ve.voucher_id = v.id
       WHERE apr.company_id = ${companyId} AND apr.source_type = 'container-offload-charge'
         AND apr.source_id LIKE ${`${companyId}:${containerId}:%`}
         AND ve.debit_amount > 0 AND ve.ledger_account_id IS NOT NULL
       GROUP BY ve.ledger_account_id
    `
  );
  const chargeTotal = charges.reduce((sum, row) => sum.plus(toMoney(row.amount)), zero());
  const residual = value.minus(inTransit).minus(chargeTotal);

  const accounts = await systemAccountIdsTx(tx, companyId, ["GOODS_IN_TRANSIT", "PURCHASES"]);
  const { id: inventoryAccountId } = await getOrCreateInventoryControlAccount(tx, companyId);
  const lines: LinkedJournalLine[] = [
    { ledgerAccountId: inventoryAccountId, debit: value, credit: zero(), narration: "Stock received at landed cost" },
    {
      ledgerAccountId: accounts.get("GOODS_IN_TRANSIT")!,
      debit: zero(),
      credit: inTransit,
      narration: "Goods in transit received",
    },
    ...charges.map((row) => ({
      ledgerAccountId: row.ledger_account_id,
      debit: zero(),
      credit: toMoney(row.amount),
      narration: "Offload charge capitalised into stock",
    })),
    {
      ledgerAccountId: accounts.get("PURCHASES")!,
      debit: residual.isNegative() ? residual.negated() : zero(),
      credit: residual.isNegative() ? zero() : residual,
      narration: "Difference between purchase cost and landed stock value",
    },
  ];
  return postLinkedJournalTx(tx, {
    companyId,
    voucherNumber: number,
    voucherDate: container.offload_date,
    description: ["Stock received", number].join(" - "),
    identity: { sourceType: "perpetual-stock-in", sourceId: containerId },
    locationId: container.location_id,
    lines,
  });
}

/**
 * Re-syncs the goods-in-transit journal of every PO a voucher belongs to, and
 * the stock-in journal of their containers (it credits only the POs that are
 * in transit). Called when a voucher is deleted, restored or made optional.
 */
export async function syncPurchaseOrderGitForVoucherTx(
  tx: DbTransaction,
  companyId: number,
  voucherId: number
): Promise<void> {
  const linked = await rows<{ id: number; container_id: number | null }>(
    tx,
    sql`SELECT id, container_id FROM purchase_orders WHERE company_id = ${companyId} AND voucher_id = ${voucherId}`
  );
  const containerIds = new Set<number>();
  for (const po of linked) {
    await syncPurchaseOrderGitTx(tx, companyId, po.id);
    if (po.container_id !== null) containerIds.add(po.container_id);
  }
  for (const containerId of Array.from(containerIds)) {
    const [stockIn] = await rows<{ id: number }>(
      tx,
      sql`SELECT id FROM vouchers WHERE company_id = ${companyId}
           AND voucher_number = ${containerStockInVoucherNumber(containerId)}`
    );
    if (stockIn) await syncContainerStockInTx(tx, companyId, containerId);
  }
}
