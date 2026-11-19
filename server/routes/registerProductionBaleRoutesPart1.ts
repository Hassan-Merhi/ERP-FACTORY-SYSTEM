// Extracted from ./productionBaleRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { baleProducts, mixBatches, pressingBatches, productionBales } from "@shared/schema";
import { registerProductionBaleRoutesPart4 } from "./registerProductionBaleRoutesPart4";

// Module-level bwip-js cache — loaded once on first barcode request, then reused.
// This avoids the cold-start latency of re-importing the library on every request.
type BwipJsModule = typeof import("bwip-js");

let _bwipjs: BwipJsModule | null = null;

export async function getBwipjs(): Promise<BwipJsModule> {
  if (!_bwipjs) {
    _bwipjs = await import("bwip-js");
  }
  return _bwipjs;
}

export function registerProductionBaleRoutesPart1(app: Express) {
  // Production Bales API Routes
  app.get("/api/production-bales", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const filters: { mixBatchId?: number; status?: string; category?: string; grade?: string } = {};
      if (req.query.mixBatchId) filters.mixBatchId = parseInt(req.query.mixBatchId as string);
      if (req.query.status) filters.status = req.query.status as string;
      if (req.query.category) filters.category = req.query.category as string;
      if (req.query.grade) filters.grade = req.query.grade as string;

      const bales = await storage.getAllProductionBales(companyId, filters);
      res.json(bales);
    } catch (error: unknown) {
      logger.error("Error fetching production bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerProductionBaleRoutesPart4(app);

  app.get("/api/production-bales/pending", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const pending = await db
        .select({
          bale: productionBales,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(productionBales)
        .leftJoin(baleProducts, eq(productionBales.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(productionBales.mixBatchId, mixBatches.id))
        .where(and(eq(productionBales.companyId, companyId), eq(productionBales.status, "PENDING")))
        .orderBy(desc(productionBales.createdAt));

      res.json(pending);
    } catch (error: unknown) {
      logger.error("Error fetching pending bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/production-bales/lookup/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const barcode = req.params.barcode.trim();

      const results = await db
        .select({
          bale: productionBales,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(productionBales)
        .leftJoin(baleProducts, eq(productionBales.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(productionBales.mixBatchId, mixBatches.id))
        .where(
          and(
            eq(productionBales.companyId, companyId),
            or(eq(productionBales.barcodeValue, barcode), eq(productionBales.baleCode, barcode))
          )
        );

      if (results.length === 0) {
        return res.status(404).json({ message: "Bale not found" });
      }

      res.json(results[0]);
    } catch (error: unknown) {
      logger.error("Error looking up bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pressing-batches", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const batches = await db
        .select({
          batch: pressingBatches,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(pressingBatches)
        .leftJoin(baleProducts, eq(pressingBatches.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(pressingBatches.mixBatchId, mixBatches.id))
        .where(eq(pressingBatches.companyId, companyId))
        .orderBy(desc(pressingBatches.createdAt));

      const batchesWithBales = await Promise.all(
        batches.map(async (b) => {
          const bales = await db
            .select()
            .from(productionBales)
            .where(and(eq(productionBales.pressingBatchId, b.batch.id), eq(productionBales.companyId, companyId)));
          return {
            ...b,
            bales,
            pendingCount: bales.filter((bl) => bl.status === "PENDING").length,
            finalizedCount: bales.filter((bl) => bl.status !== "PENDING").length,
          };
        })
      );

      res.json(batchesWithBales);
    } catch (error: unknown) {
      logger.error("Error fetching pressing batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pressing-batches/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const batchId = parseInt(req.params.id, 10);
      if (isNaN(batchId)) return res.status(400).json({ message: "Invalid batch ID" });

      const [batchRow] = await db
        .select({
          batch: pressingBatches,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(pressingBatches)
        .leftJoin(baleProducts, eq(pressingBatches.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(pressingBatches.mixBatchId, mixBatches.id))
        .where(and(eq(pressingBatches.id, batchId), eq(pressingBatches.companyId, companyId)));

      if (!batchRow) return res.status(404).json({ message: "Pressing batch not found" });

      const bales = await db
        .select()
        .from(productionBales)
        .where(and(eq(productionBales.pressingBatchId, batchId), eq(productionBales.companyId, companyId)));

      res.json({
        ...batchRow,
        bales,
        pendingCount: bales.filter((b) => b.status === "PENDING").length,
        finalizedCount: bales.filter((b) => b.status !== "PENDING").length,
      });
    } catch (error: unknown) {
      logger.error("Error fetching pressing batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
