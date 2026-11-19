/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId, parseOptionalId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { resultRows } from "../../../lib/queryResult";
import { syncProformaReservations } from "../_stockReservationHelper";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBaleProducts,
  customerProformas,
  customerProformaLines,
  customers,
  proformaStockReservations,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";
import { normalizeLoadingArticleCode } from "../customer-orders/bale-scanning/proformaScanPolicy";
import { normalizeProformaDestination } from "./destination";
import {
  registerFactoryCustomerProformaCrudRoutesPart1,
  type ProformaLineRow,
} from "./registerFactoryCustomerProformaCrudRoutesPart1";

export function registerFactoryCustomerProformaCrudRoutes(app: Express) {
  // Authoritative capacity read contract. Keep the summary list compact; screens
  // that need live progress fetch this one snapshot instead of re-deriving it.
  app.get("/api/factory/customer-proformas/:id/capacity", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const proformaId = parseId(req.params.id);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });
      const currentOrderId = parseOptionalId(req.query.currentOrderId);
      if (req.query.currentOrderId !== undefined && req.query.currentOrderId !== "" && currentOrderId === null) {
        return res.status(400).json({ message: "Invalid currentOrderId" });
      }

      const snapshot = await getProformaCapacitySnapshot(db, { companyId, proformaId, currentOrderId });
      if (!snapshot) return res.status(404).json({ message: "Proforma not found" });

      const sourceLines = await db
        .select({ articleCode: customerProformaLines.articleCode, productName: customerProformaLines.productName })
        .from(customerProformaLines)
        .where(eq(customerProformaLines.proformaId, proformaId));
      const productNames = new Map<string, string>();
      for (const line of sourceLines) {
        const normalized = normalizeLoadingArticleCode(line.articleCode);
        const name = String(line.productName || "").trim();
        if (normalized && name && !productNames.has(normalized)) productNames.set(normalized, name);
      }

      res.set("Cache-Control", "private, no-store");
      return res.json({
        ...snapshot,
        articles: snapshot.articles.map((article) => ({
          ...article,
          productName: productNames.get(article.normalizedArticleCode) || article.articleCode,
        })),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  /* Single proforma by ID — used by EditProformaV5Drawer and lazy detail readers. */
  app.get("/api/factory/customer-proformas/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const rawProformaRes = await db.execute(
        sql`SELECT * FROM customer_proformas WHERE id = ${id} AND company_id = ${companyId} AND deleted_at IS NULL LIMIT 1`
      );
      const rawProformaRows = rawProformaRes.rows ?? (rawProformaRes as unknown as unknown[]);
      if (!rawProformaRows.length) return res.status(404).json({ message: "Proforma not found" });
      const pr = rawProformaRows[0];
      const proforma = {
        id: pr.id,
        companyId: pr.company_id,
        customerId: pr.customer_id,
        name: pr.name ?? "",
        destination: pr.destination ?? null,
        isActive: pr.is_active ?? false,
        deletedAt: pr.deleted_at ?? null,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at ?? pr.created_at,
      };
      const rawLinesRes = await db.execute(sql`SELECT * FROM customer_proforma_lines WHERE proforma_id = ${id}`);
      const lines = resultRows<ProformaLineRow>(rawLinesRes).map((l) => ({
        id: l.id,
        proformaId: l.proforma_id,
        articleCode: l.article_code ?? "",
        productName: l.product_name ?? "",
        quantity: Number(l.quantity) || 0,
        pricePerBale: l.price_per_bale ?? "0",
        productionPricePerBale: l.production_price_per_bale ?? "0",
        priceFixed: l.price_fixed ?? false,
        pricingMode: l.pricing_mode ?? "per_bale",
        pricePerKg: l.price_per_kg ?? null,
        createdAt: l.created_at,
      }));
      const articleCodes = [...new Set(lines.map((l) => l.articleCode).filter(Boolean))];
      const weightMap = new Map<string, string>();
      if (articleCodes.length > 0) {
        const baleProds = await db
          .select({
            articleCode: factoryBaleProducts.articleCode,
            weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
            name: factoryBaleProducts.name,
          })
          .from(factoryBaleProducts)
          .where(
            and(
              eq(factoryBaleProducts.companyId, companyId),
              inArray(factoryBaleProducts.articleCode, articleCodes as string[])
            )
          );
        baleProds.forEach((p) => {
          if (p.articleCode) weightMap.set(p.articleCode, p.weightPerBaleKg || "0");
        });
      }
      const enrichedLines = lines.map((l) => ({ ...l, weightPerBaleKg: weightMap.get(l.articleCode) || "0" }));
      res.set("Cache-Control", "private, max-age=60");
      res.json({ ...proforma, lines: enrichedLines });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryCustomerProformaCrudRoutesPart1(app);

  app.put("/api/factory/customer-proformas/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [existing] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Proforma not found" });

      if (req.body.name && req.body.name !== existing.name) {
        const [duplicate] = await db
          .select({ id: customerProformas.id })
          .from(customerProformas)
          .where(
            and(
              eq(customerProformas.companyId, companyId),
              eq(customerProformas.customerId, existing.customerId),
              eq(customerProformas.name, req.body.name)
            )
          );
        if (duplicate) {
          return res.status(409).json({
            message: `A proforma named "${req.body.name}" already exists for this customer. Please choose a different name.`,
          });
        }
      }

      // Older proformas can be assigned a destination without editing prices.
      const updateFields: Partial<typeof customerProformas.$inferInsert> = {};
      if (req.body.name !== undefined) updateFields.name = String(req.body.name).trim();
      if (req.body.isActive !== undefined) updateFields.isActive = req.body.isActive === true;
      if (req.body.destination !== undefined) {
        const destination = normalizeProformaDestination(req.body.destination);
        if (!destination) return res.status(400).json({ message: "A valid destination is required" });
        updateFields.destination = destination;
      }
      const [updated] = await db
        .update(customerProformas)
        .set({ ...updateFields, updatedAt: new Date() })
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)))
        .returning();

      await syncProformaReservations(db, companyId, id);
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating customer proforma:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customer-proformas/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [proformaBefore] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      if (proformaBefore) {
        const [custBefore] = await db
          .select({ id: customers.id, legalName: customers.legalName, deletedAt: customers.deletedAt })
          .from(customers)
          .where(eq(customers.id, proformaBefore.customerId));
        logger.info(
          `[PROFORMA DELETE] Deleting proforma id=${id} name="${proformaBefore.name}" customerId=${proformaBefore.customerId} customerName="${custBefore?.legalName}" customerDeletedAt=${custBefore?.deletedAt}`
        );
      }

      await db
        .update(customerProformas)
        .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));
      await syncProformaReservations(db, companyId, id);
      await db
        .delete(proformaStockReservations)
        .where(and(eq(proformaStockReservations.companyId, companyId), eq(proformaStockReservations.proformaId, id)));
      const [deleted] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, id), eq(customerProformas.companyId, companyId)));

      if (!deleted) return res.status(404).json({ message: "Proforma not found" });

      if (proformaBefore) {
        const [custAfter] = await db
          .select({ id: customers.id, legalName: customers.legalName, deletedAt: customers.deletedAt })
          .from(customers)
          .where(eq(customers.id, proformaBefore.customerId));
        logger.info(
          `[PROFORMA DELETE] After deletion: customerId=${proformaBefore.customerId} customerName="${custAfter?.legalName}" customerDeletedAt=${custAfter?.deletedAt}`
        );
      }

      res.json({ message: "Proforma deleted" });
    } catch (error: unknown) {
      logger.error("Error deleting customer proforma:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
