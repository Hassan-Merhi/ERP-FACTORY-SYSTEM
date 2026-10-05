/**
 * containerTrackingRoutes.ts — API endpoints for container tracking.
 *
 * Status check: Offloaded/Closed/Completed in any casing are always rejected.
 * API keys are NEVER exposed to the client.
 * All routes require Admin, Developer, or Owner role.
 */

import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { requireAuth } from "../auth";
import { containers, containerTrackingEvents } from "../../shared/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import {
  trackOneContainerById,
  trackAllEnabledNow,
  isBulkTrackingRunning,
  getBulkProgress,
  setBulkTrackingEnabled,
  getParcelsAppUsageStats,
  get17trackUsageStats,
  getTrackingProgress,
  isTrackingAtCapacity,
} from "../services/container-tracking";
import { testConnection } from "../lib/parcelsAppClient";
import { isConfigured as isMaerskConfigured } from "../lib/trackingProviders/maerskProvider";
import {
  isEnabled as isMaerskPublicEnabled,
  track as maerskPublicTrack,
} from "../lib/trackingProviders/maerskPublicProvider";
import { isEnabled as isCmaPublicEnabled } from "../lib/trackingProviders/cmaPublicProvider";
import { isConfigured as is17trackConfigured } from "../lib/trackingProviders/seventeenTrackProvider";
import { isScraperAvailable } from "../lib/parcelsAppScraper";
import { isHttpScraperAvailable } from "../lib/httpTrackingScraper";
import { scrapeMaerskDirect, isMaerskDirectScraperAvailable, deepScanForEta } from "../lib/maerskDirectScraper";

const ALLOWED_ROLES = ["Admin", "Developer", "Owner"] as const;

const INACTIVE_LOWER = ["offloaded", "closed", "completed"];
function isInactiveStatus(status: string): boolean {
  return INACTIVE_LOWER.includes(status.toLowerCase());
}

function requireAllowedRole(req: Request, res: Response): boolean {
  const role = req.user?.role;
  if (!ALLOWED_ROLES.includes(role as "Developer" | "Admin" | "Owner")) {
    res.status(403).json({ message: "Insufficient permissions" });
    return false;
  }
  return true;
}

function anyProviderAvailable(): boolean {
  return (
    isMaerskConfigured() ||
    isMaerskPublicEnabled() ||
    isCmaPublicEnabled() ||
    !!process.env.PARCELSAPP_API_KEY ||
    is17trackConfigured() ||
    isScraperAvailable() ||
    isHttpScraperAvailable() // always true — built-in HTTP endpoints need no config
  );
}

const updateTrackingSettingsSchema = z.object({
  trackingEnabled: z.boolean().optional(),
  trackingAutoUpdate: z.boolean().optional(),
  trackingCarrierHint: z.string().max(100).nullable().optional(),
  trackingProvider: z.string().max(50).nullable().optional(),
});

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
    return res.status(410).json({ message: "Automated container tracking is disabled. Update container tracking fields manually or by Excel import." });
    try {
      const result = await testConnection();
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: getErrorMessage(err) });
    }
  });

  // POST /api/container-tracking/:id/track-now — immediately track a single container
  app.post("/api/container-tracking/:id/track-now", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({ message: "Automated container tracking is disabled. Update container tracking fields manually or by Excel import." });

    const containerId = parseInt(req.params.id, 10);
    if (isNaN(containerId)) {
      res.status(400).json({ message: "Invalid container ID" });
      return;
    }

    if (!anyProviderAvailable()) {
      res.status(400).json({
        message:
          "No tracking provider is configured. Add MAERSK_CONSUMER_KEY / MAERSK_CONSUMER_SECRET, " +
          "enable PUBLIC_CARRIER_TRACKING_ENABLED=true, or add PARCELSAPP_API_KEY.",
      });
      return;
    }

    try {
      const [row] = await db
        .select({ id: containers.id, containerNumber: containers.containerNumber, status: containers.status })
        .from(containers)
        .where(eq(containers.id, containerId))
        .limit(1);

      if (!row) {
        res.status(404).json({ message: "Container not found" });
        return;
      }

      // Case-insensitive inactive check
      if (isInactiveStatus(row.status)) {
        res.status(409).json({
          message: "Tracking is disabled for offloaded/closed/completed containers.",
        });
        return;
      }

      // Quota check — only hard-block if ALL fallback providers are also unavailable
      const { used, limit } = await getParcelsAppUsageStats();
      const remaining = Math.max(0, limit - used);
      const hasDirectProvider = isMaerskConfigured() || isMaerskPublicEnabled() || isCmaPublicEnabled();
      const hasFallbackProvider = is17trackConfigured() || isScraperAvailable() || isHttpScraperAvailable();

      if (remaining === 0 && !hasDirectProvider && !hasFallbackProvider) {
        res.status(402).json({
          message: `ParcelsApp monthly quota exhausted (${used}/${limit}) and no alternative providers are configured. Track Now is not available.`,
        });
        return;
      }

      // Reject early when the server is already at its concurrent tracking cap.
      if (isTrackingAtCapacity()) {
        res.status(429).json({
          message: "Server is busy — too many tracking jobs in flight. Try again shortly.",
          code: "TRACKING_BUSY",
        });
        return;
      }

      // Fire tracking in the background — providers (especially Puppeteer/scraper) can
      // take well over 2 minutes, so we return 202 immediately and let the client poll.
      logger.info(`[TrackNow] ${row.containerNumber}: starting background track...`);
      res.status(202).json({ started: true, containerNumber: row.containerNumber });

      trackOneContainerById(containerId)
        .then((r) => {
          logger.info(
            `[TrackNow] ${row.containerNumber}: done — success=${r.success} ` +
              `provider=${r.provider ?? "none"} oldEta=${r.oldEta ?? "null"} newEta=${r.newEta ?? "null"}`
          );
        })
        .catch((err) => {
          logger.error(`[TrackNow] ${row.containerNumber}: background error —`, { error: err?.message ?? err });
        });
    } catch (err: unknown) {
      if (!res.headersSent) {
        res.status(500).json({ message: getErrorMessage(err) ?? "Tracking failed" });
      }
    }
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
    return res.status(410).json({ message: "Automated container tracking is disabled. Update container tracking fields manually or by Excel import." });

    const { trackingEnabled } = req.body;
    if (typeof trackingEnabled !== "boolean") {
      res.status(400).json({ message: "trackingEnabled must be a boolean" });
      return;
    }

    try {
      const updated = await setBulkTrackingEnabled(trackingEnabled);
      res.json({ updated, trackingEnabled });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) ?? "Bulk update failed" });
    }
  });

  // GET /api/container-tracking/bulk-progress — live progress of the current bulk run
  app.get("/api/container-tracking/bulk-progress", requireAuth, (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    res.json(getBulkProgress());
  });

  // POST /api/container-tracking/bulk-track-now
  app.post("/api/container-tracking/bulk-track-now", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({ message: "Automated container tracking is disabled. Update container tracking fields manually or by Excel import." });

    if (!anyProviderAvailable()) {
      res.status(400).json({
        message:
          "No tracking provider configured. Add PARCELSAPP_API_KEY or ensure Chrome is available for Maersk direct tracking.",
      });
      return;
    }

    // Reject duplicate bulk runs immediately so the client gets a clear message
    if (isBulkTrackingRunning()) {
      res.status(409).json({ message: "A bulk tracking run is already in progress. Please wait for it to finish." });
      return;
    }

    try {
      const queued = await trackAllEnabledNow();
      res.json({
        queued,
        message:
          queued === 0
            ? "No containers eligible for tracking (all may be offloaded or have invalid numbers)."
            : `Tracking started for ${queued} container${queued !== 1 ? "s" : ""}. Results will appear shortly.`,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) ?? "Bulk track failed" });
    }
  });

  // POST /api/container-tracking/:id/debug-eta
  // Runs maersk_direct and maersk_public against a container and returns
  // safe diagnostic JSON (no API keys, no full payloads) describing what
  // each provider returned and where the ETA was or was not found.
  app.post("/api/container-tracking/:id/debug-eta", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({ message: "Automated container tracking is disabled. Update container tracking fields manually or by Excel import." });
    const containerId = parseInt(req.params.id, 10);
    if (isNaN(containerId)) {
      res.status(400).json({ message: "Invalid container ID" });
      return;
    }

    const [row] = await db
      .select({ containerNumber: containers.containerNumber, eta: containers.eta })
      .from(containers)
      .where(eq(containers.id, containerId))
      .limit(1);

    if (!row) {
      res.status(404).json({ message: "Container not found" });
      return;
    }

    const { containerNumber, eta: currentEta } = row;
    const providersAttempted: Array<Record<string, unknown>> = [];
    let finalEta: string | null = null;
    let finalReason = "No provider returned an ETA";

    // ── maersk_direct ─────────────────────────────────────────────────────────
    const directAvailable = isMaerskDirectScraperAvailable();
    if (directAvailable) {
      logger.info(`[DebugEta] ${containerNumber}: running maersk_direct…`);
      try {
        const r = await scrapeMaerskDirect(containerNumber);
        const deepEta = !r.eta ? deepScanForEta(r.raw ?? {}) : null;
        const etaFound = r.eta ?? deepEta?.value ?? null;
        if (etaFound && !finalEta) {
          finalEta = etaFound;
          finalReason = `maersk_direct returned ETA=${etaFound}`;
        }
        providersAttempted.push({
          provider: "maersk_direct",
          success: r.success,
          etaFound,
          status: r.latestStatus,
          error: r.error ?? null,
          deepScanPath: deepEta?.path ?? null,
          blocked: r.blocked ?? false,
        });
      } catch (e: unknown) {
        providersAttempted.push({
          provider: "maersk_direct",
          success: false,
          etaFound: null,
          error: getErrorMessage(e),
        });
      }
    } else {
      providersAttempted.push({
        provider: "maersk_direct",
        success: false,
        etaFound: null,
        error: "puppeteer_not_available",
      });
    }

    // ── maersk_public ─────────────────────────────────────────────────────────
    logger.info(`[DebugEta] ${containerNumber}: running maersk_public…`);
    try {
      const r = await maerskPublicTrack(containerNumber);
      const deepEta = !r.eta ? deepScanForEta(r.raw ?? {}) : null;
      const etaFound = r.eta ?? deepEta?.value ?? null;
      if (etaFound && !finalEta) {
        finalEta = etaFound;
        finalReason = `maersk_public returned ETA=${etaFound}`;
      }
      providersAttempted.push({
        provider: "maersk_public",
        success: r.success,
        etaFound,
        status: r.latestStatus,
        error: r.error ?? null,
        deepScanPath: deepEta?.path ?? null,
        blocked: r.blocked ?? false,
      });
    } catch (e: unknown) {
      providersAttempted.push({ provider: "maersk_public", success: false, etaFound: null, error: getErrorMessage(e) });
    }

    res.json({
      containerNumber,
      currentEtaInDb: currentEta ?? null,
      providersAttempted,
      finalEta,
      reason: finalReason,
    });
  });

  // PATCH /api/container-tracking/:id/settings
  app.patch("/api/container-tracking/:id/settings", requireAuth, async (req: Request, res: Response) => {
    if (!requireAllowedRole(req, res)) return;
    return res.status(410).json({ message: "Automated container tracking is disabled. Update container tracking fields manually or by Excel import." });

    const containerId = parseInt(req.params.id, 10);
    if (isNaN(containerId)) {
      res.status(400).json({ message: "Invalid container ID" });
      return;
    }

    const parsed = updateTrackingSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      return;
    }

    const updates: Record<string, unknown> = {};
    const data = parsed.data;
    if (data.trackingEnabled !== undefined) updates.trackingEnabled = data.trackingEnabled;
    if (data.trackingAutoUpdate !== undefined) updates.trackingAutoUpdate = data.trackingAutoUpdate;
    if ("trackingCarrierHint" in data) updates.trackingCarrierHint = data.trackingCarrierHint ?? null;
    if ("trackingProvider" in data) updates.trackingProvider = data.trackingProvider ?? null;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: "No valid fields to update" });
      return;
    }

    try {
      const [updated] = await db.update(containers).set(updates).where(eq(containers.id, containerId)).returning({
        id: containers.id,
        trackingEnabled: containers.trackingEnabled,
        trackingAutoUpdate: containers.trackingAutoUpdate,
        trackingCarrierHint: containers.trackingCarrierHint,
        trackingProvider: containers.trackingProvider,
      });

      if (!updated) {
        res.status(404).json({ message: "Container not found" });
        return;
      }
      res.json(updated);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) ?? "Update failed" });
    }
  });
}
