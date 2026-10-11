/**
 * factoryIntelligenceRoutes: FactoryBaleTracePhoto endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, desc, sql } from "drizzle-orm";
import path from "path";
import fs from "fs";
import {
  factoryBalePhotos,
  factoryBales,
  factoryContainers,
  factoryMixBatches,
  factoryMixBatchSources,
  factorySuppliers,
  customerOrders,
  customerOrderBales,
} from "@shared/schema";

import { balePhotoUpload } from "./_helpers";
import { toMoney } from "../../lib/money";

/** One raw-material source line on a bale trace response. */
type BaleTraceSource = {
  supplier: { id: number; name: string } | null;
  container: { id: number; containerNumber: string | null } | null;
  kgUsed: number;
};

export function registerFactoryBaleTracePhotoRoutes(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  app.get("/api/factory/bales/:id/trace", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const baleId = parseInt(req.params.id);

      const [bale] = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.id, baleId), eq(factoryBales.companyId, companyId)));

      if (!bale) return res.status(404).json({ message: "Bale not found" });

      let mixBatch = null;
      let sourcesData: BaleTraceSource[] = [];

      if (bale.mixBatchId) {
        const [mb] = await db.select().from(factoryMixBatches).where(eq(factoryMixBatches.id, bale.mixBatchId));
        mixBatch = mb || null;

        if (mixBatch) {
          const mixSources = await db
            .select()
            .from(factoryMixBatchSources)
            .where(eq(factoryMixBatchSources.mixBatchId, mixBatch.id));

          const containerIds = mixSources.map((s) => s.containerId).filter((id): id is number => id !== null);
          const containers =
            containerIds.length > 0
              ? await db
                  .select()
                  .from(factoryContainers)
                  .where(
                    sql`${factoryContainers.id} IN (${sql.join(
                      containerIds.map((id) => sql`${id}`),
                      sql`, `
                    )})`
                  )
              : [];

          const containerMap = new Map(containers.map((c) => [c.id, c]));

          const supplierIds = Array.from(
            new Set(containers.map((c) => c.supplierId).filter((id): id is number => id !== null))
          );
          const suppliers =
            supplierIds.length > 0
              ? await db
                  .select()
                  .from(factorySuppliers)
                  .where(
                    sql`${factorySuppliers.id} IN (${sql.join(
                      supplierIds.map((id) => sql`${id}`),
                      sql`, `
                    )})`
                  )
              : [];
          const supplierMap = new Map(suppliers.map((s) => [s.id, s]));

          sourcesData = mixSources.map((s) => {
            const container = s.containerId ? containerMap.get(s.containerId) : null;
            const supplier = container?.supplierId ? supplierMap.get(container.supplierId) : null;
            return {
              supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
              container: container ? { id: container.id, containerNumber: container.containerNumber } : null,
              kgUsed: toMoney(s.weightKg).toNumber(),
            };
          });
        }
      }

      const shippingContainer = null;

      const [orderBale] = await db.select().from(customerOrderBales).where(eq(customerOrderBales.baleId, baleId));

      let order = null;
      if (orderBale) {
        const [o] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderBale.orderId));
        order = o || null;
      }

      res.json({
        bale,
        mixBatch,
        sources: sourcesData,
        shippingContainer,
        order,
      });
    } catch (error: unknown) {
      logger.error("Error tracing bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 10. Bale Photos
  // ───────────────────────────────────────────────

  app.get("/api/factory/bales/:id/photos", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const baleId = parseInt(req.params.id);

      const photos = await db
        .select()
        .from(factoryBalePhotos)
        .where(and(eq(factoryBalePhotos.baleId, baleId), eq(factoryBalePhotos.companyId, companyId)))
        .orderBy(desc(factoryBalePhotos.uploadedAt));

      res.json(photos);
    } catch (error: unknown) {
      logger.error("Error fetching bale photos:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/factory/bales/:id/photos",
    requireAuth,
    balePhotoUpload.single("photo"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.body.companyId || req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        if (!req.file) return res.status(400).json({ message: "No photo uploaded" });

        const baleId = parseInt(req.params.id);
        const url = `/api/factory/uploads/bale-photos/${req.file.filename}`;

        const [photo] = await db
          .insert(factoryBalePhotos)
          .values({
            companyId,
            baleId,
            url,
            fileName: req.file.originalname,
            uploadedBy: req.session.userId ?? null,
          })
          .returning();

        res.json(photo);
      } catch (error: unknown) {
        logger.error("Error uploading bale photo:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.delete("/api/factory/bale-photos/:photoId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const photoId = parseInt(req.params.photoId);

      const [photo] = await db
        .select()
        .from(factoryBalePhotos)
        .where(and(eq(factoryBalePhotos.id, photoId), eq(factoryBalePhotos.companyId, companyId)));

      if (!photo) return res.status(404).json({ message: "Photo not found" });

      const filename = photo.url?.split("/").pop();
      if (filename) {
        const filePath = path.join(process.cwd(), "uploads", "bale-photos", filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      await db.delete(factoryBalePhotos).where(eq(factoryBalePhotos.id, photoId));

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting bale photo:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/uploads/bale-photos/:filename", requireAuth, (req: Request, res: Response) => {
    try {
      // Strip any directory component from the supplied filename so a caller
      // cannot escape the uploads/bale-photos directory with "../" segments.
      const safeName = path.basename(req.params.filename || "");
      if (!safeName || safeName.startsWith(".")) {
        return res.status(400).json({ message: "Invalid filename" });
      }
      const baseDir = path.resolve(process.cwd(), "uploads", "bale-photos");
      const filePath = path.resolve(baseDir, safeName);
      if (!filePath.startsWith(baseDir + path.sep)) {
        return res.status(400).json({ message: "Invalid filename" });
      }
      if (!fs.existsSync(filePath)) return res.status(404).json({ message: "File not found" });
      res.sendFile(filePath);
    } catch (error: unknown) {
      logger.error("Error serving bale photo:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 11. Cash Flow Forecast
  // ───────────────────────────────────────────────
}
