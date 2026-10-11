/**
 * factoryIntelligenceRoutes: FactoryAlert endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, desc, sql } from "drizzle-orm";
import type { AppDb, AuthMiddleware } from "../routeBoundaryTypes";

import {
  factoryAlerts,
  factoryContainers,
  factoryWorkers,
  containerFreight,
  containerFreightPayments,
  containerDocuments,
  containerDocumentTypes,
} from "@shared/schema";
import { plusMoney, toMoney } from "../../lib/money";

export function registerFactoryAlertRoutes(app: Express, requireAuth: AuthMiddleware, db: AppDb) {
  app.get("/api/factory/alerts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select()
        .from(factoryAlerts)
        .where(and(eq(factoryAlerts.companyId, companyId), eq(factoryAlerts.isRead, false)))
        .orderBy(desc(factoryAlerts.createdAt))
        .limit(50);

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching factory alerts:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/alerts/:id/read", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      const [updated] = await db
        .update(factoryAlerts)
        .set({ isRead: true })
        .where(and(eq(factoryAlerts.id, id), eq(factoryAlerts.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Alert not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error marking alert as read:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/alerts/generate", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      let newAlertCount = 0;
      const today = getClientDate(req);

      const existingAlerts = await db
        .select()
        .from(factoryAlerts)
        .where(and(eq(factoryAlerts.companyId, companyId), eq(factoryAlerts.isRead, false)));

      const alertExists = (type: string, entityType: string, entityId: number) => {
        return existingAlerts.some((a) => a.type === type && a.entityType === entityType && a.entityId === entityId);
      };

      const requiredDocTypes = await db
        .select()
        .from(containerDocumentTypes)
        .where(
          and(
            eq(containerDocumentTypes.isRequired, true),
            sql`(${containerDocumentTypes.companyId} = ${companyId} OR ${containerDocumentTypes.companyId} IS NULL)`
          )
        );
      const requiredDocTypeCount = requiredDocTypes.length;
      const requiredDocTypeIds = requiredDocTypes.map((d) => d.id);

      if (requiredDocTypeCount > 0) {
        const allContainers = await db
          .select()
          .from(factoryContainers)
          .where(eq(factoryContainers.companyId, companyId));

        const docs = await db.select().from(containerDocuments).where(eq(containerDocuments.companyId, companyId));

        for (const container of allContainers) {
          const containerDocs = docs.filter((d) => d.containerId === container.id);
          const uploadedRequiredIds = new Set(
            containerDocs.filter((d) => requiredDocTypeIds.includes(d.docTypeId)).map((d) => d.docTypeId)
          );
          if (uploadedRequiredIds.size < requiredDocTypeCount) {
            if (!alertExists("MISSING_DOCS", "container", container.id)) {
              await db.insert(factoryAlerts).values({
                companyId,
                type: "MISSING_DOCS",
                severity: "warning",
                title: `Container ${container.containerNumber} missing documents`,
                message: `Container is missing ${requiredDocTypeCount - uploadedRequiredIds.size} required document(s).`,
                entityType: "container",
                entityId: container.id,
              });
              newAlertCount++;
            }
          }
        }
      }

      const freightEntries = await db.select().from(containerFreight).where(eq(containerFreight.companyId, companyId));

      const freightPayments = await db
        .select()
        .from(containerFreightPayments)
        .where(eq(containerFreightPayments.companyId, companyId));

      for (const f of freightEntries) {
        if (!f.dueDate) continue;
        if (f.dueDate >= today) continue;

        const amount = toMoney(f.freightAmount).toNumber();
        const paid = freightPayments
          .filter((p) => p.containerFreightId === f.id)
          .reduce((s: number, p) => plusMoney(s, p.amount), 0);

        if (amount - paid > 0.01) {
          if (!alertExists("FREIGHT_OVERDUE", "freight", f.id)) {
            await db.insert(factoryAlerts).values({
              companyId,
              type: "FREIGHT_OVERDUE",
              severity: "error",
              title: `Freight overdue: ${f.vendorName || "Unknown vendor"}`,
              message: `Freight of ${amount.toFixed(2)} was due on ${f.dueDate}. Remaining: ${(amount - paid).toFixed(2)}.`,
              entityType: "freight",
              entityId: f.id,
            });
            newAlertCount++;
          }
        }
      }

      const workers = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.companyId, companyId), eq(factoryWorkers.active, true)));

      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
      const thirtyDaysStr = thirtyDaysFromNow.toISOString().split("T")[0];

      for (const worker of workers) {
        if (!worker.contractEndDate) continue;
        if (worker.contractEndDate <= thirtyDaysStr && worker.contractEndDate >= today) {
          if (!alertExists("CONTRACT_EXPIRING", "worker", worker.id)) {
            await db.insert(factoryAlerts).values({
              companyId,
              type: "CONTRACT_EXPIRING",
              severity: "warning",
              title: `Contract expiring: ${worker.fullName}`,
              message: `Worker ${worker.fullName}'s contract expires on ${worker.contractEndDate}.`,
              entityType: "worker",
              entityId: worker.id,
            });
            newAlertCount++;
          }
        }
      }

      res.json({ newAlerts: newAlertCount });
    } catch (error: unknown) {
      logger.error("Error generating alerts:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 7. Supplier Scoring
  // ───────────────────────────────────────────────
}
