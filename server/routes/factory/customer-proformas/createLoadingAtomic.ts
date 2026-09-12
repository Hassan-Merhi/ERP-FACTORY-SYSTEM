import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../db";
import { writeDaybookEntry, recalculateOrderTotals } from "../_helpers";
import { syncProformaReservations } from "../_stockReservationHelper";
import {
  factoryBaleProducts,
  factoryBales,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customerOrderBales,
  customers,
} from "@shared/schema";
import { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "../customer-orders/proformaCapacityConcurrency";
import {
  allocateRemainingProformaLines,
  evaluateProformaLoadingAvailability,
} from "../customer-orders/proformaCapacityEnforcement";

export class CreateLoadingFromProformaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CreateLoadingFromProformaError";
  }
}

export interface CreateLoadingFromProformaInput {
  companyId: number;
  proformaId: number;
  locationId: number;
  orderDate: string;
}

/**
 * Create a loading and consume matching physical bales as one serialized
 * transaction. The proforma advisory lock is acquired before any bale row lock,
 * so another scanner/import/create-loading for the same proforma must wait and
 * then re-read the new remaining capacity.
 */
export async function createLoadingFromProformaAtomically(input: CreateLoadingFromProformaInput) {
  return db.transaction(async (tx) => {
    await acquireProformaCapacityTransactionLock(tx, {
      companyId: input.companyId,
      proformaId: input.proformaId,
    });

    const [proforma] = await tx
      .select()
      .from(customerProformas)
      .where(and(eq(customerProformas.id, input.proformaId), eq(customerProformas.companyId, input.companyId)))
      .limit(1);
    if (!proforma) throw new CreateLoadingFromProformaError("Proforma not found", 404);
    if (!proforma.isActive) {
      throw new CreateLoadingFromProformaError("Proforma is inactive — cannot create a loading from it");
    }

    const lines = await tx
      .select()
      .from(customerProformaLines)
      .where(eq(customerProformaLines.proformaId, input.proformaId));
    if (lines.length === 0) {
      throw new CreateLoadingFromProformaError("Proforma has no lines — add article codes first");
    }

    const capacity = await getProformaCapacitySnapshot(tx, {
      companyId: input.companyId,
      proformaId: input.proformaId,
    });
    if (!capacity) throw new CreateLoadingFromProformaError("Proforma not found", 404);

    const availability = evaluateProformaLoadingAvailability(capacity, proforma.customerId);
    if (!availability.allowed) {
      throw new CreateLoadingFromProformaError(
        availability.reason === "fully_consumed"
          ? "All proforma lines are already fully loaded. No remaining loading capacity."
          : "Proforma is not available for loading.",
        400,
        { capacity: availability }
      );
    }

    const remainingAllocations = allocateRemainingProformaLines(lines, capacity);
    const proformaArticleCodes = [...new Set(lines.map((line) => line.articleCode).filter(Boolean))];
    const proformaProductNameMap = new Map<string, string>();
    if (proformaArticleCodes.length > 0) {
      const proformaProducts = await tx
        .select({ articleCode: factoryBaleProducts.articleCode, name: factoryBaleProducts.name })
        .from(factoryBaleProducts)
        .where(
          and(
            eq(factoryBaleProducts.companyId, input.companyId),
            inArray(factoryBaleProducts.articleCode, proformaArticleCodes)
          )
        );
      for (const product of proformaProducts) {
        if (product.articleCode) proformaProductNameMap.set(product.articleCode, product.name);
      }
    }

    const [order] = await tx
      .insert(customerOrders)
      .values({
        companyId: input.companyId,
        customerId: proforma.customerId,
        proformaIdUsed: input.proformaId,
        locationId: input.locationId,
        orderDate: input.orderDate,
        status: "LOADING",
        loadingStartedAt: new Date(),
      })
      .returning();

    let totalBalesAdded = 0;
    const insufficientStock: string[] = [];

    for (const allocation of remainingAllocations) {
      const { line, remainingQty: remainingToLoad } = allocation;
      if (!line.articleCode || remainingToLoad <= 0) continue;

      // Lock the physical candidates while the proforma lock is held. This
      // protects against a concurrent non-proforma sale/exchange selecting the
      // same IN_STOCK bale while this transaction is building the loading.
      const available = await tx
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, input.companyId),
            eq(factoryBales.status, "IN_STOCK"),
            eq(factoryBales.erpLocationId, input.locationId),
            sql`LOWER(TRIM(COALESCE(
              NULLIF(${factoryBales.articleCode}, ''),
              (SELECT fbp.article_code FROM factory_bale_products fbp WHERE fbp.id = ${factoryBales.productId} AND fbp.company_id = ${input.companyId} LIMIT 1),
              ''
            ))) = ${allocation.normalizedArticleCode}`,
            sql`NOT EXISTS (
              SELECT 1
              FROM customer_order_bales existing_cob
              JOIN customer_orders existing_co ON existing_co.id = existing_cob.order_id
              WHERE existing_cob.bale_id = ${factoryBales.id}
                AND existing_co.status <> 'CANCELLED'
                AND existing_co.deleted_at IS NULL
            )`
          )
        )
        .orderBy(factoryBales.id)
        .limit(remainingToLoad)
        .for("update");

      if (available.length === 0) {
        insufficientStock.push(`${line.articleCode}: 0 eligible bales in stock (need ${remainingToLoad})`);
        continue;
      }

      for (const bale of available) {
        const resolvedBaleName =
          proformaProductNameMap.get(bale.articleCode || "") || bale.productName || bale.articleCode || bale.baleCode;
        const linePricingMode = line.pricingMode ?? "per_bale";
        const linePerKg = parseFloat(String(line.pricePerKg ?? "0"));
        const resolvedPriceUsed =
          linePricingMode === "per_kg" && linePerKg > 0
            ? ((parseFloat(String(bale.weightKg || "0")) || 0) * linePerKg).toFixed(2)
            : String(line.pricePerBale ?? "0");

        await tx.insert(customerOrderBales).values({
          orderId: order.id,
          baleId: bale.id,
          baleReference: bale.referenceNumber,
          locationId: input.locationId,
          weight: bale.weightKg,
          articleCode: bale.articleCode,
          baleName: resolvedBaleName,
          priceUsed: resolvedPriceUsed,
        });
        await tx
          .update(factoryBales)
          .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
          .where(eq(factoryBales.id, bale.id));
        totalBalesAdded++;
      }

      if (available.length < remainingToLoad) {
        insufficientStock.push(
          `${line.articleCode}: ${available.length} eligible bale(s) in stock (need ${remainingToLoad})`
        );
      }
    }

    await recalculateOrderTotals(tx, order.id);
    await syncProformaReservations(tx, input.companyId, input.proformaId);

    const [loadingCustomer] = await tx
      .select({ legalName: customers.legalName })
      .from(customers)
      .where(eq(customers.id, proforma.customerId));
    const insufficientNote = insufficientStock.length > 0 ? ` (${insufficientStock.join(", ")})` : "";
    await writeDaybookEntry(tx, {
      companyId: input.companyId,
      txDate: input.orderDate,
      txType: "LOADING_CREATED",
      referenceId: order.id,
      referenceTable: "customer_orders",
      description: `Loading created from proforma "${proforma.name}" for ${loadingCustomer?.legalName || "customer"} — ${totalBalesAdded} bale(s) added${insufficientNote}`,
    });

    return {
      order,
      balesAdded: totalBalesAdded,
      ...(insufficientStock.length > 0 ? { warnings: insufficientStock } : {}),
    };
  });
}
