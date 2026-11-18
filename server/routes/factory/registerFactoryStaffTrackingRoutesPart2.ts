// Extracted from ./factoryStaffTrackingRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factoryStaffTrackingMessages } from "../../i18n/factoryStaffTrackingMessages";
import { getErrorMessage } from "../../lib/httpHandlers";
import { factoryWorkers } from "@shared/schema";
import { numberOrNull } from "./factoryStaffTrackingValueHelpers";
import {
  canAccessTrackingPage,
  getFactoryCompanyId,
  ISO_DATE,
  loadWorkerGroupNames,
} from "./factoryStaffTrackingQueries";

export function registerFactoryStaffTrackingRoutesPart2(app: Express) {
  app.post(
    "/api/factory/staff-tracking/production-target-defaults",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: factoryStaffTrackingMessages.noFactoryCompany });
        if (!(await canAccessTrackingPage(req, companyId, "production"))) {
          return res.status(403).json({ message: factoryStaffTrackingMessages.forbiddenTab });
        }

        const effectiveFrom = String(req.body?.effectiveFrom || "");
        const records = Array.isArray(req.body?.records) ? req.body.records : [];
        if (!ISO_DATE.test(effectiveFrom)) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidPeriod });
        }
        if (records.length === 0 || records.length > 500) {
          return res.status(400).json({ message: factoryStaffTrackingMessages.invalidRecordCount });
        }

        const allWorkers = await db
          .select({ id: factoryWorkers.id })
          .from(factoryWorkers)
          .where(eq(factoryWorkers.companyId, companyId));
        const workerIds = new Set(allWorkers.map((row) => row.id));
        const workerGroupNames = await loadWorkerGroupNames(companyId);
        const normalized: Array<{ workerId: number; category: string; targetBales: number | null }> = [];
        const seen = new Set<number>();

        for (const raw of records) {
          const workerId = Number(raw?.workerId);
          const category = String(raw?.category ?? "")
            .trim()
            .slice(0, 150);
          const targetBales = numberOrNull(raw?.targetBales);

          if (!Number.isInteger(workerId) || workerId <= 0 || !workerIds.has(workerId)) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.personOutsideFactory });
          }
          if (!workerGroupNames.has(workerId)) {
            return res.status(400).json({ message: "Worker is not assigned to a saved Production Planner group" });
          }
          if (seen.has(workerId)) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.duplicatePersonInBatch });
          }
          if (
            raw?.targetBales !== null &&
            raw?.targetBales !== undefined &&
            raw?.targetBales !== "" &&
            targetBales === null
          ) {
            return res.status(400).json({ message: factoryStaffTrackingMessages.invalidBaleNumbers });
          }

          seen.add(workerId);
          normalized.push({ workerId, category, targetBales });
        }

        const values = normalized.map(
          ({ workerId, category, targetBales }) => sql`(
          ${companyId}, ${workerId}, ${effectiveFrom}, ${category}, ${targetBales},
          ${req.session.userId || null}, now(), now()
        )`
        );

        await db.execute(sql`
        INSERT INTO factory_worker_production_target_defaults (
          company_id, worker_id, effective_from, category, target_bales, created_by, created_at, updated_at
        ) VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (company_id, worker_id, effective_from)
        DO UPDATE SET
          category = EXCLUDED.category,
          target_bales = EXCLUDED.target_bales,
          created_by = EXCLUDED.created_by,
          updated_at = now()
      `);

        res.json({ success: true, saved: normalized.length, effectiveFrom });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
