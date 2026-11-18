// Extracted from ./execute.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import * as schema from "@shared/schema";
import { buildItemMap, ContainerOffloadLifecycleError, ContainerOffloadLifecycleInput } from "./types";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type { InventoryMovementLine } from "../../accounting/perpetualInventory/inventoryMovementJournal";
import { isPreCutoverOffloadChangeTx } from "../../accounting/perpetualInventory/stockReceipts";
import {
  OFFLOAD_BEFORE_CUTOVER_CODE,
  OFFLOAD_BEFORE_CUTOVER_MESSAGE,
  assertOffloadCurrencyValuedTx,
  offloadBookedDate,
  type OffloadCostCorrectionApprover,
} from "./assertOffloadCurrencyValuedTx";

export async function executeContainerOffloadLifecycleTxStep1(
  tx: DbTransaction,
  input: ContainerOffloadLifecycleInput & OffloadCostCorrectionApprover
) {
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
  const persistedLines = await tx
    .select({
      poId: schema.poLineItems.poId,
      stockItemId: schema.poLineItems.stockItemId,
      quantity: schema.poLineItems.quantity,
      rate: schema.poLineItems.rate,
      lineTotal: schema.poLineItems.lineTotal,
    })
    .from(schema.poLineItems)
    .where(inArray(schema.poLineItems.poId, poIds));
  // For approved ZMW POs, the base unit rate is rounded to cents for the
  // legacy price column, but lineTotal is the authoritative historical USD
  // value (original native line total / locked FX, rounded once). Offloading
  // qty * rounded unit rate would invent/destroy cents; derive a sufficiently
  // precise effective USD rate from the stored base line amount instead.
  const valuedZmwPoIds = new Set(
    purchaseOrders
      .filter(
        (po) => String(po.currency).toUpperCase() === "ZMW" && !!po.historicalExchangeRate && !!po.nativeItemsTotal
      )
      .map((po) => po.id)
  );
  const lineItems = persistedLines.map((row) => ({
    stockItemId: row.stockItemId,
    quantity: row.quantity,
    rate:
      valuedZmwPoIds.has(row.poId) && toMoney(row.quantity).gt(0)
        ? toMoney(row.lineTotal).div(toMoney(row.quantity)).toFixed(18)
        : row.rate,
  }));
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
  return {
    additionalCostPerBale,
    container,
    correctionLines,
    entries,
    existingOffload,
    lineItems,
    previousBeforeCutover,
    previousOffloadDate,
    purchaseOrders,
    replacing,
    requestsCorrection,
    roundingDifference,
    storedItems,
    totalBales,
    totalCharges,
    validCorrectionIds,
  };
}
