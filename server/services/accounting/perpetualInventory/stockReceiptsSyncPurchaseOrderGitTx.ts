// Extracted from ./stockReceipts.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  type LinkedJournalLine,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
} from "./linkedJournal";

export const purchaseOrderGitVoucherNumber = (purchaseOrderId: number) => `GIT-PO-${purchaseOrderId}`;

/** The prefix of a container's stock-in journals, and the number of the legacy single journal. */
export const containerStockInVoucherNumber = (containerId: number) => `STOCK-IN-${containerId}`;

export const zero = () => new MoneyDecimal(0);

/** A literal for a POSIX regular expression. */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function rows<T>(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as unknown as T[];
}

interface PurchaseOrderCost {
  purchaseOrderId: number;
  voucherDate: string | null;
  /** What the PO voucher debited to Purchases. */
  purchases: Decimal;
}

/** What each of the given POs' vouchers debited to Purchases, and their dates. */
export async function purchaseOrderCosts(
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

/**
 * The stock-in journal number of one offload (wave 17 B): one journal per
 * offload, dated with that offload.
 */
export const offloadStockInVoucherNumber = (containerId: number, offloadId: number) =>
  `STOCK-IN-${containerId}-${offloadId}`;

/** A share of `total` (2dp): the whole of it once `through` reaches 1. */
function cumulativeShare(total: Decimal, through: Decimal): Decimal {
  return through.gte(1) ? total : total.times(through).toDecimalPlaces(2);
}

export interface OffloadRow {
  id: number;
  location_id: number | null;
  offload_date: string | null;
  total_bales: string;
}

interface ExistingStockIn {
  id: number;
  voucher_number: string;
  voucher_date: string;
  lines: string[];
}

export const lineKey = (ledgerAccountId: number, debit: Decimal, credit: Decimal) =>
  `${ledgerAccountId}:${debit.toFixed(2)}:${credit.toFixed(2)}`;

/** The live stock-in journals of a container (the per-offload ones and a legacy STOCK-IN-{container}). */
export async function existingStockInJournalsTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<ExistingStockIn[]> {
  const found = await rows<{ id: number; voucher_number: string; voucher_date: string; lines: string[] | null }>(
    tx,
    sql`
      SELECT v.id, v.voucher_number, v.voucher_date::text AS voucher_date,
             array_agg(ve.ledger_account_id::text || ':' || ROUND(ve.debit_amount, 2)::text || ':'
                       || ROUND(ve.credit_amount, 2)::text ORDER BY ve.id) FILTER (WHERE ve.id IS NOT NULL) AS lines
        FROM vouchers v
        LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
         AND (v.voucher_number = ${containerStockInVoucherNumber(containerId)}
              OR v.voucher_number LIKE ${`${containerStockInVoucherNumber(containerId)}-%`})
       GROUP BY v.id
    `
  );
  return found.map((row) => ({ ...row, lines: row.lines ?? [] }));
}

/** Removes every stock-in journal of a container (the container was deleted). */
export async function removeContainerStockInJournalsTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<void> {
  for (const journal of await existingStockInJournalsTx(tx, companyId, containerId)) {
    await removeLinkedJournalTx(tx, companyId, journal.voucher_number);
  }
}

/** The lines of each active offload's stock-in journal (see syncContainerStockInTx). */
export async function stockInLinesTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number,
  container: { container_number: string; offload_date: string | null },
  offloads: Array<{ offload: OffloadRow; date: string | null }>
): Promise<Array<{ offload: OffloadRow; date: string | null; lines: LinkedJournalLine[] }>> {
  const received = await rows<{ offload_id: number; value: string; inventory: string }>(
    tx,
    sql`
      SELECT coi.offload_id, COALESCE(SUM(coi.total_value), 0)::text AS value,
             COALESCE(SUM(COALESCE(coi.value_moved, coi.total_value)), 0)::text AS inventory
        FROM container_offload_items coi
        JOIN container_offloads co ON co.id = coi.offload_id
        JOIN containers c ON c.id = co.container_id
       WHERE co.container_id = ${containerId} AND c.company_id = ${companyId} AND co.optional = false
       GROUP BY coi.offload_id
    `
  );
  const receivedBy = new Map(received.map((row) => [Number(row.offload_id), row]));

  // In transit: POs with their own GIT journal, POs the opening journal
  // carried as goods in transit, and what a pre-cut-over offload's reversal
  // moved back into transit (wave 15).
  const cutover = await getInventoryCutover(tx, companyId);
  const openingTransit = cutover ? await openingTransitPurchaseOrderIdsTx(tx, companyId) : null;
  const movedToTransit = await preCutoverTransitBalanceTx(tx, companyId, containerId);
  const pos = await purchaseOrderCosts(tx, companyId, sql`po.container_id = ${containerId}`);
  const containerOffloadDate = container.offload_date ?? offloads[offloads.length - 1]?.date ?? null;
  let inTransit: Decimal = movedToTransit.balance;
  for (const po of pos) {
    if (!po.voucherDate) continue;
    const carriedByOpening =
      cutover !== null &&
      po.voucherDate < cutover.effectiveFrom &&
      (openingTransit !== null
        ? openingTransit.has(po.purchaseOrderId)
        : containerOffloadDate !== null && containerOffloadDate >= cutover.effectiveFrom && !movedToTransit.exists);
    const [git] = await rows<{ id: number }>(
      tx,
      sql`SELECT id FROM vouchers WHERE company_id = ${companyId}
           AND voucher_number = ${purchaseOrderGitVoucherNumber(po.purchaseOrderId)}`
    );
    if (git || carriedByOpening) inTransit = inTransit.plus(po.purchases);
  }
  const [ordered] = await rows<{ quantity: string }>(
    tx,
    sql`
      SELECT COALESCE(SUM(li.quantity), 0)::text AS quantity
        FROM po_line_items li JOIN purchase_orders po ON po.id = li.po_id
       WHERE po.company_id = ${companyId} AND po.container_id = ${containerId}
    `
  );
  const orderedQuantity = toMoney(ordered?.quantity ?? 0);

  // Charges booked by the offload: whatever account each charge voucher debited.
  // A charge voucher is the offload's by its posting identity, or by the number
  // the offload gave it (<DUTY|OFFICE|TRANS|XFER|CHG>-<container>-<n>): a charge
  // voucher written before posting identities existed (or whose marker was
  // cleared) has no identity, and the re-priced stock-in journal must still
  // credit the charge (wave 11). Editing a charge voucher
  // (PUT /api/vouchers/:id/with-entries) keeps its voucher row and identity.
  const chargeNumber = `^(DUTY|OFFICE|TRANS|XFER|CHG)-${escapeRegExp(container.container_number)}-[0-9]+$`;
  const charges = await rows<{ ledger_account_id: number; voucher_date: string; amount: string }>(
    tx,
    sql`
      SELECT ve.ledger_account_id, v.voucher_date::text AS voucher_date, SUM(ve.debit_amount)::text AS amount
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
         AND (
           EXISTS (
             SELECT 1 FROM accounting_posting_requests apr
              WHERE apr.voucher_id = v.id AND apr.company_id = ${companyId}
                AND apr.source_type = 'container-offload-charge'
                AND apr.source_id LIKE ${`${companyId}:${containerId}:%`}
           )
           OR v.voucher_number ~ ${chargeNumber}
         )
         AND ve.debit_amount > 0 AND ve.ledger_account_id IS NOT NULL
       GROUP BY ve.ledger_account_id, v.voucher_date
       ORDER BY ve.ledger_account_id, v.voucher_date
    `
  );

  const accounts = await systemAccountIdsTx(tx, companyId, ["GOODS_IN_TRANSIT", "PURCHASES", "COGS"]);
  const { id: inventoryAccountId } = await getOrCreateInventoryControlAccount(tx, companyId);
  const signed = (ledgerAccountId: number, amount: Decimal, narration: string): LinkedJournalLine => ({
    ledgerAccountId,
    debit: amount.isNegative() ? zero() : amount,
    credit: amount.isNegative() ? amount.negated() : zero(),
    narration,
  });
  const result: Array<{ offload: OffloadRow; date: string | null; lines: LinkedJournalLine[] }> = [];
  let cumulativeQuantity: Decimal = zero();
  let transitThrough: Decimal = zero();
  let previousDate: string | null = null;
  offloads.forEach(({ offload, date }, index) => {
    const last = index === offloads.length - 1;
    const row = receivedBy.get(offload.id);
    const value = toMoney(row?.value ?? 0).toDecimalPlaces(2);
    // What the sub-ledger received, and the landed value it did not (COGS).
    const inventoryValue = toMoney(row?.inventory ?? 0).toDecimalPlaces(2);
    const cogsValue = value.minus(inventoryValue);

    cumulativeQuantity = cumulativeQuantity.plus(toMoney(offload.total_bales));
    const through = orderedQuantity.gt(0)
      ? cumulativeQuantity.dividedBy(orderedQuantity)
      : new MoneyDecimal(last ? 1 : 0);
    const transitNow = cumulativeShare(inTransit, through);
    const transit = transitNow.minus(transitThrough);
    transitThrough = transitNow;

    const window = (chargeDate: string) =>
      (previousDate === null || chargeDate > previousDate) && (last || date === null || chargeDate <= date);
    const ownCharges = new Map<number, Decimal>();
    for (const charge of charges) {
      if (!window(charge.voucher_date)) continue;
      ownCharges.set(
        charge.ledger_account_id,
        (ownCharges.get(charge.ledger_account_id) ?? zero()).plus(toMoney(charge.amount))
      );
    }
    previousDate = date ?? previousDate;
    const chargeTotal = [...ownCharges.values()].reduce((sum, amount) => sum.plus(amount), zero());
    const residual = value.minus(transit).minus(chargeTotal);
    if (!value.gt(0)) {
      result.push({ offload, date, lines: [] });
      return;
    }
    result.push({
      offload,
      date,
      lines: [
        signed(inventoryAccountId, inventoryValue, "Stock received at landed cost"),
        signed(
          accounts.get("COGS")!,
          cogsValue,
          "Landed cost of stock already sold (shortage settled, charge re-priced)"
        ),
        signed(accounts.get("GOODS_IN_TRANSIT")!, transit.negated(), "Goods in transit received"),
        ...[...ownCharges.entries()].map(([ledgerAccountId, amount]) =>
          signed(ledgerAccountId, amount.negated(), "Offload charge capitalised into stock")
        ),
        signed(
          accounts.get("PURCHASES")!,
          residual.negated(),
          "Difference between purchase cost and landed stock value"
        ),
      ],
    });
  });
  return result;
}

// ─── Containers offloaded before the cut-over (wave 15, C1) ───────────────────

export const PRE_CUTOVER_TRANSIT_SOURCE = "offload-to-transit";

export const PRE_CUTOVER_OFFLOAD_SOURCE = "offload-precutover";

/** The POs the applied opening plan carried as goods in transit, or null for a plan without the list. */
export async function openingTransitPurchaseOrderIdsTx(
  tx: DbTransaction,
  companyId: number
): Promise<Set<number> | null> {
  const [row] = await rows<{ ids: unknown }>(
    tx,
    sql`SELECT opening_plan -> 'goodsInTransitPurchaseOrderIds' AS ids FROM gl_inventory_cutovers
         WHERE company_id = ${companyId}`
  );
  if (!row || !Array.isArray(row.ids)) return null;
  return new Set(row.ids.map(Number));
}

/**
 * What the pre-cut-over movement journals of a container hold on Goods in
 * Transit (debit positive), and whether any exists.
 */
export async function preCutoverTransitBalanceTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<{ balance: Decimal; exists: boolean }> {
  const [row] = await rows<{ balance: string; journals: number }>(
    tx,
    sql`
      SELECT COALESCE(SUM(ve.debit_amount - ve.credit_amount) FILTER (WHERE la.code = 'GOODS_IN_TRANSIT'), 0)::text
               AS balance,
             COUNT(DISTINCT v.id)::int AS journals
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id
        LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
         AND v.voucher_number LIKE ${`INV-MOVE-${companyId}-${PRE_CUTOVER_TRANSIT_SOURCE}-${containerId}:%`}
    `
  );
  return { balance: toMoney(row?.balance ?? 0).toDecimalPlaces(2), exists: (row?.journals ?? 0) > 0 };
}
