// Extracted from ./balesPressingRoutes.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry } from "../_helpers";
import { factoryBaleProducts, factoryPressingBatches, factoryBales, factoryBaleSequences } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireCreateOnlyVerifiedCreate } from "../../../services/security/createOnlyVerifiedCreates";

export const QUANTITY_MESSAGE = "quantity must be a whole number of at least 1";

/**
 * Bale reference numbers come from a per-company counter that each pressing
 * advances by the quantity pressed. A negative quantity would move that counter
 * *backwards*, and every later batch would then try to reissue reference
 * numbers already on bales — a unique index catches the collision, so pressing
 * simply stops working for that company until someone repairs the counter by
 * hand. Rejecting the quantity up front is the cheaper end of that.
 */
export function parseBaleQuantity(value: unknown): number | null {
  const quantity = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  return quantity;
}

export function registerBalesPressingRoutesPart1(app: Express) {
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

  app.post(
    "/api/factory/bales/create-batch",
    requireAuth,
    requireCreateOnlyVerifiedCreate("factoryBaleBatch"),
    async (req: Request, res: Response) => {
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
    }
  );
}
