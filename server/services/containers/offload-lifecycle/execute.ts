import type Decimal from "decimal.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../../db";
import * as schema from "@shared/schema";

import { postChargeVouchers } from "./charge-vouchers";
import { reverseExistingOffload } from "./reverse";
import { nextCanonicalSourceRevision } from "../../inventory/canonicalSourceRevision";
import { createDatabaseStockMovementAdapter } from "../../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../inventory/stockMovementIntegrityService";
import { postSupplierPartnerJournals } from "./sp-journals";
import {
  ContainerOffloadLifecycleError,
  ContainerOffloadLifecycleInput,
  ContainerOffloadLifecycleResult,
  amount,
  buildItemMap,
  positiveIds,
} from "./types";
import { firstRow } from "../../../lib/queryResult";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { adjustInventory, receiveInventoryAtValue } from "../../../inventoryHelper";
import {
  postInventoryMovementJournalTx,
  type InventoryMovementLine,
} from "../../accounting/perpetualInventory/inventoryMovementJournal";
import {
  isPreCutoverOffloadChangeTx,
  postPreCutoverOffloadMovementTx,
  syncContainerStockInTx,
} from "../../accounting/perpetualInventory/stockReceipts";
import { isPerpetualInventoryActive } from "../../accounting/perpetualInventory/cutover";
import { isSupplierPartnerCompany } from "../../accounting/perpetualInventory/linkedJournal";

/** The inventory row an offload locks FOR UPDATE before rewriting its cost. */
type InventoryLockRow = { id: number; quantity: string; total_value: string };

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export const OFFLOAD_CURRENCY_UNCONFIRMED_CODE = "CONTAINER_OFFLOAD_CURRENCY_RATE_UNCONFIRMED" as const;
export const OFFLOAD_CURRENCY_UNCONFIRMED_MESSAGE =
  "This container's purchase orders are in a currency other than USD with no confirmed exchange rate: under perpetual inventory the stock cannot be valued, so the offload is refused. Record the purchase orders in USD first.";

/**
 * Under perpetual inventory (wave 11, owner decision) an offload values the
 * stock it receives, and the INVENTORY account takes that value, in USD. An
 * ERP purchase order's line rates are in the order's currency and the order
 * carries no exchange rate, so a non-USD order has no confirmed rate to value
 * its stock at: the offload (create, replace or edit) is refused rather than
 * book native amounts as dollars. Before the company's cut-over (or for a
 * supplier partner, which carries no perpetual INVENTORY) the offload keeps its
 * behaviour.
 */
async function assertOffloadCurrencyValuedTx(
  tx: DbTransaction,
  companyId: number,
  offloadDate: string,
  purchaseOrders: ReadonlyArray<{ currency: string | null }>
): Promise<void> {
  const foreign = purchaseOrders.some((po) => {
    const currency = String(po.currency ?? "")
      .trim()
      .toUpperCase();
    return currency !== "" && currency !== "USD";
  });
  if (!foreign) return;
  if (!(await isPerpetualInventoryActive(tx, companyId, offloadDate))) return;
  if (await isSupplierPartnerCompany(tx, companyId)) return;
  throw new ContainerOffloadLifecycleError(
    OFFLOAD_CURRENCY_UNCONFIRMED_MESSAGE,
    409,
    OFFLOAD_CURRENCY_UNCONFIRMED_CODE
  );
}

export const OFFLOAD_BEFORE_CUTOVER_CODE = "CONTAINER_OFFLOAD_BEFORE_CUTOVER" as const;
export const OFFLOAD_BEFORE_CUTOVER_MESSAGE =
  "The perpetual inventory cut-over is applied: an offload cannot be dated before the cut-over date unless it edits an offload already dated before it. Date the offload on or after the cut-over date.";

/** The date an existing offload is booked at: the container's offload date, else the offload's own. */
function offloadBookedDate(
  container: { offloadDate: string | null },
  offload: { offloadedAt: Date | string | null } | null
): string | null {
  if (container.offloadDate) return container.offloadDate;
  if (!offload?.offloadedAt) return null;
  return new Date(offload.offloadedAt).toISOString().slice(0, 10);
}

/**
 * Wave 15 (M10): an inventory cost correction rewrites the cost of stock
 * already on hand (a revaluation), so only Admin or Owner (Developer passes,
 * as with requireRole) may send one; the offload itself keeps its own access.
 * The route passes the session's company role.
 */
export const OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE = "CONTAINER_OFFLOAD_COST_CORRECTION_FORBIDDEN" as const;
export const OFFLOAD_COST_CORRECTION_FORBIDDEN_MESSAGE =
  "Only an Admin or Owner can correct the cost of stock already on hand during an offload.";
const OFFLOAD_COST_CORRECTION_ROLES = new Set(["Admin", "Owner", "Developer"]);

export interface OffloadCostCorrectionApprover {
  /** The caller's company role; cost corrections need Admin or Owner. */
  actorRole?: string | null;
}

export async function executeContainerOffloadLifecycle(
  input: ContainerOffloadLifecycleInput & OffloadCostCorrectionApprover
): Promise<ContainerOffloadLifecycleResult> {
  return db.transaction(async (tx) => {
    // The container row is the offload's ownership token and it is taken FOR
    // UPDATE, in container → offload order, before any state is read.
    //
    // container_offloads has no unique key on container_id, so without this lock
    // two simultaneous offloads of the same container both read status OTW, both
    // found no existing offload, and both committed: two offload records, the
    // stock received twice, the charge vouchers and Supplier Partner journals
    // posted twice. The "Multiple offload records exist for this container"
    // guard below could only report that damage after the fact.
    //
    // Serialized here, the second request re-reads the committed row, sees
    // OFFLOADED, and takes the same create-or-replace path a second sequential
    // request always took — one offload record, one set of stock and voucher
    // effects.
    const [container] = await tx
      .select()
      .from(schema.containers)
      .where(and(eq(schema.containers.id, input.containerId), eq(schema.containers.companyId, input.companyId)))
      .limit(1)
      .for("update");

    if (!container) {
      throw new ContainerOffloadLifecycleError("Container not found", 404, "CONTAINER_NOT_FOUND");
    }
    if (input.mode === "replace-only" && container.status !== "OFFLOADED") {
      throw new ContainerOffloadLifecycleError(
        "Container must be offloaded before it can be edited.",
        409,
        "CONTAINER_NOT_OFFLOADED"
      );
    }
    if (container.status !== "OTW" && container.status !== "OFFLOADED") {
      throw new ContainerOffloadLifecycleError(
        `Container status ${container.status} cannot be offloaded.`,
        409,
        "CONTAINER_NOT_OFFLOADABLE"
      );
    }

    const [location] = await tx
      .select()
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.id, input.locationId),
          eq(schema.locations.companyId, input.companyId),
          isNull(schema.locations.deletedAt)
        )
      )
      .limit(1);
    if (!location) {
      throw new ContainerOffloadLifecycleError(
        "Invalid destination location for the selected company.",
        400,
        "CONTAINER_OFFLOAD_LOCATION_INVALID"
      );
    }

    // Locked, not just read: PATCH /api/purchase-orders/:id rewrites po_line_items
    // and updates the parent purchase_orders row in one transaction, so an unlocked
    // read here can price the offload from a half-rewritten purchase order. Taking
    // the row lock after the container lock keeps the offload's ordering the same
    // for both, and makes a concurrent line-item rewrite wait rather than interleave.
    const purchaseOrders = await tx
      .select()
      .from(schema.purchaseOrders)
      .where(
        and(
          eq(schema.purchaseOrders.containerId, input.containerId),
          eq(schema.purchaseOrders.companyId, input.companyId)
        )
      )
      .for("update");
    if (purchaseOrders.length === 0) {
      throw new ContainerOffloadLifecycleError(
        "Container has no purchase orders to offload.",
        400,
        "CONTAINER_OFFLOAD_NO_PURCHASE_ORDERS"
      );
    }

    await assertOffloadCurrencyValuedTx(tx, input.companyId, input.offloadDate, purchaseOrders);

    const poIds = purchaseOrders.map((po: typeof schema.purchaseOrders.$inferSelect) => po.id);
    const lineItems = await tx
      .select({
        stockItemId: schema.poLineItems.stockItemId,
        quantity: schema.poLineItems.quantity,
        rate: schema.poLineItems.rate,
      })
      .from(schema.poLineItems)
      .where(inArray(schema.poLineItems.poId, poIds));
    if (lineItems.length === 0) {
      throw new ContainerOffloadLifecycleError(
        "Container purchase orders have no line items.",
        400,
        "CONTAINER_OFFLOAD_NO_LINE_ITEMS"
      );
    }

    const existingOffloads = await tx
      .select()
      .from(schema.containerOffloads)
      .where(eq(schema.containerOffloads.containerId, input.containerId))
      .orderBy(desc(schema.containerOffloads.id))
      .limit(2);
    if (existingOffloads.length > 1) {
      throw new ContainerOffloadLifecycleError(
        "Multiple offload records exist for this container. Reconcile them before editing.",
        409,
        "CONTAINER_OFFLOAD_DUPLICATE_RECORDS"
      );
    }
    const existingOffload = existingOffloads[0] ?? null;
    const replacing = container.status === "OFFLOADED";
    if (replacing && !existingOffload) {
      throw new ContainerOffloadLifecycleError(
        "The container is marked offloaded but its offload record is missing.",
        409,
        "CONTAINER_OFFLOAD_RECORD_MISSING"
      );
    }
    if (!replacing && existingOffload) {
      throw new ContainerOffloadLifecycleError(
        "An offload record already exists while the container is marked OTW.",
        409,
        "CONTAINER_OFFLOAD_STATE_MISMATCH"
      );
    }

    // Wave 15 (C1): once the cut-over applies, an offload dated before it posts
    // no stock-in journal. Only an edit of an offload already dated before the
    // cut-over may keep such a date (its change is journalled below); any other
    // offload dated before the cut-over is refused.
    const previousOffloadDate = existingOffload ? offloadBookedDate(container, existingOffload) : null;
    const previousBeforeCutover = await isPreCutoverOffloadChangeTx(tx, input.companyId, previousOffloadDate);
    if (!previousBeforeCutover && (await isPreCutoverOffloadChangeTx(tx, input.companyId, input.offloadDate))) {
      throw new ContainerOffloadLifecycleError(OFFLOAD_BEFORE_CUTOVER_MESSAGE, 409, OFFLOAD_BEFORE_CUTOVER_CODE);
    }

    let reversalDelta: Decimal = new MoneyDecimal(0);
    if (existingOffload) {
      reversalDelta = await reverseExistingOffload(tx, container, existingOffload, lineItems);
    }

    const itemMap = buildItemMap(lineItems);
    const zero = new MoneyDecimal(0);
    const totalBales = [...itemMap.values()].reduce((sum, item) => sum.plus(item.totalQuantity), zero);
    if (!totalBales.gt(0)) {
      throw new ContainerOffloadLifecycleError(
        "Container has no positive stock quantity to offload.",
        400,
        "CONTAINER_OFFLOAD_ZERO_QUANTITY"
      );
    }

    // Landed cost, in decimal arithmetic: the charges are spread per bale at
    // 2dp and the cent remainder goes on the last line, so the lines add up
    // to the purchase value plus the charges exactly.
    const additionalCharges = input.additionalCharges ?? [];
    const totalCharges = [
      input.duties,
      input.officeCharges,
      input.transferCharges,
      input.transportFees,
      ...additionalCharges.map((charge) => charge.amount),
      container.chargesTotal,
    ].reduce<Decimal>((sum, value) => sum.plus(toMoney(value)), zero);
    const additionalCostPerBale = totalCharges.dividedBy(totalBales).toDecimalPlaces(2);
    const roundingDifference = totalCharges.minus(additionalCostPerBale.times(totalBales)).toDecimalPlaces(2);
    const storedItems: Array<{
      stockItemId: number;
      quantity: Decimal;
      rate: Decimal;
      totalValue: Decimal;
      valueMoved: Decimal;
      cogsVariance: Decimal;
    }> = [];
    const entries = [...itemMap.entries()];

    // Corrections of the cost of stock already on hand at the destination
    // (the operator says its average was wrong). A revaluation of the
    // sub-ledger: under perpetual inventory it is posted to Inventory
    // Revaluation by an INV-MOVE journal once the offload record exists.
    const validCorrectionIds = new Set(itemMap.keys());
    const correctionLines: InventoryMovementLine[] = [];
    const requestsCorrection = (input.inventoryCostCorrections ?? []).some(
      (correction) => correction.correctRate > 0 && validCorrectionIds.has(correction.stockItemId)
    );
    if (requestsCorrection && !OFFLOAD_COST_CORRECTION_ROLES.has(String(input.actorRole ?? ""))) {
      throw new ContainerOffloadLifecycleError(
        OFFLOAD_COST_CORRECTION_FORBIDDEN_MESSAGE,
        403,
        OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE
      );
    }
    for (const correction of input.inventoryCostCorrections ?? []) {
      if (!(correction.correctRate > 0) || !validCorrectionIds.has(correction.stockItemId)) continue;
      const correctionRows = await tx.execute(
        sql`SELECT * FROM inventory WHERE location_id = ${input.locationId} AND stock_item_id = ${correction.stockItemId} FOR UPDATE`
      );
      const row = firstRow<InventoryLockRow>(correctionRows);
      if (!row) continue;
      const existingQuantity = toMoney(row.quantity);
      if (!existingQuantity.gt(0)) continue;
      const correctRate = toMoney(correction.correctRate);
      const correctedValue = existingQuantity.times(correctRate).toDecimalPlaces(2);
      const valueDelta = correctedValue.minus(toMoney(row.total_value));
      await tx
        .update(schema.inventory)
        .set({
          averageRate: correctRate.toFixed(7),
          totalValue: correctedValue.toFixed(2),
          lastUpdated: new Date(),
        })
        .where(eq(schema.inventory.id, row.id));
      correctionLines.push({
        stockItemId: correction.stockItemId,
        locationId: input.locationId,
        valueDelta: valueDelta.toFixed(2),
      });
    }

    for (let index = 0; index < entries.length; index += 1) {
      const [stockItemId, item] = entries[index];
      if (item.totalQuantity.isZero()) continue;
      let offloadValue = item.weightedRateSum.plus(item.totalQuantity.times(additionalCostPerBale)).toDecimalPlaces(2);
      if (index === entries.length - 1 && !roundingDifference.isZero()) {
        offloadValue = offloadValue.plus(roundingDifference);
      }
      const adjustedRate = offloadValue.dividedBy(item.totalQuantity);
      if (!adjustedRate.isFinite()) {
        throw new ContainerOffloadLifecycleError(
          `Calculated rate is invalid for stock item ${stockItemId}.`,
          409,
          "CONTAINER_OFFLOAD_RATE_INVALID"
        );
      }

      if (item.totalQuantity.isNegative()) {
        // A net-negative PO line returns stock: issued at the row's cost.
        const issued = await adjustInventory(
          tx,
          input.locationId,
          stockItemId,
          item.totalQuantity.toNumber(),
          input.companyId,
          undefined,
          `container-offload:${input.containerId}`
        );
        storedItems.push({
          stockItemId,
          quantity: item.totalQuantity,
          rate: adjustedRate,
          totalValue: offloadValue,
          valueMoved: toMoney(issued.valueDelta),
          cogsVariance: offloadValue.minus(toMoney(issued.valueDelta)),
        });
        continue;
      }

      // The receipt moves the sub-ledger by the line's exact landed value. Into
      // negative stock it first settles the shortage (negative-stock policy):
      // the sub-ledger takes back the shortage's provisional value and the
      // difference to what the receipt paid for those bales goes to COGS on
      // the stock-in journal (cogs_variance).
      const received = await receiveInventoryAtValue(tx, {
        locationId: input.locationId,
        stockItemId,
        quantity: item.totalQuantity,
        value: offloadValue,
        companyId: input.companyId,
        // Not a voucher id: the layer's source_voucher_id references vouchers.
        sourceVoucherType: `container-offload:${input.containerId}`,
      });
      storedItems.push({
        stockItemId,
        quantity: item.totalQuantity,
        rate: adjustedRate,
        totalValue: offloadValue,
        valueMoved: toMoney(received.valueDelta),
        cogsVariance: toMoney(received.shortageSettlementVariance),
      });
    }

    await tx
      .update(schema.containers)
      .set({
        status: "OFFLOADED",
        offloadDate: input.offloadDate,
        dutyFee: amount(input.duties) > 0 ? input.duties : "0",
      })
      .where(eq(schema.containers.id, input.containerId));

    for (const po of purchaseOrders) {
      if (!po.voucherId) continue;
      await tx
        .update(schema.vouchers)
        .set({ description: `Purchase Order ${po.poNumber} - Container ${container.containerNumber} (Offloaded)` })
        .where(eq(schema.vouchers.id, po.voucherId));
    }

    await postChargeVouchers(tx, container, input.companyId, input);

    const [offload] = await tx
      .insert(schema.containerOffloads)
      .values({
        containerId: input.containerId,
        locationId: input.locationId,
        duties: input.duties,
        officeCharges: input.officeCharges,
        transferCharges: input.transferCharges,
        transportFees: input.transportFees,
        totalCharges: totalCharges.toFixed(2),
        totalBales: totalBales.toFixed(3),
        additionalCostPerBale: additionalCostPerBale.toFixed(2),
        offloadedAt: new Date(`${input.offloadDate}T00:00:00.000Z`),
      })
      .returning();

    const canonicalRevision = await nextCanonicalSourceRevision(
      tx,
      input.companyId,
      "container-offload",
      String(offload.id)
    );

    for (const item of storedItems) {
      await tx.insert(schema.containerOffloadItems).values({
        offloadId: offload.id,
        stockItemId: item.stockItemId,
        quantity: item.quantity.toFixed(3),
        rate: item.rate.toFixed(2),
        totalValue: item.totalValue.toFixed(2),
        valueMoved: item.valueMoved.toFixed(2),
        cogsVariance: item.cogsVariance.toFixed(2),
      });

      // Canonical evidence for the stock this offload received, on the same
      // transaction that applied it above. The rate is the container's
      // weighted cost after charges — the value the offload actually stored —
      // so the journal and the offload line agree by construction.
      //
      // A replace-only offload re-runs against the same container, so the
      // batch takes the next revision index rather than colliding with the
      // evidence the previous offload recorded.
      if (!item.quantity.isZero()) {
        await postStockMovementTx(
          tx,
          {
            companyId: input.companyId,
            stockItemId: item.stockItemId,
            kind: "receipt",
            quantity: item.quantity.toFixed(3),
            unitCost: item.rate.toFixed(2),
            toLocationId: input.locationId,
            occurredAt: new Date().toISOString(),
            source: {
              sourceType: "container-offload",
              sourceId: String(offload.id),
              idempotencyKey: `container-offload:${offload.id}:rev${canonicalRevision}:${item.stockItemId}`,
            },
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }
    }

    // Perpetual inventory (wave 11): the cost corrections revalue the stock on hand.
    await postInventoryMovementJournalTx(tx, {
      companyId: input.companyId,
      sourceType: "offload-cost-correction",
      sourceId: offload.id,
      date: input.offloadDate,
      reference: `Container ${container.containerNumber}`,
      lines: correctionLines,
      offsetAccountCode: "INVENTORY_REVALUATION",
      narration: "Stock cost corrected at offload",
      locationId: input.locationId,
    });

    await postSupplierPartnerJournals(tx, container, purchaseOrders, input);
    // Perpetual inventory (wave 8.2): the received stock moves to the ledger.
    await syncContainerStockInTx(tx, input.companyId, input.containerId);
    if (previousBeforeCutover) {
      // Wave 15 (C1): the edit of an offload dated before the cut-over. A new
      // date before it keeps the stock out of STOCK-IN, so the whole change is
      // journalled; a new date on or after it is STOCK-IN's, so only the
      // reversal of the old receipt is.
      const newBeforeCutover = await isPreCutoverOffloadChangeTx(tx, input.companyId, input.offloadDate);
      const received = storedItems.reduce<Decimal>((sum, item) => sum.plus(item.valueMoved), new MoneyDecimal(0));
      await postPreCutoverOffloadMovementTx(tx, {
        companyId: input.companyId,
        containerId: input.containerId,
        containerNumber: container.containerNumber,
        offloadDate: previousOffloadDate,
        locationId: input.locationId,
        valueDelta: newBeforeCutover ? reversalDelta.plus(received) : reversalDelta,
        mode: "inPlace",
        reason: "Offload edited",
      });
    }

    return {
      offload,
      companyId: input.companyId,
      locationId: input.locationId,
      stockItemIds: positiveIds(storedItems.map((item) => item.stockItemId)),
      replacedExistingOffload: replacing,
    };
  });
}
