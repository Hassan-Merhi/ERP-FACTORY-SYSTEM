/**
 * employeePosFinancialRoutes: PosSaleDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { factoryBales, factoryPosSales, factoryPosSaleItems } from "@shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { removeFactoryPosCogsTx } from "../../../../services/accounting/perpetualInventory/factoryPosCogs";

export function registerPosSaleDeleteRoutes(app: Express) {
  // DELETE /api/factory/pos/sales/:id — void a factory POS sale
  app.delete("/api/factory/pos/sales/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const saleId = parseInt(req.params.id);
      const [sale] = await db
        .select()
        .from(factoryPosSales)
        .where(and(eq(factoryPosSales.id, saleId), eq(factoryPosSales.companyId, companyId)));
      if (!sale) return res.status(404).json({ message: "Sale not found" });
      if (sale.status === "VOIDED") return res.status(400).json({ message: "Sale already voided" });

      await db.transaction(async (tx) => {
        // Perpetual inventory (wave 8.4): a voided sale takes its cost-of-sales journal with it.
        await removeFactoryPosCogsTx(tx, companyId, saleId);
        // Restore bales to IN_STOCK by finding bales that were sold around the sale date/product
        const items = await tx.select().from(factoryPosSaleItems).where(eq(factoryPosSaleItems.saleId, saleId));
        for (const item of items) {
          if (item.productId && sale.locationId) {
            // Re-open the most recently SOLD bales for that product at that location
            const soldBales = await tx
              .select({ id: factoryBales.id })
              .from(factoryBales)
              .where(
                and(
                  eq(factoryBales.companyId, companyId),
                  eq(factoryBales.productId, item.productId),
                  eq(factoryBales.erpLocationId, sale.locationId),
                  eq(factoryBales.status, "SOLD")
                )
              )
              .orderBy(desc(factoryBales.id))
              .limit(item.quantity)
              .for("update");
            const baleIds = soldBales.map((b) => b.id);
            if (baleIds.length > 0) {
              await tx
                .update(factoryBales)
                .set({ status: "IN_STOCK", updatedAt: new Date() })
                .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));
            }
          }
        }
        // Mark sale as voided
        await tx.update(factoryPosSales).set({ status: "VOIDED" }).where(eq(factoryPosSales.id, saleId));
      });

      res.json({ ok: true });
    } catch (error: unknown) {
      logger.error("Error voiding factory POS sale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
