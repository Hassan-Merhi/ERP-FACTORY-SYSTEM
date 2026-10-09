import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { storage } from "../storage";
import { cache } from "../lib/simpleCache";
import { requireAuth } from "../auth";
import {
  inventory,
  stockItems,
  insertCompanySettingsSchema,
  factoryBales,
  factoryBaleProducts,
  baleLabelPrints,
  referenceSequences,
  insertBaleSchema,
  factoryBaleSequences,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

// Module-level bwip-js cache — loaded once on first barcode request, then reused.
// This avoids the cold-start latency of re-importing the library on every request.
type BwipJsModule = typeof import("bwip-js");
let _bwipjs: BwipJsModule | null = null;
async function getBwipjs(): Promise<BwipJsModule> {
  if (!_bwipjs) {
    _bwipjs = await import("bwip-js");
  }
  return _bwipjs;
}
import { registerBaleProductRoutes } from "./baleProductRoutes";
import { registerBaleTransferRoutes } from "./baleTransferRoutes";
import { registerProductionBaleRoutes } from "./productionBaleRoutes";
import { registerProductionRawStockRoutes } from "./productionRawStockRoutes";
import { registerBaleLookupRoutes } from "./baleLookupRoutes";

export function registerBaleRoutes(app: Express) {
  // Pre-warm bwip-js at server startup so the first barcode render is instant.
  getBwipjs().catch(() => {});
  app.get("/api/bales", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const bales = await storage.getAllBales(companyId);
      res.json(bales);
    } catch (error: unknown) {
      logger.error("Error fetching bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/bales/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      const bale = await storage.getBaleById(id);

      if (!bale) {
        return res.status(404).json({ message: "Bale not found" });
      }

      // Check company ownership
      if (bale.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error fetching bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/bales/barcode/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const barcode = req.params.barcode;
      const bale = await storage.getBaleByBarcode(barcode, companyId);

      if (!bale) {
        return res.status(404).json({ message: "Bale not found" });
      }

      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error fetching bale by barcode:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bales", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const data = insertBaleSchema.parse({ ...req.body, companyId });

      // Check for duplicate barcode
      const existing = await storage.getBaleByBarcode(data.barcode, companyId);
      if (existing) {
        return res.status(409).json({ message: "Barcode already exists" });
      }

      const bale = await storage.createBale(data);
      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error creating bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/bales/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      const existing = await storage.getBaleById(id);

      if (!existing) {
        return res.status(404).json({ message: "Bale not found" });
      }

      // Check company ownership
      if (existing.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Prevent companyId changes
      const { companyId: _, ...updateData } = req.body;
      const bale = await storage.updateBale(id, updateData);
      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error updating bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/bales/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      const existing = await storage.getBaleById(id);

      if (!existing) {
        return res.status(404).json({ message: "Bale not found" });
      }

      // Check company ownership
      if (existing.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.deleteBale(id);
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bales/import", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const balesData = req.body.bales || [];

      if (!Array.isArray(balesData)) {
        return res.status(400).json({ message: "Invalid data format" });
      }

      const validatedBales = balesData.map((b) => insertBaleSchema.parse({ ...b, companyId }));

      const created = await storage.bulkCreateBales(validatedBales);
      res.json({ success: true, count: created.length, bales: created });
    } catch (error: unknown) {
      logger.error("Error importing bales:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Price import from Excel: preview + apply
  app.post("/api/bales/price-import/preview", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows: { barcode: string; price: string }[] = req.body.rows || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows provided" });
      }

      const preview = await Promise.all(
        rows.map(async (row) => {
          const barcode = String(row.barcode || "").trim();
          const newPrice = parseFloat(String(row.price || ""));
          if (!barcode) return { barcode, status: "invalid", currentPrice: null, newPrice: null };
          if (isNaN(newPrice) || newPrice < 0)
            return { barcode, status: "invalid_price", currentPrice: null, newPrice: null };
          const bale = await storage.getBaleByBarcode(barcode, companyId);
          if (!bale) return { barcode, status: "not_found", currentPrice: null, newPrice };
          const currentPrice = bale.price ? parseFloat(bale.price) : null;
          const noChange = currentPrice !== null && Math.abs(currentPrice - newPrice) < 0.001;
          return {
            id: bale.id,
            barcode,
            category: bale.category,
            grade: bale.grade,
            status: noChange ? "no_change" : "will_update",
            currentPrice,
            newPrice,
          };
        })
      );

      res.json({ preview });
    } catch (error: unknown) {
      logger.error("Error in price-import preview:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bales/price-import/apply", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows: { id: number; price: string }[] = req.body.rows || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows provided" });
      }

      let updated = 0;
      for (const row of rows) {
        const id = parseInt(String(row.id));
        const price = parseFloat(String(row.price));
        if (isNaN(id) || isNaN(price) || price < 0) continue;
        const bale = await storage.getBaleById(id);
        if (!bale || bale.companyId !== companyId) continue;
        await storage.updateBale(id, { price: String(price) });
        updated++;
      }

      res.json({ success: true, updated });
    } catch (error: unknown) {
      logger.error("Error in price-import apply:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerBaleProductRoutes(app);

  // Helper: generate a reference number that is guaranteed not to clash with any
  // existing factory_bales ref for this company, by taking the max across both
  // sequence tables and the actual data.
  async function generateSafeRef(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    companyId: number
  ): Promise<string> {
    // Find the true max numeric ref already in use for this company
    const [maxRow] = await tx
      .select({
        m: sql<number>`COALESCE(MAX(CAST(REGEXP_REPLACE(reference_number, '[^0-9]', '', 'g') AS BIGINT)), 0)`,
      })
      .from(factoryBales)
      .where(and(eq(factoryBales.companyId, companyId), sql`reference_number ~ '^REF[0-9]+'`));
    const dbMax = Number(maxRow?.m) || 0;

    // Also check both sequence tables
    const [refSeq] = await tx
      .select()
      .from(referenceSequences)
      .where(eq(referenceSequences.companyId, companyId))
      .for("update");
    const [baleSeq] = await tx.select().from(factoryBaleSequences).where(eq(factoryBaleSequences.companyId, companyId));

    const seqMax = Math.max(refSeq?.nextNumber ?? 0, baleSeq?.nextNumber ?? 0);
    const safeNext = Math.max(dbMax + 1, seqMax);
    const referenceNumber = `REF${String(safeNext).padStart(6, "0")}`;

    // Update (or insert) referenceSequences so next call gets safeNext+1
    if (refSeq) {
      await tx
        .update(referenceSequences)
        .set({ nextNumber: safeNext + 1 })
        .where(eq(referenceSequences.id, refSeq.id));
    } else {
      await tx.insert(referenceSequences).values({ companyId, nextNumber: safeNext + 1 });
    }

    return referenceNumber;
  }

  // Bale Label Prints - pre-allocate a batch of reference numbers for offline label printing
  app.post("/api/bale-label-prints/allocate-pool", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const count = Math.min(Math.max(parseInt(req.body?.count ?? "200", 10) || 200, 1), 500);
      const refs = await db.transaction(async (tx) => {
        const result: string[] = [];
        for (let i = 0; i < count; i++) {
          result.push(await generateSafeRef(tx, companyId));
        }
        return result;
      });
      res.json({ refs });
    } catch (error: unknown) {
      logger.error("Error allocating label ref pool:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bale Label Prints - create label print records with unique reference numbers
  app.post("/api/bale-label-prints", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { bales } = req.body;
      if (!bales || !Array.isArray(bales) || bales.length === 0) {
        return res.status(400).json({ message: "No bales provided" });
      }

      // All existing physical bales in this print request are routed under a
      // single company queue lock + transaction. If one reference is invalid,
      // the batch rolls back instead of partially allocating printed labels.
      const { runAutomaticPriorityPrintBatch } = await import("./factory/customer-orders/priorityAutoAllocation");
      const physicalBaleIds = [...new Set(bales.map((item: { productionBaleId?: unknown }) =>
        Number(item.productionBaleId)).filter((id: number) => Number.isSafeInteger(id) && id > 0))];
      const prepared = physicalBaleIds.length > 0
        ? await runAutomaticPriorityPrintBatch(
            companyId,
            physicalBaleIds.map((baleId) => ({ baleId })),
            String(req.session.username || req.session.userId || "automatic"),
            req.session.userId == null ? null : String(req.session.userId)
          )
        : [];
      const priorityAllocations = prepared.flatMap((item) =>
        item.priorityAllocation ? [item.priorityAllocation] : []);

      const labelPrints = await db.transaction(async (tx) => {
        const results = [];
        for (const bale of bales) {
          let referenceNumber: string;

          // If the bale already has a reference number (assigned by stock-entry),
          // reuse it — do NOT generate a new one or we'll collide with factory_bales unique constraint.
          if (bale.productionBaleId) {
            const [existingBale] = await tx
              .select({ referenceNumber: factoryBales.referenceNumber })
              .from(factoryBales)
              .where(and(eq(factoryBales.id, bale.productionBaleId), eq(factoryBales.companyId, companyId)));

            if (existingBale?.referenceNumber) {
              // Bale already has a reference (e.g. assigned by stock-entry) — reuse it
              referenceNumber = existingBale.referenceNumber;
            } else if (existingBale) {
              // Bale exists in this company but has no reference yet.
              referenceNumber = await generateSafeRef(tx, companyId);
              await tx.update(factoryBales).set({ referenceNumber })
                .where(and(eq(factoryBales.id, bale.productionBaleId), eq(factoryBales.companyId, companyId)));
            } else {
              throw new Error("Cannot print a physical bale belonging to another company or not found");
            }
          } else if (bale.referenceNumber) {
            // Pre-allocated offline ref — use it directly (sequence was already advanced)
            referenceNumber = bale.referenceNumber;
          } else {
            // No productionBaleId — standalone label print, generate from sequence
            referenceNumber = await generateSafeRef(tx, companyId);
          }

          const [labelPrint] = await tx
            .insert(baleLabelPrints)
            .values({
              companyId,
              productionBaleId: bale.productionBaleId || null,
              productId: bale.productId || null,
              articleCode: bale.articleCode,
              referenceNumber,
              pieces: bale.pieces || 1,
              approxWeightKg: String(bale.approxWeightKg),
              printedByUserId: req.session.userId || null,
              printedAt: new Date(),
            })
            .returning();

          results.push(labelPrint);
        }
        return results;
      });

      res.json({ labelPrints, priorityAllocations });
    } catch (error: unknown) {
      logger.error("Error creating bale label prints:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bale-label-prints/reprint", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const baleId = Number(req.body?.baleId);
      if (!Number.isSafeInteger(baleId) || baleId < 1) {
        return res.status(400).json({ message: "Valid baleId required" });
      }
      const [physicalBale] = await db.select({ id: factoryBales.id }).from(factoryBales)
        .where(and(
          eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId),
          sql`${factoryBales.deletedAt} IS NULL`
        )).limit(1);
      if (!physicalBale) return res.status(404).json({ message: "Physical bale not found or deleted" });
      // Resolve before recording the print. Reprints of already assigned bales
      // return their original snapshot; unassigned bales may enter Priority Scan.
      const { runAutomaticPriorityReprint } = await import("./factory/customer-orders/priorityAutoAllocation");
      const priorityAllocation = await runAutomaticPriorityReprint(
        companyId, Number(baleId),
        String(req.session.username || req.session.userId || "automatic"),
        req.session.userId == null ? null : String(req.session.userId)
      );
      const [existing] = await db
        .select()
        .from(baleLabelPrints)
        .where(and(eq(baleLabelPrints.companyId, companyId), eq(baleLabelPrints.productionBaleId, baleId)));
      if (existing) {
        await db
          .update(baleLabelPrints)
          .set({ printedAt: new Date(), printedByUserId: req.session.userId || null })
          .where(eq(baleLabelPrints.id, existing.id));
      } else {
        const [bale] = await db.select().from(factoryBales).where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId)));
        if (bale) {
          const product = bale.productId
            ? (await db.select().from(factoryBaleProducts).where(and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, companyId))))[0]
            : null;
          const refNum = bale.referenceNumber || `REPRINT-${baleId}`;
          await db.insert(baleLabelPrints).values({
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
      }
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

  // Orphaned Records Cleanup API - Find and reassign vouchers with deleted locations + unbalanced vouchers
}
