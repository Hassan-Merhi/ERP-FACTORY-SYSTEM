// Extracted from ./balesMaintenanceRoutes.ts
import type { Express, Request, Response } from "express";
import { lineAmount, parseMoneyInput, toMoney } from "../../../lib/money";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBales,
  customerOrderBales,
  factoryWorkers,
  factoryV3LoadBales,
  factoryInvoiceLoadingBales,
  factoryBaleProductionAttributions,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";

export function registerBalesMaintenanceRoutesPart1(app: Express) {
  app.patch("/api/factory/bales/:id/assign-worker", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { workerId } = req.body;
      if (!workerId) return res.status(400).json({ message: "workerId is required" });
      const numericWorkerId = Number(workerId);
      if (!Number.isInteger(numericWorkerId) || numericWorkerId <= 0) {
        return res.status(400).json({ message: "Invalid workerId" });
      }
      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(
          and(
            eq(factoryWorkers.id, numericWorkerId),
            eq(factoryWorkers.companyId, companyId),
            eq(factoryWorkers.active, true)
          )
        )
        .limit(1);
      if (!worker) return res.status(400).json({ message: "Worker is inactive or belongs to another company" });

      const updated = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const [updatedBale] = await tx
          .update(factoryBales)
          .set({ finalizedBy: numericWorkerId, workerName: worker.fullName, updatedAt: new Date() })
          .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
          .returning();
        if (!updatedBale) return null;

        // A worker-only correction must not silently move production between
        // teams. Preserve the position snapshot, but keep the worker snapshot
        // synchronized for Stock Entry bales that have attribution records.
        await tx
          .update(factoryBaleProductionAttributions)
          .set({ workerId: numericWorkerId, workerNameSnapshot: worker.fullName })
          .where(
            and(
              eq(factoryBaleProductionAttributions.companyId, companyId),
              eq(factoryBaleProductionAttributions.baleId, id)
            )
          );
        return updatedBale;
      });

      if (!updated) return res.status(404).json({ message: "Bale not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error assigning worker to bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Bulk assign worker to multiple bales (for stock entry history groups) ──
  app.patch("/api/factory/bales/bulk-assign-worker", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { baleIds, workerId } = req.body;
      if (!Array.isArray(baleIds) || baleIds.length === 0)
        return res.status(400).json({ message: "baleIds array is required" });
      if (!workerId) return res.status(400).json({ message: "workerId is required" });
      const numericIds = [...new Set(baleIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (numericIds.length === 0) return res.status(400).json({ message: "No valid bale IDs supplied" });
      const numericWorkerId = Number(workerId);
      if (!Number.isInteger(numericWorkerId) || numericWorkerId <= 0) {
        return res.status(400).json({ message: "Invalid workerId" });
      }
      const [worker] = await db
        .select({ fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(
          and(
            eq(factoryWorkers.id, numericWorkerId),
            eq(factoryWorkers.companyId, companyId),
            eq(factoryWorkers.active, true)
          )
        )
        .limit(1);
      if (!worker) return res.status(400).json({ message: "Worker is inactive or belongs to another company" });

      const updatedIds = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const updatedBales = await tx
          .update(factoryBales)
          .set({ finalizedBy: numericWorkerId, workerName: worker.fullName, updatedAt: new Date() })
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, numericIds)))
          .returning({ id: factoryBales.id });
        const ids = updatedBales.map((bale) => bale.id);
        if (ids.length > 0) {
          await tx
            .update(factoryBaleProductionAttributions)
            .set({ workerId: numericWorkerId, workerNameSnapshot: worker.fullName })
            .where(
              and(
                eq(factoryBaleProductionAttributions.companyId, companyId),
                inArray(factoryBaleProductionAttributions.baleId, ids)
              )
            );
        }
        return ids;
      });

      res.json({ updated: updatedIds.length, workerId: numericWorkerId });
    } catch (error: unknown) {
      logger.error("Error bulk-assigning worker:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Correct bale weight (cascades to load bales, invoice bales, order bales) ──
  app.patch("/api/factory/bales/:id/weight", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const rawWeight = parseMoneyInput(req.body.weightKg)?.toNumber() ?? NaN;
      if (isNaN(rawWeight) || rawWeight <= 0) {
        return res.status(400).json({ message: "weightKg must be a positive number" });
      }
      const newWeightStr = rawWeight.toFixed(3);

      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        // Fetch bale and verify ownership
        const [bale] = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

        if (!bale) throw new Error("Bale not found");

        // Exact weight x rate, rounded once: 3.000 kg at 1.115 is 3.35, not 3.34.
        const newTotalCost = lineAmount(newWeightStr, bale.costPerKg).toFixed(2);
        const oldWeight = toMoney(bale.weightKg).toNumber();

        // 1. Update the bale itself
        const [updatedBale] = await tx
          .update(factoryBales)
          .set({
            weightKg: newWeightStr,
            totalCost: newTotalCost,
            updatedAt: new Date(),
          })
          .where(eq(factoryBales.id, id))
          .returning();

        // 2. Update factory_v3_load_bales (loading order scans)
        const loadBalesResult = await tx
          .update(factoryV3LoadBales)
          .set({ weightKg: newWeightStr })
          .where(eq(factoryV3LoadBales.baleId, id));

        // 3. Update factory_invoice_loading_bales (invoice loading session scans)
        const invoiceBalesResult = await tx
          .update(factoryInvoiceLoadingBales)
          .set({ weightKg: newWeightStr })
          .where(eq(factoryInvoiceLoadingBales.baleId, id));

        // 4. Update customer_order_bales (weight column is "weight", not "weightKg")
        const orderBalesResult = await tx
          .update(customerOrderBales)
          .set({ weight: newWeightStr })
          .where(eq(customerOrderBales.baleId, id));

        const weightResult = {
          bale: updatedBale,
          oldWeight,
          newWeight: rawWeight,
          updatedLoadBales: loadBalesResult?.rowCount ?? 0,
          updatedInvoiceBales: invoiceBalesResult?.rowCount ?? 0,
          updatedOrderBales: orderBalesResult?.rowCount ?? 0,
        };
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_bales",
            recordId: id,
            recordIdentifier: weightResult.bale.referenceNumber || `Bale #${id}`,
            changes: { weightKg: { old: weightResult.oldWeight, new: weightResult.newWeight } },
          },
          tx
        );
        return weightResult;
      });

      res.json({
        success: true,
        baleId: id,
        referenceNumber: result.bale.referenceNumber,
        oldWeight: result.oldWeight,
        newWeight: result.newWeight,
        updatedLoadBales: result.updatedLoadBales,
        updatedInvoiceBales: result.updatedInvoiceBales,
        updatedOrderBales: result.updatedOrderBales,
      });
    } catch (error: unknown) {
      logger.error("Error correcting bale weight:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
