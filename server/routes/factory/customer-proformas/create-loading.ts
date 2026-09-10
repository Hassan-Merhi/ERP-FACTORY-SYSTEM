/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaLoading endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { syncProformaReservations } from "../_stockReservationHelper";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry, recalculateOrderTotals } from "../_helpers";
import {
  factoryBaleProducts,
  factoryBales,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customerOrderBales,
  customers,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";
import {
  allocateRemainingProformaLines,
  evaluateProformaLoadingAvailability,
} from "../customer-orders/proformaCapacityEnforcement";

export function registerFactoryCustomerProformaLoadingRoutes(app: Express) {
  // Create a pending loading from a proforma — auto-adds matching bales from stock
  app.post("/api/factory/customer-proformas/:id/create-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const proformaId = parseId(req.params.id);

      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
      const { locationId, orderDate } = req.body;
      if (!locationId) return res.status(400).json({ message: "locationId is required" });

      // Fetch the proforma
      const [proforma] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, proformaId), eq(customerProformas.companyId, companyId)));
      if (!proforma) return res.status(404).json({ message: "Proforma not found" });
      if (!proforma.isActive)
        return res.status(400).json({ message: "Proforma is inactive — cannot create a loading from it" });

      // Fetch proforma lines
      const lines = await db
        .select()
        .from(customerProformaLines)
        .where(eq(customerProformaLines.proformaId, proformaId));
      if (lines.length === 0)
        return res.status(400).json({ message: "Proforma has no lines — add article codes first" });

      const capacity = await getProformaCapacitySnapshot(db, { companyId, proformaId });
      if (!capacity) return res.status(404).json({ message: "Proforma not found" });
      const availability = evaluateProformaLoadingAvailability(capacity, proforma.customerId);
      if (!availability.allowed) {
        return res.status(400).json({
          message:
            availability.reason === "fully_consumed"
              ? "All proforma lines are already fully loaded. No remaining loading capacity."
              : "Proforma is not available for loading.",
          capacity: availability,
        });
      }
      const remainingAllocations = allocateRemainingProformaLines(lines, capacity);

      // Pre-fetch product names for all article codes in this proforma
      const proformaArticleCodes = [...new Set(lines.map((l) => l.articleCode).filter(Boolean))];
      const proformaProductNameMap = new Map<string, string>();
      if (proformaArticleCodes.length > 0) {
        const proformaProducts = await db
          .select({ articleCode: factoryBaleProducts.articleCode, name: factoryBaleProducts.name })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              inArray(factoryBaleProducts.articleCode, proformaArticleCodes)
            )
          );
        for (const p of proformaProducts) {
          if (p.articleCode) proformaProductNameMap.set(p.articleCode, p.name);
        }
      }

      // Create the LOADING order
      const [order] = await db
        .insert(customerOrders)
        .values({
          companyId,
          customerId: proforma.customerId,
          proformaIdUsed: proformaId,
          locationId: parseInt(locationId),
          orderDate: orderDate || getClientDate(req),
          status: "LOADING",
          loadingStartedAt: new Date(),
        })
        .returning();

      let totalBalesAdded = 0;
      const insufficientStock: string[] = [];

      for (const allocation of remainingAllocations) {
        const { line, remainingQty: remainingToLoad } = allocation;
        if (!line.articleCode || remainingToLoad <= 0) continue;

        // Find available IN_STOCK bales at this location for this article code
        const available = await db
          .select()
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.status, "IN_STOCK"),
              eq(factoryBales.erpLocationId, parseInt(locationId)),
              sql`LOWER(TRIM(COALESCE(
                NULLIF(${factoryBales.articleCode}, ''),
                (SELECT fbp.article_code FROM factory_bale_products fbp WHERE fbp.id = ${factoryBales.productId} AND fbp.company_id = ${companyId} LIMIT 1),
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
          .limit(remainingToLoad); // ← only up to the remaining reserved quantity

        if (available.length === 0) {
          insufficientStock.push(`${line.articleCode}: 0 eligible bales in stock (need ${remainingToLoad})`);
          continue;
        }

        for (const bale of available) {
          const resolvedBaleName =
            proformaProductNameMap.get(bale.articleCode || "") || bale.productName || bale.articleCode || bale.baleCode;
          const linePricingMode = line.pricingMode ?? "per_bale";
          const linePerKg = parseFloat(String(line.pricePerKg ?? "0"));
          let resolvedPriceUsed: string;
          if (linePricingMode === "per_kg" && linePerKg > 0) {
            const baleWt = parseFloat(String(bale.weightKg || "0"));
            resolvedPriceUsed = (!isNaN(baleWt) ? baleWt * linePerKg : 0).toFixed(2);
          } else {
            resolvedPriceUsed = String(line.pricePerBale ?? "0");
          }
          await db.insert(customerOrderBales).values({
            orderId: order.id,
            baleId: bale.id,
            baleReference: bale.referenceNumber,
            locationId: parseInt(locationId),
            weight: bale.weightKg,
            articleCode: bale.articleCode,
            baleName: resolvedBaleName,
            priceUsed: resolvedPriceUsed,
          });
          // Transition bale: IN_STOCK → RESERVED_FOR_ORDER (physically in a loading order now)
          await db
            .update(factoryBales)
            .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
            .where(eq(factoryBales.id, bale.id));
          totalBalesAdded++;
        }
      }

      await recalculateOrderTotals(db, order.id);

      // Sync reservations — loading consumed some of the reservation, update the table
      // reservedQty per article = max(0, lineQty - totalLoaded across ALL active orders for this proforma)
      await syncProformaReservations(db, companyId, proformaId);

      const [loadingCustomer] = await db
        .select({ legalName: customers.legalName })
        .from(customers)
        .where(eq(customers.id, proforma.customerId));
      const insufficientNote = insufficientStock.length > 0 ? ` (${insufficientStock.join(", ")})` : "";
      await writeDaybookEntry(db, {
        companyId,
        txDate: orderDate || getClientDate(req),
        txType: "LOADING_CREATED",
        referenceId: order.id,
        referenceTable: "customer_orders",
        description: `Loading created from proforma "${proforma.name}" for ${loadingCustomer?.legalName || "customer"} — ${totalBalesAdded} bale(s) added${insufficientNote}`,
      });

      res.json({
        order,
        balesAdded: totalBalesAdded,
        ...(insufficientStock.length > 0 ? { warnings: insufficientStock } : {}),
      });
    } catch (error: unknown) {
      logger.error("Error creating loading from proforma:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
