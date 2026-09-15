import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db";
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

/** The inventory row an offload locks FOR UPDATE before rewriting its cost. */
type InventoryLockRow = { id: number; quantity: string; total_value: string };

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export async function executeContainerOffloadLifecycle(
  input: ContainerOffloadLifecycleInput
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

    if (existingOffload) {
      await reverseExistingOffload(tx, container, existingOffload, lineItems);
    }

    const itemMap = buildItemMap(lineItems);
    const totalBales = [...itemMap.values()].reduce((sum, item) => sum + item.totalQuantity, 0);
    if (totalBales <= 0) {
      throw new ContainerOffloadLifecycleError(
        "Container has no positive stock quantity to offload.",
        400,
        "CONTAINER_OFFLOAD_ZERO_QUANTITY"
      );
    }

    const additionalCharges = input.additionalCharges ?? [];
    const totalCharges =
      amount(input.duties) +
      amount(input.officeCharges) +
      amount(input.transferCharges) +
      amount(input.transportFees) +
      additionalCharges.reduce((sum, charge) => sum + charge.amount, 0) +
      amount(container.chargesTotal);
    const additionalCostPerBale = Math.round((totalCharges / totalBales) * 100) / 100;
    const roundingDifference = Math.round((totalCharges - additionalCostPerBale * totalBales) * 100) / 100;
    const storedItems: Array<{ stockItemId: number; quantity: number; rate: number; totalValue: number }> = [];
    const entries = [...itemMap.entries()];

    const validCorrectionIds = new Set(itemMap.keys());
    for (const correction of input.inventoryCostCorrections ?? []) {
      if (correction.correctRate <= 0 || !validCorrectionIds.has(correction.stockItemId)) continue;
      const correctionRows = await tx.execute(
        sql`SELECT * FROM inventory WHERE location_id = ${input.locationId} AND stock_item_id = ${correction.stockItemId} FOR UPDATE`
      );
      const row = firstRow<InventoryLockRow>(correctionRows);
      if (!row) continue;
      const existingQuantity = amount(row.quantity);
      if (existingQuantity <= 0) continue;
      await tx
        .update(schema.inventory)
        .set({
          averageRate: correction.correctRate.toFixed(2),
          totalValue: (existingQuantity * correction.correctRate).toFixed(2),
          lastUpdated: new Date(),
        })
        .where(eq(schema.inventory.id, row.id));
    }

    for (let index = 0; index < entries.length; index += 1) {
      const [stockItemId, item] = entries[index];
      if (item.totalQuantity === 0) continue;
      const originalRate = item.weightedRateSum / item.totalQuantity;
      const newRate = originalRate + additionalCostPerBale;
      let valueCents = Math.round(item.totalQuantity * newRate * 100);
      if (index === entries.length - 1 && roundingDifference !== 0) {
        valueCents += Math.round(roundingDifference * 100);
      }
      const offloadValue = valueCents / 100;
      const adjustedRate = offloadValue / item.totalQuantity;
      if (!Number.isFinite(adjustedRate)) {
        throw new ContainerOffloadLifecycleError(
          `Calculated rate is invalid for stock item ${stockItemId}.`,
          409,
          "CONTAINER_OFFLOAD_RATE_INVALID"
        );
      }

      storedItems.push({
        stockItemId,
        quantity: item.totalQuantity,
        rate: adjustedRate,
        totalValue: offloadValue,
      });

      const inventoryRows = await tx.execute(
        sql`SELECT * FROM inventory WHERE location_id = ${input.locationId} AND stock_item_id = ${stockItemId} FOR UPDATE`
      );
      const current = firstRow<InventoryLockRow>(inventoryRows);
      if (current) {
        const currentQuantity = amount(current.quantity);
        const currentValue = amount(current.total_value);
        const nextQuantity = currentQuantity + item.totalQuantity;
        let nextValue: number;
        if (nextQuantity === 0) {
          nextValue = 0;
        } else if (nextQuantity < 0) {
          nextValue = nextQuantity * adjustedRate;
        } else if (currentQuantity < 0) {
          nextValue = nextQuantity * Math.max(adjustedRate, 0);
        } else {
          nextValue = currentValue + offloadValue;
          if (nextValue < 0) nextValue = nextQuantity * Math.max(adjustedRate, 0);
        }
        const nextRate = nextQuantity > 0 ? nextValue / nextQuantity : adjustedRate;
        if (!Number.isFinite(nextRate)) {
          throw new ContainerOffloadLifecycleError(
            `Calculated weighted rate is invalid for stock item ${stockItemId}.`,
            409,
            "CONTAINER_OFFLOAD_WEIGHTED_RATE_INVALID"
          );
        }
        await tx
          .update(schema.inventory)
          .set({
            quantity: nextQuantity.toString(),
            averageRate: nextRate.toFixed(2),
            totalValue: nextValue.toFixed(2),
            lastUpdated: new Date(),
          })
          .where(eq(schema.inventory.id, current.id));
      } else {
        await tx.insert(schema.inventory).values({
          companyId: input.companyId,
          locationId: input.locationId,
          stockItemId,
          quantity: item.totalQuantity.toString(),
          averageRate: adjustedRate.toFixed(2),
          totalValue: offloadValue.toFixed(2),
          lastUpdated: new Date(),
        });
      }
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
      });

      // Canonical evidence for the stock this offload received, on the same
      // transaction that applied it above. The rate is the container's
      // weighted cost after charges — the value the offload actually stored —
      // so the journal and the offload line agree by construction.
      //
      // A replace-only offload re-runs against the same container, so the
      // batch takes the next revision index rather than colliding with the
      // evidence the previous offload recorded.
      if (item.quantity !== 0) {
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

    await postSupplierPartnerJournals(tx, container, purchaseOrders, input);

    return {
      offload,
      companyId: input.companyId,
      locationId: input.locationId,
      stockItemIds: positiveIds(storedItems.map((item) => item.stockItemId)),
      replacedExistingOffload: replacing,
    };
  });
}
