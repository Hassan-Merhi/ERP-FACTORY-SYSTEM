// Extracted from ./stockReceipts.ts
import { randomUUID } from "node:crypto";
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { getInventoryCutover } from "./cutover";
import { postInventoryMovementJournalTx } from "./inventoryMovementJournal";
import { isSupplierPartnerCompany } from "./linkedJournal";
import {
  PRE_CUTOVER_OFFLOAD_SOURCE,
  PRE_CUTOVER_TRANSIT_SOURCE,
  openingTransitPurchaseOrderIdsTx,
  preCutoverTransitBalanceTx,
  purchaseOrderCosts,
  zero,
} from "./stockReceiptsSyncPurchaseOrderGitTx";

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
