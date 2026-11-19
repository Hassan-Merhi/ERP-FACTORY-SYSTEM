// Extracted from ./baleRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { storage } from "../storage";
import { cache } from "../lib/simpleCache";
import { requireAuth } from "../auth";
import {
  baleLabelPrints,
  factoryBaleProducts,
  factoryBales,
  insertCompanySettingsSchema,
  inventory,
  stockItems,
} from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { registerBaleTransferRoutes } from "./baleTransferRoutes";
import { registerProductionBaleRoutes } from "./productionBaleRoutes";
import { registerProductionRawStockRoutes } from "./productionRawStockRoutes";
import { registerBaleLookupRoutes } from "./baleLookupRoutes";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

// The reprint screens send { baleId } as a number; the handler Number()-s it
// and keeps its own positive-integer check.
const reprintInput = {
  query: emptyQuery,
  body: z.strictObject({ baleId: z.union([z.number(), z.string()]).nullable().optional() }),
} satisfies RequestSchemas;

export function registerBaleRoutesPart2(app: Express) {
  app.post("/api/bale-label-prints/reprint", requireAuth, validateRequest(reprintInput), async (req, res) => {
    try {
      // Reprint audit rows keep the active session company, as before.
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const baleId = Number(req.body?.baleId);
      if (!Number.isSafeInteger(baleId) || baleId < 1) {
        return res.status(400).json({ message: "Valid baleId required" });
      }
      const authorizedCompanyIds = [
        ...new Set(
          [req.session.currentCompanyId, req.session.factoryCompanyId].filter(
            (id): id is number => Number.isSafeInteger(id) && Number(id) > 0
          )
        ),
      ];
      const [bale] = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.id, baleId),
            inArray(factoryBales.companyId, authorizedCompanyIds),
            sql`${factoryBales.deletedAt} IS NULL`
          )
        )
        .limit(1);
      if (!bale) return res.status(404).json({ message: "Physical bale not found or deleted" });

      const { prepareAutomaticPriorityPrintBatchTx } = await import("./factory/customer-orders/priorityAutoAllocation");
      const { PRIORITY_SCAN_LOCK_NAMESPACE } = await import("./factory/customer-orders/priorityScanQueue");
      const priorityAllocation = await db.transaction(async (tx) => {
        // Resolve under the bale company's queue lock, in the same transaction
        // as the reprint audit. Already assigned bales return their original
        // snapshot; an unassigned bale may enter Priority Scan only while ON.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${bale.companyId})`);
        const [prepared] = await prepareAutomaticPriorityPrintBatchTx(
          tx,
          bale.companyId,
          [{ baleId }],
          String(req.session.username || req.session.userId || "automatic"),
          req.session.userId == null ? null : String(req.session.userId)
        );

        const [existing] = await tx
          .select()
          .from(baleLabelPrints)
          .where(and(eq(baleLabelPrints.companyId, companyId), eq(baleLabelPrints.productionBaleId, baleId)));
        if (existing) {
          await tx
            .update(baleLabelPrints)
            .set({ printedAt: new Date(), printedByUserId: req.session.userId || null })
            .where(eq(baleLabelPrints.id, existing.id));
        } else {
          const product = bale.productId
            ? (
                await tx
                  .select()
                  .from(factoryBaleProducts)
                  .where(
                    and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, bale.companyId))
                  )
              )[0]
            : null;
          const refNum = bale.referenceNumber || `REPRINT-${baleId}`;
          await tx.insert(baleLabelPrints).values({
            companyId,
            productionBaleId: baleId,
            productId: bale.productId || null,
            articleCode: product?.articleCode || bale.category || "UNKNOWN",
            referenceNumber: refNum,
            pieces: bale.quantity || 1,
            approxWeightKg: String(bale.weightKg || 0),
            printedByUserId: req.session.userId || null,
            printedAt: new Date(),
          });
        }
        return prepared?.priorityAllocation ?? null;
      });
      res.json({ success: true, printedAt: new Date().toISOString(), priorityAllocation });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerBaleLookupRoutes(app);

  // Company Settings API Routes
  app.get("/api/company-settings", requireAuth, async (req, res) => {
    try {
      const { companyId: queryCompanyId } = req.query;
      const companyId = queryCompanyId ? parseInt(queryCompanyId as string) : req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const settings = await cache(`company_settings:${companyId}`, 30_000, () =>
        storage.getCompanySettings(companyId).then((s) => s || { companyId })
      );
      res.json(settings);
    } catch (error: unknown) {
      logger.error("Error fetching company settings:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/company-settings", requireAuth, async (req, res) => {
    try {
      const { companyId: bodyCompanyId } = req.body;
      const companyId = bodyCompanyId ? parseInt(bodyCompanyId as string) : req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const data = insertCompanySettingsSchema.parse({ ...req.body, companyId });

      const settings = await storage.upsertCompanySettings(data);
      cache.del(`company_settings:${companyId}`);
      res.json(settings);
    } catch (error: unknown) {
      logger.error("Error updating company settings:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  registerProductionRawStockRoutes(app);

  registerProductionBaleRoutes(app);

  // Customer Balance API Routes
  app.get("/api/customers/:id/balance", requireAuth, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) {
        return res.status(400).json({ message: "Invalid customer ID" });
      }

      const balance = await storage.getCustomerBalance(customerId, companyId);
      res.json({ customerId, balance });
    } catch (error: unknown) {
      logger.error("Error fetching customer balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/customers/:id/statement", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) {
        return res.status(400).json({ message: "Invalid customer ID" });
      }

      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      const statement = await storage.getCustomerStatement(customerId, companyId, startDate, endDate);
      res.json(statement);
    } catch (error: unknown) {
      logger.error("Error fetching customer statement:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/inventory-by-location/:locationId", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Check if user is POS role
      const isPOS = req.session.currentRole === "POS";

      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      const items = await db
        .select({
          id: inventory.id,
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          stockItemName: stockItems.name,
          stockItemCode: stockItems.code,
        })
        .from(inventory)
        .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
        .where(and(eq(inventory.locationId, locationId), sql`CAST(${inventory.quantity} AS NUMERIC) > 0`));

      // Strip cost fields for POS users
      const sanitizedItems = isPOS ? items.map(({ averageRate, ...rest }) => rest) : items;

      res.json(sanitizedItems);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerBaleTransferRoutes(app);

  app.get("/api/bales-by-location/:locationId", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const _locId = parseInt(req.params.locationId, 10);
      if (isNaN(_locId)) return res.status(400).json({ message: "Invalid location ID" });
      const bales = await storage.getProductionBalesByLocation(companyId, _locId);
      res.json(
        bales.map((b) => ({
          id: b.id,
          baleCode: b.baleCode,
          category: b.category,
          grade: b.grade,
          weightKg: b.weightKg,
          costPerKg: b.costPerKg,
          totalCost: b.totalCost,
        }))
      );
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
