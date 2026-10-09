/**
 * containerTrackingRoutes.ts — API endpoints for container tracking.
 *
 * Status check: Offloaded/Closed/Completed in any casing are always rejected.
 * API keys are NEVER exposed to the client.
 * All routes require Admin, Developer, or Owner role.
 */

import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import { requireAuth } from "../auth";
import { containerTrackingEvents } from "../../shared/schema";
import { eq, desc } from "drizzle-orm";
import {
  getBulkProgress,
  getParcelsAppUsageStats,
  get17trackUsageStats,
  getTrackingProgress,
} from "../services/container-tracking";
import { isConfigured as isMaerskConfigured } from "../lib/trackingProviders/maerskProvider";
import { isEnabled as isMaerskPublicEnabled } from "../lib/trackingProviders/maerskPublicProvider";
import { isEnabled as isCmaPublicEnabled } from "../lib/trackingProviders/cmaPublicProvider";
import { isConfigured as is17trackConfigured } from "../lib/trackingProviders/seventeenTrackProvider";
import { isScraperAvailable } from "../lib/parcelsAppScraper";
import { isHttpScraperAvailable } from "../lib/httpTrackingScraper";

const ALLOWED_ROLES = ["Admin", "Developer", "Owner"] as const;

function requireAllowedRole(req: Request, res: Response): boolean {
  const role = req.user?.role;
  if (!ALLOWED_ROLES.includes(role as "Developer" | "Admin" | "Owner")) {
    res.status(403).json({ message: "Insufficient permissions" });
    return false;
  }
  return true;
}

export function registerContainerTrackingRoutes(app: Express) {
  // GET /api/container-tracking/:id/progress — live progress for in-flight Track Now
  app.get("/api/container-tracking/:id/progress", requireAuth, (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json([]);
      return;
    }
    res.json(getTrackingProgress(id));
  });

  // GET /api/container-tracking/status — provider config (no keys exposed)
  app.get("/api/container-tracking/status", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;

    const maerskConfigured = isMaerskConfigured();
    const maerskPublicEnabled = isMaerskPublicEnabled();
    const cmaPublicEnabled = isCmaPublicEnabled();
    const parcelsAppConfigured = !!process.env.PARCELSAPP_API_KEY;
    const publicProvidersEnabled = maerskPublicEnabled || cmaPublicEnabled;

    const directProviders: string[] = [];
    if (maerskConfigured) directProviders.push("maersk");
    if (maerskPublicEnabled) directProviders.push("maersk_public");
    if (cmaPublicEnabled) directProviders.push("cma_public");

    // Quota from DB — accurate even after server restarts
    const [
      { used: parcelsAppUsageThisMonth, limit: parcelsAppMonthlyLimit },
      { used: seventeenTrackUsage, limit: seventeenTrackLimit },
    ] = await Promise.all([getParcelsAppUsageStats(), get17trackUsageStats()]);

    const scraperAvailable = isScraperAvailable();
    const httpScraperAvailable = isHttpScraperAvailable();
    const seventeenConfigured = is17trackConfigured();

    const now = new Date();
    const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const parcelsAppRemaining = Math.max(0, parcelsAppMonthlyLimit - parcelsAppUsageThisMonth);

    // Smart scheduler budget
    const remainingDays = Math.max(1, Math.ceil((nextReset.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    const dailyBudget = Math.floor(parcelsAppRemaining / remainingDays);
    const perRunBudget = Math.max(1, Math.floor(dailyBudget / 4));

    res.json({
      configured:
        maerskConfigured ||
        maerskPublicEnabled ||
        cmaPublicEnabled ||
        parcelsAppConfigured ||
        scraperAvailable ||
        seventeenConfigured ||
        httpScraperAvailable,
      maerskConfigured,
      parcelsAppConfigured,
      publicProvidersEnabled,
      maerskPublicEnabled,
      cmaPublicEnabled,
      directProviders,
      fallbackProvider: "http_scraper",
      // ── HTTP scraper (no browser) ──────────────────────────────────────────
      httpScraperAvailable,
      // ── Puppeteer stealth scraper ──────────────────────────────────────────
      scraperAvailable,
      scraperStatus: scraperAvailable ? "ready" : "unavailable",
      // ── 17track ────────────────────────────────────────────────────────────
      seventeenTrackConfigured: seventeenConfigured,
      seventeenTrackUsageThisMonth: seventeenTrackUsage,
      seventeenTrackMonthlyLimit: seventeenTrackLimit,
      seventeenTrackRemaining: Math.max(0, seventeenTrackLimit - seventeenTrackUsage),
      seventeenTrackQuotaExhausted: seventeenTrackUsage >= seventeenTrackLimit,
      // ── ParcelsApp API ─────────────────────────────────────────────────────
      parcelsAppUsageThisMonth,
      parcelsAppMonthlyLimit,
      parcelsAppRemaining,
      parcelsAppQuotaExhausted: parcelsAppUsageThisMonth >= parcelsAppMonthlyLimit,
      parcelsAppNextResetDate: nextReset.toISOString().slice(0, 10),
      schedulerRemainingDays: remainingDays,
      schedulerDailyBudget: dailyBudget,
      schedulerPerRunBudget: perRunBudget,
    });
  });

  // POST /api/container-tracking/test-connection — verify ParcelsApp key works
  app.post("/api/container-tracking/test-connection", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({
      message:
        "Automated container tracking is disabled. Update container tracking fields manually or by Excel import.",
    });
  });

  // POST /api/container-tracking/:id/track-now — immediately track a single container
  app.post("/api/container-tracking/:id/track-now", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({
      message:
        "Automated container tracking is disabled. Update container tracking fields manually or by Excel import.",
    });
  });

  // GET /api/container-tracking/:id/events — list recent tracking events
  app.get("/api/container-tracking/:id/events", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;

    const containerId = parseInt(req.params.id, 10);
    if (isNaN(containerId)) {
      res.status(400).json({ message: "Invalid container ID" });
      return;
    }

    try {
      const events = await db
        .select()
        .from(containerTrackingEvents)
        .where(eq(containerTrackingEvents.containerId, containerId))
        .orderBy(desc(containerTrackingEvents.eventTime))
        .limit(100);
      res.json(events);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) ?? "Failed to load events" });
    }
  });

  // POST /api/container-tracking/bulk-settings
  app.post("/api/container-tracking/bulk-settings", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({
      message:
        "Automated container tracking is disabled. Update container tracking fields manually or by Excel import.",
    });
  });

  // GET /api/container-tracking/bulk-progress — live progress of the current bulk run
  app.get("/api/container-tracking/bulk-progress", requireAuth, (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    res.json(getBulkProgress());
  });

  // POST /api/container-tracking/bulk-track-now
  app.post("/api/container-tracking/bulk-track-now", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({
      message:
        "Automated container tracking is disabled. Update container tracking fields manually or by Excel import.",
    });
  });

  // POST /api/container-tracking/:id/debug-eta
  // Runs maersk_direct and maersk_public against a container and returns
  // safe diagnostic JSON (no API keys, no full payloads) describing what
  // each provider returned and where the ETA was or was not found.
  app.post("/api/container-tracking/:id/debug-eta", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({
      message:
        "Automated container tracking is disabled. Update container tracking fields manually or by Excel import.",
    });
  });

  // PATCH /api/container-tracking/:id/settings
  app.patch("/api/container-tracking/:id/settings", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({
      message:
        "Automated container tracking is disabled. Update container tracking fields manually or by Excel import.",
    });
  });
}
