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
import { getInventoryCutover, isPerpetualInventoryActive } from "./cutover";
import { postInventoryMovementJournalTx } from "./inventoryMovementJournal";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  type LinkedJournalLine,
} from "./linkedJournal";
import {
  PRE_CUTOVER_OFFLOAD_SOURCE,
  PRE_CUTOVER_TRANSIT_SOURCE,
  existingStockInJournalsTx,
  lineKey,
  offloadStockInVoucherNumber,
  openingTransitPurchaseOrderIdsTx,
  preCutoverTransitBalanceTx,
  purchaseOrderCosts,
  rows,
  stockInLinesTx,
  syncPurchaseOrderGitTx,
  zero,
  type OffloadRow,
} from "./stockReceiptsSyncPurchaseOrderGitTx";
export {
  PRE_CUTOVER_OFFLOAD_SOURCE,
  PRE_CUTOVER_TRANSIT_SOURCE,
  containerStockInVoucherNumber,
  offloadStockInVoucherNumber,
  purchaseOrderGitVoucherNumber,
  removeContainerStockInJournalsTx,
  removePurchaseOrderGitTx,
  syncPurchaseOrderGitTx,
} from "./stockReceiptsSyncPurchaseOrderGitTx";

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
