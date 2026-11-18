// Extracted from ./parcels-app.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { containers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { deriveLastEventDate, deriveLastLocation, deriveLastStatus } from "../../lib/parcelsAppClient";
import { httpScrapeTracking, isHttpScraperAvailable } from "../../lib/httpTrackingScraper";
import { logAndConfirmEta, logEtaResolution, resolveEtaFromShipment } from "./eta";
import { saveParcelsAppEvents, saveTrackingCheck } from "./persistence";
import { ep, initTrackingProgress } from "./validation-progress";

// ─── ParcelsApp API — shared final step for all carriers ──────────────────────

export async function trackViaParcelsAppStep1(
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null,
  lastCheckedAt: Date | null
) {
  // Reset progress for this tracking run
  initTrackingProgress(containerId);

  // ── Attempt 0: Lightweight HTTP scraper (no browser, no quota) ──────────────
  if (isHttpScraperAvailable()) {
    ep(containerId, "HTTP scraper", "running");
    logger.info(`[ContainerTracking] ${containerNumber}: trying HTTP scraper (no browser)...`);
    const httpResult = await httpScrapeTracking(containerNumber);

    await saveTrackingCheck(
      containerId,
      "http_scraper",
      httpResult.success ? "success" : "error",
      httpResult.error ?? null,
      httpResult.rawResponse ?? null
    );

    if (httpResult.success && httpResult.shipment) {
      const shipment = httpResult.shipment;
      const lastStatus = deriveLastStatus(shipment);
      const lastLocation = deriveLastLocation(shipment);
      const lastEventDate = deriveLastEventDate(shipment);
      const lastDescription = shipment.states?.[0]?.description ?? null;
      const { eta: finalEta, source: etaSrc } = resolveEtaFromShipment(shipment, currentEta);
      logEtaResolution(containerNumber, "http_scraper", currentEta, finalEta, finalEta, etaSrc);

      await saveParcelsAppEvents(containerId, shipment);

      const updateSet: Record<string, unknown> = {
        trackingLastCheckedAt: now,
        trackingLastStatus: lastStatus,
        trackingLastEventDate: lastEventDate,
        trackingLastDescription: lastDescription,
        trackingError: null,
        trackingChangedAt: now,
        trackingProvider: "http_scraper",
        trackingDetectedCarrier: detectedCarrier,
        trackingFallbackUsed: !!fallbackReason,
        trackingFallbackReason: fallbackReason,
      };
      if (finalEta) {
        updateSet.eta = finalEta;
        updateSet.etaSource = etaSrc;
      }
      await db.update(containers).set(updateSet).where(eq(containers.id, containerId));
      await logAndConfirmEta(
        containerId,
        containerNumber,
        currentEta,
        finalEta,
        etaSrc,
        "http_scraper",
        !finalEta ? "no explicit ETA field found — existing ETA preserved" : undefined
      );

      ep(containerId, "HTTP scraper", "success", lastStatus ?? "got data");
      logger.info(`[ContainerTracking] ${containerNumber} → http_scraper: status=${lastStatus ?? "?"}`);
      if (finalEta || currentEta) {
        // ETA is known (new from provider or already in DB) — full success, stop here
        return {
          done: true as const,
          value: { success: true, lastStatus, lastLocation, lastDescription, lastCheckedAt: now, error: null },
        };
      }
      // Status/events saved but no ETA anywhere — fall through to next provider to try to get one
      logger.info(
        `[ContainerTracking] ${containerNumber}: http_scraper got status/events but no ETA — continuing to fallback provider for ETA`
      );
    } else {
      ep(containerId, "HTTP scraper", "skip", httpResult.error ?? "no data");
      logger.info(
        `[ContainerTracking] ${containerNumber}: HTTP scraper got no data (${httpResult.error}) — trying next provider...`
      );
    }
  }

  // ── Attempt 1: Maersk direct Puppeteer scraper (intercepts Maersk's own API) ──
  // Only for Maersk-family containers (MAERSK, Hamburg Süd, etc.)
  // CAJU is a CMA-owned prefix but is operated by Maersk (MAEU) on some services.
  // Maersk.com tracks CAJU containers when operator=MAEU, so include it here so
  // maersk_direct and maersk_public are attempted before falling back to CMA/ParcelsApp.
  const MAERSK_PREFIXES = /^(MAEU|MSKU|MRKU|MRSU|HASU|HJSC|HJCU|SUDU|SAFM|CAJU)/i;

  // 6-hour ETA cache: if we already have a good ETA and checked < 6 h ago, skip both
  // Maersk providers entirely. The scheduler already enforces intervals, but this
  // in-process guard prevents redundant calls when trackOneContainer is invoked directly.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
  if (
    MAERSK_PREFIXES.test(containerNumber) &&
    currentEta &&
    lastCheckedAt &&
    now.getTime() - lastCheckedAt.getTime() < SIX_HOURS_MS
  ) {
    logger.info(
      `[ContainerTracking] ${containerNumber}: Maersk ETA cached (${currentEta}) checked ${Math.round((now.getTime() - lastCheckedAt.getTime()) / 60000)}min ago — skipping providers`
    );
    return {
      done: true as const,
      value: {
        success: true,
        lastStatus: null,
        lastLocation: null,
        lastDescription: null,
        lastCheckedAt: lastCheckedAt,
        error: null,
      },
    };
  }
  return { done: false as const, MAERSK_PREFIXES };
}
