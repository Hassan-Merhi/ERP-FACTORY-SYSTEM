/**
 * factoryWorkerRoutes: FactoryWorkerPhoto endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { parseId } from "../../lib/parseId";
import { validateRequest } from "../../lib/validateRequest";
import { workerPhotoInput } from "./factoryWorkerWriteSchemas";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import { eq, and } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { factoryWorkers } from "@shared/schema";

import { getFactoryCompanyId, workerUpload, writeDaybookEntry } from "./_helpers";

export function registerFactoryWorkerPhotoRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  // POST /api/factory/workers/:id/photo - Upload photo
  app.post(
    "/api/factory/workers/:id/photo",
    requireAuth,
    workerUpload.single("photo"),
    validateRequest(workerPhotoInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.body.companyId || getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        if (!req.file) return res.status(400).json({ message: "No photo uploaded" });

        const id = parseId(req.params.id);

        if (id === null) return res.status(400).json({ message: "Invalid id" });
        const photoUrl = `/api/factory/uploads/workers/${req.file.filename}`;

        const [updated] = await db
          .update(factoryWorkers)
          .set({ photoUrl, updatedAt: new Date() })
          .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)))
          .returning();

        if (!updated) return res.status(404).json({ message: "Worker not found" });

        const today = getClientDate(req);
        await writeDaybookEntry(db, {
          companyId,
          txDate: today,
          txType: "WORKER_PHOTO_UPLOADED",
          referenceId: updated.id,
          referenceTable: "factory_workers",
          description: `Photo uploaded for worker: ${updated.fullName}`,
          createdBy: req.session.userId ?? undefined,
        });

        res.json(updated);
      } catch (error: unknown) {
        logger.error("Error uploading worker photo:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  // GET /api/factory/uploads/workers/:filename - Serve worker photos
  app.get("/api/factory/uploads/workers/:filename", requireAuth, (req: Request, res: Response) => {
    try {
      // Defence in depth: strip any directory component from the requested name
      // and ensure the resolved path stays within the workers uploads directory.
      const safeName = path.basename(req.params.filename || "");
      if (!safeName || safeName.startsWith(".")) {
        return res.status(400).json({ message: "Invalid filename" });
      }
      const baseDir = path.resolve(process.cwd(), "uploads", "workers");
      const filePath = path.resolve(baseDir, safeName);
      if (!filePath.startsWith(baseDir + path.sep)) {
        return res.status(400).json({ message: "Invalid filename" });
      }
      if (!fs.existsSync(filePath)) return res.status(404).json({ message: "File not found" });
      res.sendFile(filePath);
    } catch (error: unknown) {
      logger.error("Error serving worker photo:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
