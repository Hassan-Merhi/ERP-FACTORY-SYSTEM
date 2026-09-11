/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaLine endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { syncProformaReservations, isFactoryV2Company, computeFreeToPromise } from "../_stockReservationHelper";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { recalculateOrderTotals } from "../_helpers";
import {
  factoryBaleProducts,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customerOrderBales,
  insertCustomerProformaLineSchema,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { autoSavePriceToPriceList } from "./_helpers";

export function registerFactoryCustomerProformaLineRoutes(app: Express) {
  app.post("/api/factory/customer-proforma-lines", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const parsed = insertCustomerProformaLineSchema.parse(req.body);

      const [existingLine] = await db
        .select()
        .from(customerProformaLines)
        .where(
          and(
            eq(customerProformaLines.proformaId, parsed.proformaId),
            sql`LOWER(TRIM(${customerProformaLines.articleCode})) = ${parsed.articleCode.trim().toLowerCase()}`
          )
        );
      if (existingLine) return res.status(400).json({ message: "Article code already exists in this proforma" });

      // factory_v2: warn if requested quantity exceeds free-to-promise (non-blocking)
      let stockWarning: string | undefined;
      if (await isFactoryV2Company(companyId)) {
        const ftp = await computeFreeToPromise(companyId, parsed.articleCode);
        if ((parsed.quantity ?? 0) > ftp) {
          stockWarning = `Insufficient free stock for ${parsed.articleCode}: requested ${parsed.quantity}, available ${ftp}`;
        }
      }

      const [line] = await db.insert(customerProformaLines).values(parsed).returning();
      // Sync — new line changes reservedNotYetLoaded for this proforma
      await syncProformaReservations(db, companyId, parsed.proformaId);

      // Auto-save price to customer price list
      const [proforma] = await db
        .select({ customerId: customerProformas.customerId })
        .from(customerProformas)
        .where(eq(customerProformas.id, parsed.proformaId))
        .limit(1);
      if (proforma?.customerId && parsed.articleCode && parsed.pricePerBale) {
        await autoSavePriceToPriceList(companyId, proforma.customerId, parsed.articleCode, parsed.pricePerBale).catch(
          () => {}
        );
      }

      res.json({ ...line, ...(stockWarning ? { stockWarning } : {}) });
    } catch (error: unknown) {
      logger.error("Error creating proforma line:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/factory/customer-proforma-lines/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      // Fetch the line first to get its proformaId
      const [existingLine] = await db
        .select()
        .from(customerProformaLines)
        .where(eq(customerProformaLines.id, id))
        .limit(1);
      if (!existingLine) return res.status(404).json({ message: "Proforma line not found" });

      const updateData: Partial<
        Pick<
          typeof customerProformaLines.$inferInsert,
          "productName" | "quantity" | "pricePerBale" | "pricingMode" | "pricePerKg"
        >
      > = {};
      if (req.body.productName !== undefined) updateData.productName = req.body.productName;
      if (req.body.quantity !== undefined) updateData.quantity = parseInt(req.body.quantity);
      if (req.body.pricePerBale !== undefined) updateData.pricePerBale = req.body.pricePerBale;
      if (req.body.pricingMode !== undefined) updateData.pricingMode = req.body.pricingMode;
      if (req.body.pricePerKg !== undefined) updateData.pricePerKg = req.body.pricePerKg ?? null;

      // Auto-save weight to factoryBaleProducts so stock allocation stays in sync
      const newWeightPerBaleKg = req.body.weightPerBaleKg;
      if (newWeightPerBaleKg !== undefined && newWeightPerBaleKg !== "" && existingLine.articleCode) {
        await db
          .update(factoryBaleProducts)
          .set({ weightPerBaleKg: String(newWeightPerBaleKg) })
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              eq(factoryBaleProducts.articleCode, existingLine.articleCode)
            )
          );
      }

      // factory_v2: warn if quantity increase exceeds free-to-promise (non-blocking)
      let stockWarning: string | undefined;
      if (updateData.quantity !== undefined && (await isFactoryV2Company(companyId))) {
        const delta = updateData.quantity - Number(existingLine.quantity);
        if (delta > 0) {
          const ftp = await computeFreeToPromise(companyId, existingLine.articleCode);
          if (delta > ftp) {
            stockWarning = `Insufficient free stock for ${existingLine.articleCode}: need ${delta} more, available ${ftp}`;
          }
        }
      }

      if (updateData.quantity !== undefined) {
        logger.info(
          `[proforma-line PUT] lineId=${id} proformaId=${existingLine.proformaId} articleCode=${existingLine.articleCode} oldQty=${existingLine.quantity} newQty=${updateData.quantity}`
        );
      }

      const [updated] = await db
        .update(customerProformaLines)
        .set(updateData)
        .where(eq(customerProformaLines.id, id))
        .returning();

      if (!updated) return res.status(404).json({ message: "Proforma line not found" });
      // Sync — quantity change alters reservedNotYetLoaded
      await syncProformaReservations(db, companyId, existingLine.proformaId);

      // Auto-save price to customer price list if price was part of the update
      if (updateData.pricePerBale !== undefined && existingLine.articleCode) {
        const [proforma] = await db
          .select({ customerId: customerProformas.customerId })
          .from(customerProformas)
          .where(eq(customerProformas.id, existingLine.proformaId))
          .limit(1);
        if (proforma?.customerId) {
          await autoSavePriceToPriceList(
            companyId,
            proforma.customerId,
            existingLine.articleCode,
            updateData.pricePerBale
          ).catch(() => {});
        }
      }

      // Auto-reprice active orders: when pricingMode or pricePerKg changes on a proforma line,
      // immediately update price_used on all matching bales in LOADING/PENDING_VERIFICATION orders
      // and recalculate order totals so the list view shows the correct amount without a manual repair.
      const pricingChanged =
        updateData.pricingMode !== undefined ||
        updateData.pricePerKg !== undefined ||
        (newWeightPerBaleKg !== undefined && newWeightPerBaleKg !== "");
      if (pricingChanged && existingLine.articleCode) {
        try {
          const effectivePricingMode = updateData.pricingMode ?? updated.pricingMode ?? "per_bale";
          const effectivePricePerKg = updateData.pricePerKg ?? updated.pricePerKg ?? null;
          if (effectivePricingMode === "per_kg" && effectivePricePerKg) {
            const pkgRate = parseFloat(String(effectivePricePerKg));
            if (pkgRate > 0) {
              // Find active orders that use this proforma
              const activeOrders = await db
                .select({ id: customerOrders.id })
                .from(customerOrders)
                .where(
                  and(
                    eq(customerOrders.proformaIdUsed, existingLine.proformaId),
                    sql`${customerOrders.status} IN ('LOADING', 'PENDING_VERIFICATION')`
                  )
                );
              for (const order of activeOrders) {
                // Fetch bales for this article in this order
                const bales = await db
                  .select({ id: customerOrderBales.id, weight: customerOrderBales.weight })
                  .from(customerOrderBales)
                  .where(
                    and(
                      eq(customerOrderBales.orderId, order.id),
                      eq(customerOrderBales.articleCode, existingLine.articleCode)
                    )
                  );
                for (const bale of bales) {
                  const wt = parseFloat(String(bale.weight || "0"));
                  if (!isNaN(wt) && wt > 0) {
                    await db
                      .update(customerOrderBales)
                      .set({ priceUsed: (wt * pkgRate).toFixed(2) })
                      .where(eq(customerOrderBales.id, bale.id));
                  }
                }
                await recalculateOrderTotals(db, order.id);
              }
            }
          }
        } catch (_e) {
          /* non-blocking */
        }
      }

      res.json({ ...updated, ...(stockWarning ? { stockWarning } : {}) });
    } catch (error: unknown) {
      logger.error("Error updating proforma line:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customer-proforma-lines/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      // Fetch the line first to get its proformaId before deletion
      const [lineToDelete] = await db
        .select()
        .from(customerProformaLines)
        .where(eq(customerProformaLines.id, id))
        .limit(1);
      if (!lineToDelete) return res.status(404).json({ message: "Proforma line not found" });

      const [deleted] = await db.delete(customerProformaLines).where(eq(customerProformaLines.id, id)).returning();
      if (!deleted) return res.status(404).json({ message: "Proforma line not found" });
      // Sync — removed line releases its reservation
      await syncProformaReservations(db, companyId, lineToDelete.proformaId);
      res.json({ message: "Proforma line deleted" });
    } catch (error: unknown) {
      logger.error("Error deleting proforma line:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
