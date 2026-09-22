import type { Express, Request, Response } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factoryStaffTrackingMessages } from "../../i18n/factoryStaffTrackingMessages";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { factoryUserProfiles, factoryWorkers } from "@shared/schema";
import {
  createProductionWorkerLink,
  loadActiveProductionWorkerLinks,
  unlinkProductionWorkerLink,
} from "../../services/factory/productionWorkerLinks";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function getFactoryCompanyId(req: Request): number | undefined {
  return req.session.factoryCompanyId || req.session.currentCompanyId;
}

async function canAccessProductionTargets(req: Request, companyId: number): Promise<boolean> {
  const role = String(req.session.currentRole || req.user?.role || "");
  if (["Admin", "Owner", "Developer"].includes(role)) return true;

  const userId = req.session.userId;
  if (!userId) return false;

  const [profile] = await db
    .select({ hiddenCostFields: factoryUserProfiles.hiddenCostFields })
    .from(factoryUserProfiles)
    .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, userId)))
    .limit(1);

  return !(profile?.hiddenCostFields ?? []).includes("hide_tab_stockentry_production_targets");
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseWorkerIds(value: unknown): number[] {
  const parsed = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
      const json = JSON.parse(value);
      return Array.isArray(json) ? json : [];
    } catch {
      return [];
    }
  })();

  return parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

async function loadPlannerWorkerIds(companyId: number): Promise<Set<number>> {
  const result = await db.execute(sql`
    SELECT worker_ids AS "workerIds"
    FROM factory_worker_categories
    WHERE company_id = ${companyId}
  `);
  const ids = new Set<number>();
  for (const row of resultRows(result) as Array<{ workerIds: unknown }>) {
    for (const workerId of parseWorkerIds(row.workerIds)) ids.add(workerId);
  }
  return ids;
}

async function hasFinalizedProductionOnOrAfter(companyId: number, effectiveDate: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM factory_staff_tracking_period_closures
    WHERE company_id = ${companyId}
      AND page_type = 'production'
      AND period_type = 'daily'
      AND period_start >= ${effectiveDate}
    LIMIT 1
  `);
  return resultRows(result).length > 0;
}

export function registerFactoryProductionWorkerLinkRoutes(app: Express): void {
  app.get("/api/factory/staff-tracking/production-worker-links", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
      if (!(await canAccessProductionTargets(req, companyId))) {
        return res.status(403).json({ message: factoryStaffTrackingMessages.forbiddenTab });
      }

      const asOf = String(req.query.asOf || "");
      if (!ISO_DATE.test(asOf)) {
        return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
      }

      res.json({ asOf, links: await loadActiveProductionWorkerLinks(companyId, asOf) });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/staff-tracking/production-worker-links", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
      if (!(await canAccessProductionTargets(req, companyId))) {
        return res.status(403).json({ message: factoryStaffTrackingMessages.forbiddenTab });
      }

      const effectiveFrom = String(req.body?.effectiveFrom || "");
      const rawWorkerIds: unknown[] = Array.isArray(req.body?.workerIds) ? req.body.workerIds : [];
      const workerIds = [
        ...new Set(
          rawWorkerIds
            .map((value: unknown) => Number(value))
            .filter((id: number) => Number.isInteger(id) && id > 0)
        ),
      ];
      const targetBales = numberOrNull(req.body?.targetBales);

      if (!ISO_DATE.test(effectiveFrom)) {
        return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
      }
      if (workerIds.length < 2 || workerIds.length > 10) {
        return res.status(400).json({ message: "Link between 2 and 10 workers" });
      }
      if (
        req.body?.targetBales !== null &&
        req.body?.targetBales !== undefined &&
        req.body?.targetBales !== "" &&
        targetBales === null
      ) {
        return res.status(400).json({ message: factoryStaffTrackingMessages.invalidBaleNumbers });
      }
      if (await hasFinalizedProductionOnOrAfter(companyId, effectiveFrom)) {
        return res.status(409).json({
          message: "Worker links cannot be changed from a date that already has finalized production history",
        });
      }

      const workers = await db
        .select({ id: factoryWorkers.id })
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), inArray(factoryWorkers.id, workerIds)));
      if (workers.length !== workerIds.length) {
        return res.status(400).json({ message: factoryStaffTrackingMessages.personOutsideFactory });
      }

      const plannerWorkerIds = await loadPlannerWorkerIds(companyId);
      if (workerIds.some((workerId) => !plannerWorkerIds.has(workerId))) {
        return res.status(400).json({ message: "Worker is not assigned to a saved Production Planner group" });
      }

      const linkId = await createProductionWorkerLink({
        companyId,
        effectiveFrom,
        workerIds,
        targetBales,
        createdBy: req.session.userId || null,
      });

      res.json({
        success: true,
        linkId,
        links: await loadActiveProductionWorkerLinks(companyId, effectiveFrom),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/factory/staff-tracking/production-worker-links/:linkId/unlink",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
        if (!(await canAccessProductionTargets(req, companyId))) {
          return res.status(403).json({ message: factoryStaffTrackingMessages.forbiddenTab });
        }

        const linkId = Number(req.params.linkId);
        const effectiveTo = String(req.body?.effectiveTo || "");
        if (!Number.isInteger(linkId) || linkId <= 0 || !ISO_DATE.test(effectiveTo)) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
        }
        if (await hasFinalizedProductionOnOrAfter(companyId, effectiveTo)) {
          return res.status(409).json({
            message: "Worker links cannot be changed from a date that already has finalized production history",
          });
        }

        const unlinked = await unlinkProductionWorkerLink({
          companyId,
          linkId,
          effectiveTo,
          createdBy: req.session.userId || null,
        });
        if (!unlinked) return res.status(404).json({ message: "Worker link not found" });

        res.json({
          success: true,
          links: await loadActiveProductionWorkerLinks(companyId, effectiveTo),
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
