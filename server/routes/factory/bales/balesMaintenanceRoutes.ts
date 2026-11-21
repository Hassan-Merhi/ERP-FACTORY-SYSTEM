/**
 * factoryBalesRoutes: bale maintenance endpoints (product name, worker
 * assignment, weight correction, repack).
 *
 * Registered by registerBalesCrudRoutes in ./balesCrudRoutes.ts at the
 * original position; Express resolves first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBaleProducts,
  factoryBales,
  factoryBaleSequences,
  factoryBaleProductionAttributions,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { registerBalesMaintenanceRoutesPart1 } from "./registerBalesMaintenanceRoutesPart1";

export function registerBalesMaintenanceRoutes(app: Express) {
  app.patch("/api/factory/bales/:id/product-name", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { name } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "Name is required" });
      }

      const [bale] = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

      if (!bale) return res.status(404).json({ message: "Bale not found" });

      // Phase 21 (B): the rename and its audit commit together.
      await db.transaction(async (tx) => {
        if (bale.productId) {
          await tx
            .update(factoryBaleProducts)
            .set({ name: name.trim(), updatedAt: new Date() })
            .where(and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, companyId)));
        }

        await tx
          .update(factoryBales)
          .set({ productName: name.trim(), updatedAt: new Date() })
          .where(eq(factoryBales.id, id));

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "bales",
            recordId: id,
            recordIdentifier: `Bale #${id}`,
            changes: { productName: { old: bale.productName, new: name.trim() } },
          },
          tx
        );
      });
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error updating bale product name:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerBalesMaintenanceRoutesPart1(app);

  app.post("/api/factory/bales/:id/repack", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const [originalBale] = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

        if (!originalBale) throw new Error("Bale not found");
        if (originalBale.status === "REPACKED") throw new Error("Bale has already been repacked");
        if (originalBale.status === "SOLD") throw new Error("Cannot repack a sold bale");

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
            .set({ nextNumber: nextNumber + 1 })
            .where(eq(factoryBaleSequences.id, seqRecord.id));
        } else {
          nextNumber = 200000;
          await tx.insert(factoryBaleSequences).values({
            companyId,
            nextNumber: 200001,
          });
        }

        const newRefNum = `REF${String(nextNumber).padStart(6, "0")}`;

        const [newBale] = await tx
          .insert(factoryBales)
          .values({
            companyId: originalBale.companyId,
            mixBatchId: originalBale.mixBatchId,
            productId: originalBale.productId,
            pressingBatchId: originalBale.pressingBatchId,
            erpLocationId: originalBale.erpLocationId,
            baleCode: originalBale.baleCode,
            referenceNumber: newRefNum,
            articleCode: originalBale.articleCode,
            productName: originalBale.productName,
            category: originalBale.category,
            grade: originalBale.grade,
            quantity: originalBale.quantity,
            weightKg: originalBale.weightKg,
            costPerKg: originalBale.costPerKg,
            totalCost: originalBale.totalCost,
            status: "IN_STOCK",
            finalizedBy: originalBale.finalizedBy,
            workerName: originalBale.workerName,
            finalizedAt: originalBale.finalizedAt,
            stockEntryDate: originalBale.stockEntryDate,
          })
          .returning();

        const [productionAttribution] = await tx
          .select()
          .from(factoryBaleProductionAttributions)
          .where(
            and(
              eq(factoryBaleProductionAttributions.companyId, companyId),
              eq(factoryBaleProductionAttributions.baleId, id)
            )
          )
          .limit(1);
        if (productionAttribution) {
          await tx.insert(factoryBaleProductionAttributions).values({
            companyId,
            baleId: newBale.id,
            workerId: productionAttribution.workerId,
            workerNameSnapshot: productionAttribution.workerNameSnapshot,
            productionPositionId: productionAttribution.productionPositionId,
            productionPositionNameSnapshot: productionAttribution.productionPositionNameSnapshot,
            stockEntryDate: productionAttribution.stockEntryDate,
          });
        }

        await tx.update(factoryBales).set({ status: "REPACKED", updatedAt: new Date() }).where(eq(factoryBales.id, id));

        const repackResult = { originalBale, newBale, newRefNum };
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_bales",
            recordId: id,
            recordIdentifier: repackResult.originalBale.referenceNumber || `Bale #${id}`,
            changes: {
              status: { old: repackResult.originalBale.status, new: "REPACKED" },
              newBaleRef: { old: null, new: repackResult.newRefNum },
            },
          },
          tx
        );
        return repackResult;
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error repacking bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
