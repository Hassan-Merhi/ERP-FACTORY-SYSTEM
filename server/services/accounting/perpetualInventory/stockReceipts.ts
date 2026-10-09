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
 *   STOCK-IN-{containerId}-{offloadId}, one per offload, dated with that
 *   offload (wave 17 B; it was one STOCK-IN-{containerId} per container,
 *   rebuilt whole on every offload and dated with the latest one, so a
 *   partial offload credited the whole purchase cost and a later offload
 *   rewrote a journal of an earlier, possibly closed, period):
 *     Dr Inventory          exactly the value the stock sub-ledger received
 *                           (container_offload_items.value_moved of active
 *                           offloads; the line value on a legacy line)
 *     Dr/Cr COGS            the rest of the landed value (cogs_variance): the
 *                           settlement variance of shortages the receipt
 *                           covered (receipt rate − provisional rate) × settled
 *                           bales, and the sold share of a later charge
 *                           re-pricing. Landed value = Inventory + COGS.
 *     Cr Goods in Transit   the container's POs that are in transit: a PO with
 *                           a GIT-PO journal, or one dated before the cut-over
 *                           (the opening journal carried it as in transit),
 *                           by the offloads' cumulative share of the POs'
 *                           quantity
 *     Cr each account an offload charge voucher debited, by that amount (the
 *                           charge vouchers dated after the previous offload
 *                           and on or before this one)
 *     Cr/Dr Purchases       the difference, so a PO and its landed value that
 *                           do not agree stay visible in Purchases
 *
 * Both journals are derived from the current state of their documents and
 * replaced whole by syncPurchaseOrderGitTx / syncContainerStockInTx, which the
 * create, edit, offload and reverse paths call. Nothing is posted for a
 * supplier-partner company or a document dated before the company's cut-over.
 *
 * Containers offloaded before the cut-over (wave 15, re-audit C1). The opening
 * journal carried their stock in Inventory (the sub-ledger as of the eve) and
 * left their purchase cost in Purchases, where the periodic book had expensed
 * it; no STOCK-IN journal exists for them, and none is posted while their
 * offload date stays before the cut-over. When such an offload is reversed,
 * replaced, suspended, restored or re-priced once the cut-over applies, the
 * measured change of the stock sub-ledger is posted by
 * postPreCutoverOffloadMovementTx, dated the day of the change:
 *   - back in transit (reverse, suspend: the container is OTW again, so the
 *     reconciliation counts its POs as goods in transit): Dr Goods in Transit
 *     for the purchase cost of its POs (INV-MOVE-...-offload-to-transit-...),
 *     the rest of the change against Purchases (INV-MOVE-...-offload-precutover-...);
 *   - out of transit again (restore of a suspended offload dated before the
 *     cut-over): Cr Goods in Transit for what the earlier journal put there,
 *     the rest against Purchases;
 *   - in place (a replace that keeps a date before the cut-over, a charge
 *     re-pricing): the change against Purchases, where the cost sat.
 * A container moved back into transit this way is not carried by the opening
 * as goods in transit; when it is offloaded again (on or after the cut-over:
 * an offload dated before the cut-over is refused once it applies), STOCK-IN
 * credits Goods in Transit for the balance those journals left there.
 *
 * carriedByOpening: a PO is carried by the opening as goods in transit only
 * when the opening plan lists it (`goodsInTransitPurchaseOrderIds`: dated
 * before the cut-over and its container not offloaded before it). A plan
 * applied before the list existed falls back to the PO date, and to the
 * offload having been dated on or after the cut-over with no pre-cut-over
 * movement journal for the container.
 */
import { randomUUID } from "node:crypto";

import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
import { postInventoryMovementJournalTx } from "./inventoryMovementJournal";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
  type LinkedJournalLine,
} from "./linkedJournal";

export const purchaseOrderGitVoucherNumber = (purchaseOrderId: number) => `GIT-PO-${purchaseOrderId}`;
/** The prefix of a container's stock-in journals, and the number of the legacy single journal. */
export const containerStockInVoucherNumber = (containerId: number) => `STOCK-IN-${containerId}`;

const zero = () => new MoneyDecimal(0);

/** A literal for a POSIX regular expression. */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

interface OffloadRow {
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

const lineKey = (ledgerAccountId: number, debit: Decimal, credit: Decimal) =>
  `${ledgerAccountId}:${debit.toFixed(2)}:${credit.toFixed(2)}`;

/** The live stock-in journals of a container (the per-offload ones and a legacy STOCK-IN-{container}). */
async function existingStockInJournalsTx(
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

/**
 * Posts the stock-in journals of a container's offloads (see the module
 * comment, "one journal per offload"). Each active offload has its own
 * journal, STOCK-IN-{container}-{offload}, dated with that offload (the
 * container's offload date for its latest offload, else the offload's own
 * date):
 *   - Inventory and COGS: what that offload's lines received;
 *   - Goods in Transit: the container's in-transit purchase cost, by the
 *     offloads' cumulative share of the POs' quantity (an offload that
 *     completes the quantity takes what is left), so a partial offload
 *     credits only its share and the rest stays in transit;
 *   - charges: the container's offload charge vouchers dated after the
 *     previous offload and on or before this one (the latest offload takes
 *     every later one);
 *   - Purchases: the difference.
 * A journal whose date and lines are unchanged is left as it is, so a later
 * offload never rewrites an earlier offload's journal (in a closed period or
 * not); a changed one is replaced; the journals of offloads that are gone (or
 * suspended), and the legacy single journal STOCK-IN-{container}, are
 * removed. Returns the id of the latest offload's journal, or null.
 */
export async function syncContainerStockInTx(
  tx: DbTransaction,
  companyId: number,
  containerId: number
): Promise<number | null> {
  const existing = await existingStockInJournalsTx(tx, companyId, containerId);
  const [container] = await rows<{ container_number: string; offload_date: string | null }>(
    tx,
    sql`SELECT container_number, offload_date::text AS offload_date FROM containers
         WHERE id = ${containerId} AND company_id = ${companyId}`
  );
  const offloads = container
    ? await rows<OffloadRow>(
        tx,
        sql`
          SELECT co.id, co.location_id, co.offloaded_at::date::text AS offload_date, co.total_bales::text AS total_bales
            FROM container_offloads co
           WHERE co.container_id = ${containerId} AND co.optional = false
           ORDER BY co.id
        `
      )
    : [];
  const desired = new Map<string, { offload: OffloadRow; date: string; lines: LinkedJournalLine[]; keys: string[] }>();
  const supplierPartner = await isSupplierPartnerCompany(tx, companyId);
  if (container && offloads.length > 0 && !supplierPartner) {
    const latest = offloads[offloads.length - 1];
    const dated = offloads.map((offload) => ({
      offload,
      date: offload.id === latest.id ? (container.offload_date ?? offload.offload_date) : offload.offload_date,
    }));
    const lines = await stockInLinesTx(tx, companyId, containerId, container, dated);
    for (const entry of lines) {
      if (!entry.date || !(await isPerpetualInventoryActive(tx, companyId, entry.date))) continue;
      const kept = entry.lines
        .map((line) => ({ ...line, debit: line.debit.toDecimalPlaces(2), credit: line.credit.toDecimalPlaces(2) }))
        .filter((line) => !line.debit.isZero() || !line.credit.isZero());
      if (kept.length === 0) continue;
      desired.set(offloadStockInVoucherNumber(containerId, entry.offload.id), {
        offload: entry.offload,
        date: entry.date,
        lines: kept,
        keys: kept.map((line) => lineKey(line.ledgerAccountId, line.debit, line.credit)).sort(),
      });
    }
  }

  const unchanged = new Set<string>();
  for (const journal of existing) {
    const want = desired.get(journal.voucher_number);
    if (want && want.date === journal.voucher_date && [...journal.lines].sort().join("|") === want.keys.join("|")) {
      unchanged.add(journal.voucher_number);
      continue;
    }
    await removeLinkedJournalTx(tx, companyId, journal.voucher_number);
  }
  let latestId: number | null = null;
  for (const [number, want] of desired) {
    if (unchanged.has(number)) {
      latestId = existing.find((journal) => journal.voucher_number === number)?.id ?? latestId;
      continue;
    }
    latestId = await postLinkedJournalTx(tx, {
      companyId,
      voucherNumber: number,
      voucherDate: want.date,
      description: ["Stock received", number].join(" - "),
      identity: { sourceType: "perpetual-stock-in", sourceId: `${containerId}:${want.offload.id}` },
      locationId: want.offload.location_id,
      lines: want.lines,
    });
  }
  return latestId;
}

/** The lines of each active offload's stock-in journal (see syncContainerStockInTx). */
async function stockInLinesTx(
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
    if ((await existingStockInJournalsTx(tx, companyId, containerId)).length > 0) {
      await syncContainerStockInTx(tx, companyId, containerId);
    }
  }
}

// ─── Containers offloaded before the cut-over (wave 15, C1) ───────────────────

export const PRE_CUTOVER_TRANSIT_SOURCE = "offload-to-transit";
export const PRE_CUTOVER_OFFLOAD_SOURCE = "offload-precutover";

/** The POs the applied opening plan carried as goods in transit, or null for a plan without the list. */
async function openingTransitPurchaseOrderIdsTx(tx: DbTransaction, companyId: number): Promise<Set<number> | null> {
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
async function preCutoverTransitBalanceTx(
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

/**
 * Whether a change to an offload dated `offloadDate` is a pre-cut-over
 * container change (C1): the company's cut-over applies today, the offload is
 * dated before it, and the company is not a supplier partner.
 */
export async function isPreCutoverOffloadChangeTx(
  tx: DbTransaction,
  companyId: number,
  offloadDate: string | null | undefined
): Promise<boolean> {
  if (!offloadDate) return false;
  const cutover = await getInventoryCutover(tx, companyId);
  if (!cutover || cutover.status !== "ACTIVE") return false;
  const today = new Date().toISOString().slice(0, 10);
  if (today < cutover.effectiveFrom || offloadDate >= cutover.effectiveFrom) return false;
  return !(await isSupplierPartnerCompany(tx, companyId));
}

/**
 * Posts the measured sub-ledger change of a pre-cut-over container's offload
 * (see the module comment). `valueDelta` is the signed change of the stock
 * sub-ledger the operation made (the sum of the inventory helpers'
 * valueDelta). Nothing is posted unless isPreCutoverOffloadChangeTx holds.
 * Returns the journal numbers posted.
 */
export async function postPreCutoverOffloadMovementTx(
  tx: DbTransaction,
  params: {
    companyId: number;
    containerId: number;
    containerNumber: string;
    /** The date of the offload being changed (before the change). */
    offloadDate: string | null | undefined;
    locationId: number | null;
    valueDelta: Decimal;
    mode: "toTransit" | "fromTransit" | "inPlace";
    reason: string;
    actor?: { userId: string; username: string } | null;
  }
): Promise<string[]> {
  if (!(await isPreCutoverOffloadChangeTx(tx, params.companyId, params.offloadDate))) return [];
  const date = new Date().toISOString().slice(0, 10);
  const operation = `${params.containerId}:${randomUUID().slice(0, 8)}`;
  const reference = `Container ${params.containerNumber}`;
  // The Inventory side of the Goods in Transit move (debit positive): what
  // the ledger holds in transit for the container now (the opening's POs and
  // earlier pre-cut-over journals) less what it should hold after the change
  // (the POs' purchase cost back in transit, or nothing once received).
  let transit: Decimal = zero();
  if (params.mode !== "inPlace") {
    const pos = await purchaseOrderCosts(tx, params.companyId, sql`po.container_id = ${params.containerId}`);
    const opening = (await openingTransitPurchaseOrderIdsTx(tx, params.companyId)) ?? new Set<number>();
    const held = pos
      .filter((po) => opening.has(po.purchaseOrderId))
      .reduce(
        (sum, po) => sum.plus(po.purchases),
        (await preCutoverTransitBalanceTx(tx, params.companyId, params.containerId)).balance
      );
    const target = params.mode === "toTransit" ? pos.reduce((sum, po) => sum.plus(po.purchases), zero()) : zero();
    transit = held.minus(target).toDecimalPlaces(2);
  }
  const posted: string[] = [];
  const common = {
    companyId: params.companyId,
    date,
    reference,
    actor: params.actor ?? null,
    locationId: params.locationId,
  };
  if (!transit.isZero()) {
    const journal = await postInventoryMovementJournalTx(tx, {
      ...common,
      sourceType: PRE_CUTOVER_TRANSIT_SOURCE,
      sourceId: operation,
      lines: [{ locationId: params.locationId, valueDelta: transit.toFixed(2) }],
      offsetAccountCode: "GOODS_IN_TRANSIT",
      narration: `${params.reason}: purchase cost back in transit`,
    });
    if (journal) posted.push(journal.voucherNumber);
  }
  const rest = params.valueDelta.minus(transit).toDecimalPlaces(2);
  if (!rest.isZero()) {
    const journal = await postInventoryMovementJournalTx(tx, {
      ...common,
      sourceType: PRE_CUTOVER_OFFLOAD_SOURCE,
      sourceId: operation,
      lines: [{ locationId: params.locationId, valueDelta: rest.toFixed(2) }],
      offsetAccountCode: "PURCHASES",
      narration: `${params.reason}: stock of a container offloaded before the cut-over`,
    });
    if (journal) posted.push(journal.voucherNumber);
  }
  return posted;
}
