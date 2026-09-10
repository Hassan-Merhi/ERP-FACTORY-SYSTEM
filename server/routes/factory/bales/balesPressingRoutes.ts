/**
 * factoryBalesRoutes: BalesPressing endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { writeDaybookEntry } from "../_helpers";
import { factoryBaleProducts, factoryPressingBatches, factoryBales, factoryBaleSequences } from "@shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { registerFactoryMixBatchRoutes } from "../mix-batches";
import { registerFactoryBaleExportRoutes } from "../bale-exports";
import { registerFactoryFxRatesRoutes } from "../factoryFxRatesRoutes";

const QUANTITY_MESSAGE = "quantity must be a whole number of at least 1";

/**
 * Bale reference numbers come from a per-company counter that each pressing
 * advances by the quantity pressed. A negative quantity would move that counter
 * *backwards*, and every later batch would then try to reissue reference
 * numbers already on bales — a unique index catches the collision, so pressing
 * simply stops working for that company until someone repairs the counter by
 * hand. Rejecting the quantity up front is the cheaper end of that.
 */
function parseBaleQuantity(value: unknown): number | null {
  const quantity = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  return quantity;
}

export function registerBalesPressingRoutes(app: Express) {
  registerFactoryMixBatchRoutes(app);
  registerFactoryBaleExportRoutes(app);
  registerFactoryFxRatesRoutes(app);
  app.post("/api/factory/pressing/create-and-print", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { productId, weightPerBale } = req.body;
      const quantity = parseBaleQuantity(req.body.quantity);
      if (!productId || !req.body.quantity || !weightPerBale) {
        return res.status(400).json({ message: "productId, quantity, and weightPerBale are required" });
      }
      if (quantity === null) return res.status(400).json({ message: QUANTITY_MESSAGE });

      const result = await db.transaction(async (tx) => {
        const [product] = await tx
          .select()
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)));

        if (!product) throw new Error("Product not found");

        const [pressingBatch] = await tx
          .insert(factoryPressingBatches)
          .values({
            companyId,
            productId,
            expectedCount: quantity,
            status: "PENDING",
          })
          .returning();

        const [seqRecord] = await tx
          .select()
          .from(factoryBaleSequences)
          .where(eq(factoryBaleSequences.companyId, companyId))
          .for("update");

        let nextNumber: number;
        if (seqRecord) {
          nextNumber = seqRecord.nextNumber;
          await tx
            .update(factoryBaleSequences)
            .set({ nextNumber: nextNumber + quantity })
            .where(eq(factoryBaleSequences.id, seqRecord.id));
        } else {
          nextNumber = 200000;
          await tx.insert(factoryBaleSequences).values({
            companyId,
            nextNumber: 200000 + quantity,
          });
        }

        const bales = [];
        for (let i = 0; i < quantity; i++) {
          const refNum = `REF${String(nextNumber + i).padStart(6, "0")}`;
          const [bale] = await tx
            .insert(factoryBales)
            .values({
              companyId,
              pressingBatchId: pressingBatch.id,
              productId,
              baleCode: product.code,
              referenceNumber: refNum,
              articleCode: product.articleCode,
              productName: product.name,
              weightKg: String(weightPerBale),
              status: "PENDING_PRESSING",
            })
            .returning();
          bales.push(bale);
        }

        return { pressingBatchId: pressingBatch.id, bales };
      });

      const today = req.body.txDate || getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "BALE_PRESSING",
        referenceId: result.pressingBatchId,
        referenceTable: "factory_pressing_batches",
        description: `Pressing batch created: ${result.bales?.length || 0} bales`,
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating pressing batch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/pressing/create-multi", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { items } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "items array is required with at least one entry" });
      }

      const parsedQuantities = items.map((item) => parseBaleQuantity(item.quantity ?? item.qty));
      if (parsedQuantities.some((quantity: number | null) => quantity === null)) {
        return res.status(400).json({ message: QUANTITY_MESSAGE });
      }
      const quantities = parsedQuantities as number[];

      const result = await db.transaction(async (tx) => {
        const totalExpected = quantities.reduce((sum: number, quantity: number) => sum + quantity, 0);

        const [pressingBatch] = await tx
          .insert(factoryPressingBatches)
          .values({
            companyId,
            productId: items[0].productId,
            expectedCount: totalExpected,
            status: "PENDING",
          })
          .returning();

        const [seqRecord] = await tx
          .select()
          .from(factoryBaleSequences)
          .where(eq(factoryBaleSequences.companyId, companyId))
          .for("update");

        let nextNumber: number;
        if (seqRecord) {
          nextNumber = seqRecord.nextNumber;
          await tx
            .update(factoryBaleSequences)
            .set({ nextNumber: nextNumber + totalExpected })
            .where(eq(factoryBaleSequences.id, seqRecord.id));
        } else {
          nextNumber = 200000;
          await tx.insert(factoryBaleSequences).values({
            companyId,
            nextNumber: 200000 + totalExpected,
          });
        }

        const bales = [];
        let baleIndex = 0;

        // One batched lookup for every product in the request, then a map. The
        // previous implementation ran a `SELECT` per item inside the loop — an
        // N+1 pattern where an N-product press cost N round-trips before any
        // bale was written. Fetching everything up front also validates the
        // whole request before any insert, so a bad product still rolls the
        // batch (and the counter) back exactly as it did before.
        const productIds = items.map((item) => item.productId);
        const productRows = await tx
          .select()
          .from(factoryBaleProducts)
          .where(and(inArray(factoryBaleProducts.id, productIds), eq(factoryBaleProducts.companyId, companyId)));
        const productById = new Map(productRows.map((product) => [product.id, product] as const));

        for (const item of items) {
          if (!productById.has(item.productId)) {
            throw new Error(`Product ID ${item.productId} not found`);
          }
        }

        for (const [itemIndex, item] of items.entries()) {
          const qty = quantities[itemIndex];
          const weight = item.weightPerBale;
          const product = productById.get(item.productId)!;

          for (let i = 0; i < qty; i++) {
            const refNum = `REF${String(nextNumber + baleIndex).padStart(6, "0")}`;
            const [bale] = await tx
              .insert(factoryBales)
              .values({
                companyId,
                pressingBatchId: pressingBatch.id,
                productId: item.productId,
                baleCode: product.code,
                referenceNumber: refNum,
                articleCode: product.articleCode,
                productName: product.name,
                weightKg: String(weight),
                status: "PENDING_PRESSING",
              })
              .returning();
            bales.push({ ...bale, _product: product });
            baleIndex++;
          }
        }

        return { pressingBatchId: pressingBatch.id, bales };
      });

      const today = req.body.txDate || getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "BALE_PRESSING",
        referenceId: result.pressingBatchId,
        referenceTable: "factory_pressing_batches",
        description: `Multi-product pressing batch: ${result.bales?.length || 0} bales`,
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating multi-product pressing batch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/bales/create-batch", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { productId, weightPerBale } = req.body;
      const quantity = parseBaleQuantity(req.body.quantity);
      if (!productId || !req.body.quantity || !weightPerBale) {
        return res.status(400).json({ message: "productId, quantity, and weightPerBale are required" });
      }
      if (quantity === null) return res.status(400).json({ message: QUANTITY_MESSAGE });

      const result = await db.transaction(async (tx) => {
        const [product] = await tx
          .select()
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)));

        if (!product) throw new Error("Product not found");

        const [pressingBatch] = await tx
          .insert(factoryPressingBatches)
          .values({
            companyId,
            productId,
            expectedCount: quantity,
            status: "PENDING",
          })
          .returning();

        const [seqRecord] = await tx
          .select()
          .from(factoryBaleSequences)
          .where(eq(factoryBaleSequences.companyId, companyId))
          .for("update");

        let nextNumber: number;
        if (seqRecord) {
          nextNumber = seqRecord.nextNumber;
          await tx
            .update(factoryBaleSequences)
            .set({ nextNumber: nextNumber + quantity })
            .where(eq(factoryBaleSequences.id, seqRecord.id));
        } else {
          nextNumber = 200000;
          await tx.insert(factoryBaleSequences).values({
            companyId,
            nextNumber: 200000 + quantity,
          });
        }

        const bales = [];
        for (let i = 0; i < quantity; i++) {
          const refNum = `REF${String(nextNumber + i).padStart(6, "0")}`;
          const [bale] = await tx
            .insert(factoryBales)
            .values({
              companyId,
              pressingBatchId: pressingBatch.id,
              productId,
              baleCode: product.code,
              referenceNumber: refNum,
              articleCode: product.articleCode,
              productName: product.name,
              weightKg: String(weightPerBale),
              status: "PENDING_PRESSING",
            })
            .returning();
          bales.push(bale);
        }

        return { pressingBatchId: pressingBatch.id, bales };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating bale batch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 8. Factory Pressing Batches
  // ───────────────────────────────────────────────

  app.get("/api/factory/pressing-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const batches = await db
        .select({
          id: factoryPressingBatches.id,
          companyId: factoryPressingBatches.companyId,
          mixBatchId: factoryPressingBatches.mixBatchId,
          productId: factoryPressingBatches.productId,
          expectedCount: factoryPressingBatches.expectedCount,
          status: factoryPressingBatches.status,
          notes: factoryPressingBatches.notes,
          createdBy: factoryPressingBatches.createdBy,
          finalizedAt: factoryPressingBatches.finalizedAt,
          finalizedLocationId: factoryPressingBatches.finalizedLocationId,
          createdAt: factoryPressingBatches.createdAt,
          productName: factoryBaleProducts.name,
          productCode: factoryBaleProducts.code,
          articleCode: factoryBaleProducts.articleCode,
        })
        .from(factoryPressingBatches)
        .leftJoin(factoryBaleProducts, eq(factoryPressingBatches.productId, factoryBaleProducts.id))
        .where(eq(factoryPressingBatches.companyId, companyId))
        .orderBy(desc(factoryPressingBatches.createdAt));

      // One query for every batch's bales, grouped in memory. The previous
      // implementation issued a `SELECT` per pressing batch inside Promise.all,
      // an N+1 pattern: a company with many open batches paid one round-trip
      // per batch on every list load.
      const batchIds = batches.map((batch) => batch.id);
      const balesForBatches =
        batchIds.length > 0
          ? await db
              .select()
              .from(factoryBales)
              .where(inArray(factoryBales.pressingBatchId, batchIds))
              .orderBy(factoryBales.referenceNumber)
          : [];

      const balesByBatchId = new Map<number, typeof balesForBatches>();
      for (const bale of balesForBatches) {
        if (bale.pressingBatchId == null) continue;
        const existing = balesByBatchId.get(bale.pressingBatchId);
        if (existing) {
          existing.push(bale);
        } else {
          balesByBatchId.set(bale.pressingBatchId, [bale]);
        }
      }

      const enriched = batches.map((batch) => {
        const balesForBatch = balesByBatchId.get(batch.id) ?? [];
        const pendingCount = balesForBatch.filter((b) => b.status === "PENDING_PRESSING").length;
        const finalizedCount = balesForBatch.filter((b) => b.status === "IN_STOCK").length;

        return { ...batch, pendingCount, finalizedCount, bales: balesForBatch };
      });

      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching pressing batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/pressing-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [batch] = await db
        .select()
        .from(factoryPressingBatches)
        .where(and(eq(factoryPressingBatches.id, id), eq(factoryPressingBatches.companyId, companyId)));

      if (!batch) return res.status(404).json({ message: "Pressing batch not found" });

      const bales = await db
        .select()
        .from(factoryBales)
        .where(eq(factoryBales.pressingBatchId, id))
        .orderBy(factoryBales.referenceNumber);

      res.json({ ...batch, bales });
    } catch (error: unknown) {
      logger.error("Error fetching pressing batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
