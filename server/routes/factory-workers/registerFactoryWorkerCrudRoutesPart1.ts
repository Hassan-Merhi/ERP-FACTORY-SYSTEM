// Extracted from ./crud.ts
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import { eq, and } from "drizzle-orm";
import { factoryWorkers } from "@shared/schema";
import { checkFactoryWorkerContractAccess, getFactoryCompanyId, writeDaybookEntry } from "./_helpers";
import { removeFactoryWorkerFromCategories } from "../../lib/factoryWorkerCategoryMembership";
import { recordInactiveDays } from "./crudRecordInactiveDays";

export function registerFactoryWorkerCrudRoutesPart1(app: Express, requireAuth: RequestHandler, db: Database) {
  // PATCH /api/factory/workers/:id - Update worker
  app.patch("/api/factory/workers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [previousWorker] = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)));
      if (!previousWorker) return res.status(404).json({ message: "Worker not found" });
      const todayForStatus = getClientDate(req);
      const updateData = { ...req.body };
      const becomingInactive = previousWorker.active && updateData.active === false;
      const becomingActive = !previousWorker.active && updateData.active === true;
      if (becomingInactive && !updateData.contractEndDate) updateData.contractEndDate = todayForStatus;
      if (!previousWorker.active && !becomingActive && !updateData.contractEndDate) {
        updateData.contractEndDate = previousWorker.contractEndDate;
      }
      if (becomingActive) updateData.contractEndDate = null;
      for (const f of [
        "dateOfBirth",
        "dateJoined",
        "contractStartDate",
        "contractEndDate",
        "visaExpiry",
        "workPermitExpiry",
        "residentialPermitExpiry",
      ]) {
        if (updateData[f] === "" || updateData[f] === undefined) updateData[f] = null;
      }
      for (const f of [
        "baseSalary",
        "perBaleRate",
        "perKgRate",
        "overtimeRate",
        "hourlyRate",
        "weeklySalary",
        "biWeeklySalary",
      ]) {
        if (updateData[f] === "" || updateData[f] === undefined) updateData[f] = "0";
      }
      if (updateData.transportAllowance === "") updateData.transportAllowance = null;
      if (updateData.numberOfChildren === "" || updateData.numberOfChildren === undefined)
        updateData.numberOfChildren = 0;
      const [updated] = await db
        .update(factoryWorkers)
        .set({ ...updateData, updatedAt: new Date() })
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Worker not found" });

      if (becomingInactive) {
        const tomorrow = new Date(Date.parse(`${todayForStatus}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        await recordInactiveDays(db, companyId, updated.id, todayForStatus, tomorrow);
      }
      if (becomingActive) {
        const inactiveStart =
          previousWorker.contractEndDate || previousWorker.updatedAt?.toISOString().slice(0, 10) || todayForStatus;
        await recordInactiveDays(db, companyId, updated.id, inactiveStart, todayForStatus);
      }
      if (!updated.active) {
        await removeFactoryWorkerFromCategories(db, companyId, updated.id);
      }

      const today = getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "WORKER_EDITED",
        referenceId: updated.id,
        referenceTable: "factory_workers",
        description: `Worker updated: ${updated.fullName}`,
        createdBy: req.session.userId ?? undefined,
      });

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating factory worker:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/workers/:id/end-contract - End contract
  app.post("/api/factory/workers/:id/end-contract", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!checkFactoryWorkerContractAccess(req, res)) return;
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const today = getClientDate(req);

      const [previousWorker] = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)));
      if (!previousWorker) return res.status(404).json({ message: "Worker not found" });
      const [updated] = await db
        .update(factoryWorkers)
        .set({ active: false, contractEndDate: today, updatedAt: new Date() })
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Worker not found" });

      if (previousWorker.active) {
        const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        await recordInactiveDays(db, companyId, updated.id, today, tomorrow);
      }
      await removeFactoryWorkerFromCategories(db, companyId, updated.id);

      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "CONTRACT_ENDED",
        referenceId: updated.id,
        referenceTable: "factory_workers",
        description: `Contract ended for worker: ${updated.fullName} (${updated.employeeCode || "N/A"})`,
        createdBy: req.session.userId ?? undefined,
      });

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error ending worker contract:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/workers/:id/reactivate - Reactivate an inactive worker
  app.post("/api/factory/workers/:id/reactivate", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const today = getClientDate(req);

      const [previousWorker] = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)));
      if (!previousWorker) return res.status(404).json({ message: "Worker not found" });
      const [updated] = await db
        .update(factoryWorkers)
        .set({ active: true, contractEndDate: null, updatedAt: new Date() })
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Worker not found" });

      if (!previousWorker.active) {
        const inactiveStart =
          previousWorker.contractEndDate || previousWorker.updatedAt?.toISOString().slice(0, 10) || today;
        await recordInactiveDays(db, companyId, updated.id, inactiveStart, today);
      }

      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "CONTRACT_REACTIVATED",
        referenceId: updated.id,
        referenceTable: "factory_workers",
        description: `Contract reactivated for worker: ${updated.fullName} (${updated.employeeCode || "N/A"})`,
        createdBy: req.session.userId ?? undefined,
      });

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error reactivating worker:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
