import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { parseId } from "../../lib/parseId";
import { eq, desc } from "drizzle-orm";
import {
  factoryContainers,
  factoryContainerTrackingEvents,
  factoryContainerTrackingChecks,
} from "../../../shared/schema";
import { getFactoryTrackingProgress } from "../../services/factory-container-tracking";
import { getFactoryEtaTrackingSummary } from "../../services/factoryJsonCargoTrackingService";
import { requireNonPOS } from "../../auth";

export function registerFactoryContainerTrackingRoutes(app: Express) {
  // POST /api/factory/containers/:id/refresh-eta — JSONCargo ETA-only refresh
  app.post(
    "/api/factory/containers/:id/refresh-eta",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response) => {
      try {
        return res
          .status(410)
          .json({ message: "Automated container tracking is disabled. Update container data manually or by import." });
      } catch (err: unknown) {
        const status = getErrorMessage(err)?.includes("not found") ? 404 : 500;
        res.status(status).json({ message: getErrorMessage(err) || "Failed to refresh ETA" });
      }
    }
  );

  // POST /api/factory/containers/refresh-etas — bulk JSONCargo ETA refresh (admin-only)
  app.post("/api/factory/containers/refresh-etas", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      return res
        .status(410)
        .json({ message: "Automated container tracking is disabled. Update container data manually or by import." });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) || "Failed to refresh ETAs" });
    }
  });

  // GET /api/factory/containers/eta-tracking-summary — dashboard summary, no secrets
  app.get(
    "/api/factory/containers/eta-tracking-summary",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        const summary = await getFactoryEtaTrackingSummary(companyId);
        res.json(summary);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) || "Failed to fetch ETA tracking summary" });
      }
    }
  );

  // GET /api/factory/container-tracking/:id/events — tracking event history
  app.get("/api/factory/container-tracking/:id/events", requireAuth, async (req: Request, res: Response) => {
    try {
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid container id" });

      // Verify container belongs to the user's factory company
      const [container] = await db
        .select({ id: factoryContainers.id, companyId: factoryContainers.companyId })
        .from(factoryContainers)
        .where(eq(factoryContainers.id, containerId))
        .limit(1);

      if (!container) return res.status(404).json({ message: "Container not found" });

      const events = await db
        .select()
        .from(factoryContainerTrackingEvents)
        .where(eq(factoryContainerTrackingEvents.containerId, containerId))
        .orderBy(desc(factoryContainerTrackingEvents.eventTime));

      res.json(events);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) || "Failed to fetch tracking events" });
    }
  });

  // GET /api/factory/container-tracking/:id/checks — tracking check history
  app.get("/api/factory/container-tracking/:id/checks", requireAuth, async (req: Request, res: Response) => {
    try {
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid container id" });

      const [container] = await db
        .select({ id: factoryContainers.id })
        .from(factoryContainers)
        .where(eq(factoryContainers.id, containerId))
        .limit(1);

      if (!container) return res.status(404).json({ message: "Container not found" });

      const checks = await db
        .select({
          id: factoryContainerTrackingChecks.id,
          provider: factoryContainerTrackingChecks.provider,
          status: factoryContainerTrackingChecks.status,
          checkedAt: factoryContainerTrackingChecks.checkedAt,
          errorMessage: factoryContainerTrackingChecks.errorMessage,
        })
        .from(factoryContainerTrackingChecks)
        .where(eq(factoryContainerTrackingChecks.containerId, containerId))
        .orderBy(desc(factoryContainerTrackingChecks.checkedAt))
        .limit(50);

      res.json(checks);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) || "Failed to fetch tracking checks" });
    }
  });

  // GET /api/factory/container-tracking/:id/progress — live tracking progress (SSE or polling)
  app.get("/api/factory/container-tracking/:id/progress", requireAuth, async (req: Request, res: Response) => {
    try {
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid container id" });
      const steps = getFactoryTrackingProgress(containerId);
      res.json(steps);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) || "Failed to fetch tracking progress" });
    }
  });

  // POST /api/factory/container-tracking/:id/track-now — manually trigger tracking
  app.post("/api/factory/container-tracking/:id/track-now", requireAuth, async (req: Request, res: Response) => {
    try {
      return res
        .status(410)
        .json({ message: "Automated container tracking is disabled. Update container data manually or by import." });
    } catch (err: unknown) {
      const status =
        (err as { code?: string }).code === "TRACKING_BUSY" || getErrorMessage(err) === "PUPPETEER_QUEUE_FULL"
          ? 429
          : getErrorMessage(err)?.includes("not found")
            ? 404
            : getErrorMessage(err)?.includes("disabled")
              ? 400
              : getErrorMessage(err)?.includes("quota")
                ? 429
                : 500;
      res
        .status(status)
        .json({ message: getErrorMessage(err) || "Tracking failed", code: (err as { code?: string }).code ?? null });
    }
  });

  // PATCH /api/factory/container-tracking/:id/settings — enable/disable tracking
  app.patch("/api/factory/container-tracking/:id/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      return res
        .status(410)
        .json({ message: "Automated container tracking is disabled. Update container data manually or by import." });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) || "Failed to update tracking settings" });
    }
  });
}
