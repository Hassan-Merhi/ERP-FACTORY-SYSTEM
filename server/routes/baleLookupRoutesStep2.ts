// Extracted from ./baleLookupRoutes.ts: a stage of baleLookupRoutes.
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  customerOrderBales,
  customerOrders,
  customers,
  factoryBales,
  factoryContainers,
  factoryMixBatchSources,
  factoryMixBatches,
  factoryPressingBatches,
  factorySuppliers,
  factoryWorkers,
  locations,
} from "@shared/schema";
import type { baleLookupRoutesStep, BaleLookupInfo } from "./baleLookupRoutesStep";
import type { Response } from "express";

type BaleLookupRoutesStepResult = Awaited<ReturnType<typeof baleLookupRoutesStep>>;

export async function baleLookupRoutesStep2({
  blr1,
  res,
}: {
  blr1: Extract<BaleLookupRoutesStepResult, { done: false }>;
  res: Response;
}) {
  const { labelPrint, companyId, normalizedBaleReferenceMatch, referenceNumber, bookingInfoVisible } = blr1;
  let baleInfo: BaleLookupInfo | null = null;
  let locationInfo = null;
  let pressingBatch = null;
  let mixBatch = null;
  let containers_used: unknown[] = [];

  if (labelPrint.productionBaleId) {
    [blr1.factoryBale] = await db
      .select()
      .from(factoryBales)
      .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, labelPrint.productionBaleId)))
      .limit(1);
  }

  if (!blr1.factoryBale) {
    const fallbackFactoryBales = await db
      .select()
      .from(factoryBales)
      .where(and(eq(factoryBales.companyId, companyId), normalizedBaleReferenceMatch))
      .limit(2);

    if (fallbackFactoryBales.length > 1) {
      return {
        done: true as const,
        value: res.status(409).json({ message: "Reference number not found", code: "AMBIGUOUS_REFERENCE" }),
      };
    }
    blr1.factoryBale = fallbackFactoryBales[0];
  }

  if (blr1.factoryBale) {
    // Use the name stored on the bale row directly — this matches what the bale history page shows.
    const resolvedProductName = blr1.factoryBale.productName;

    // Use stored workerName first (denormalized); fall back to join if not yet populated
    let workerName: string | null = blr1.factoryBale.workerName ?? null;
    if (!workerName && blr1.factoryBale.finalizedBy) {
      const [wk] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(eq(factoryWorkers.id, blr1.factoryBale.finalizedBy))
        .limit(1);
      if (wk) workerName = wk.fullName;
    }

    baleInfo = {
      id: blr1.factoryBale.id,
      baleCode: blr1.factoryBale.baleCode,
      productName: resolvedProductName,
      status: blr1.factoryBale.status,
      weightKg: blr1.factoryBale.weightKg,
      costPerKg: blr1.factoryBale.costPerKg,
      totalCost: blr1.factoryBale.totalCost,
      grade: blr1.factoryBale.grade,
      stockEntryDate: blr1.factoryBale.stockEntryDate,
      pressedAt: blr1.factoryBale.pressedAt,
      finalizedAt: blr1.factoryBale.finalizedAt,
      workerName,
      createdAt: blr1.factoryBale.createdAt,
      updatedAt: blr1.factoryBale.updatedAt,
      deletedAt: blr1.factoryBale.deletedAt,
    };

    // Get location
    if (blr1.factoryBale.erpLocationId) {
      const [loc] = await db
        .select({ id: locations.id, name: locations.name, city: locations.city, state: locations.state })
        .from(locations)
        .where(eq(locations.id, blr1.factoryBale.erpLocationId))
        .limit(1);
      if (loc) locationInfo = loc;
    }

    // Get pressing batch
    if (blr1.factoryBale.pressingBatchId) {
      const [pb] = await db
        .select()
        .from(factoryPressingBatches)
        .where(eq(factoryPressingBatches.id, blr1.factoryBale.pressingBatchId))
        .limit(1);
      if (pb) {
        pressingBatch = {
          id: pb.id,
          status: pb.status,
          expectedCount: pb.expectedCount,
          finalizedAt: pb.finalizedAt,
          notes: pb.notes,
        };

        // Get mix batch
        if (pb.mixBatchId) {
          const [mb] = await db
            .select()
            .from(factoryMixBatches)
            .where(eq(factoryMixBatches.id, pb.mixBatchId))
            .limit(1);
          if (mb) {
            mixBatch = {
              id: mb.id,
              batchCode: mb.batchCode,
              batchNumber: mb.batchNumber,
              name: mb.name,
              batchDate: mb.batchDate,
              totalWeightKg: mb.totalWeightKg,
              costPerKg: mb.costPerKg,
              status: mb.status,
              operatorUser: mb.operatorUser,
            };

            // Get container sources for this mix batch
            const sources = await db
              .select()
              .from(factoryMixBatchSources)
              .where(eq(factoryMixBatchSources.mixBatchId, mb.id));

            const containerIds = [...new Set(sources.filter((s) => s.containerId).map((s) => s.containerId!))];
            if (containerIds.length > 0) {
              const containerRows = await db
                .select()
                .from(factoryContainers)
                .where(inArray(factoryContainers.id, containerIds));

              const supplierIds = [...new Set(containerRows.filter((c) => c.supplierId).map((c) => c.supplierId!))];
              const supplierRows =
                supplierIds.length > 0
                  ? await db.select().from(factorySuppliers).where(inArray(factorySuppliers.id, supplierIds))
                  : [];
              const supplierMap = new Map(supplierRows.map((s) => [s.id, s.name]));

              containers_used = containerRows.map((c) => {
                const src = sources.find((s) => s.containerId === c.id);
                return {
                  id: c.id,
                  containerNumber: c.containerNumber,
                  origin: c.origin,
                  arrivalDate: c.arrivalDate,
                  status: c.status,
                  supplierName: c.supplierId ? supplierMap.get(c.supplierId) || null : null,
                  weightKgUsed: src?.weightKg || null,
                  currencyCode: c.currencyCode,
                  ratePerKg: c.ratePerKg,
                };
              });
            }
          }
        }
      }
    }
  }

  // ── Check if this bale was loaded onto an outbound customer order ──
  // Fetch ALL assignments for this bale reference and pick the best-status one.
  // A bale can appear in multiple orders (e.g. moved from a cancelled order to a
  // finalized invoice). Deleted orders are historical only and are excluded.
  const statusPriority: Record<string, number> = {
    FINALIZED: 0,
    SOLD: 1,
    DISPATCHED: 2,
    VERIFIED: 3,
    PENDING_VERIFICATION: 4,
    LOADING: 5,
    DRAFT: 6,
    CANCELLED: 7,
  };
  let loadedOnOrder = null;
  const orderBaleRows = await db
    .select()
    .from(customerOrderBales)
    .where(sql`LOWER(TRIM(${customerOrderBales.baleReference})) = LOWER(TRIM(${referenceNumber}))`);

  if (orderBaleRows.length > 0) {
    // Fetch all matching non-deleted orders for the current company in one query.
    const orderIds = [...new Set(orderBaleRows.map((r) => r.orderId))];
    const orders = await db
      .select()
      .from(customerOrders)
      .leftJoin(customers, eq(customerOrders.customerId, customers.id))
      .where(
        and(
          inArray(customerOrders.id, orderIds),
          eq(customerOrders.companyId, companyId),
          isNull(customerOrders.deletedAt)
        )
      );

    if (orders.length > 0) {
      // Pick the order with the best (lowest priority number) status
      const bestOrder = orders.sort((a, b) => {
        const pa = statusPriority[a.customer_orders.status] ?? 99;
        const pb = statusPriority[b.customer_orders.status] ?? 99;
        return pa - pb;
      })[0];
      const matchingBaleRow = orderBaleRows.find((r) => r.orderId === bestOrder.customer_orders.id);
      if (matchingBaleRow) {
        loadedOnOrder = {
          orderId: bestOrder.customer_orders.id,
          invoiceNumber: bestOrder.customer_orders.invoiceNumber,
          orderDate: bestOrder.customer_orders.orderDate,
          status: bestOrder.customer_orders.status,
          containerNumber: bestOrder.customer_orders.containerNumber,
          shippingCompany: bestOrder.customer_orders.shippingCompany,
          containerNotes: bestOrder.customer_orders.containerNotes,
          destination: bestOrder.customer_orders.destination,
          bookingInfo: bookingInfoVisible ? bestOrder.customer_orders.bookingInfo : null,
          canViewBookingInfo: bookingInfoVisible,
          loadingStartedAt: bestOrder.customer_orders.loadingStartedAt,
          loadingFinalizedAt: bestOrder.customer_orders.loadingFinalizedAt,
          grandTotal: bestOrder.customer_orders.grandTotal,
          totalQtyBales: bestOrder.customer_orders.totalQtyBales,
          customerName: bestOrder.customers?.legalName || null,
          priceUsed: matchingBaleRow.priceUsed,
          baleWeight: matchingBaleRow.weight,
          scannedBy: matchingBaleRow.scannedBy || null,
        };
      }
    }
  }

  // Mark isInLoadingOrder on baleInfo so callers (e.g. Ground Scan) can show the right status
  if (baleInfo && loadedOnOrder?.status === "LOADING") {
    baleInfo.isInLoadingOrder = true;
  }

  return { done: false as const, loadedOnOrder, baleInfo, locationInfo, pressingBatch, mixBatch, containers_used };
}
