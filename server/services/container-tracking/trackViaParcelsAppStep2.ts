// Extracted from ./parcels-app.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { containers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import type { ParcelsAppShipment } from "../../lib/parcelsAppClient";
import { isMaerskDirectScraperAvailable, scrapeMaerskDirect } from "../../lib/maerskDirectScraper";
import * as maerskPublicProvider from "../../lib/trackingProviders/maerskPublicProvider";
import { logAndConfirmEta, logEtaResolution, resolveEtaFromProvider } from "./eta";
import { saveDirectEvents, saveParcelsAppEvents, saveTrackingCheck } from "./persistence";
import { ep } from "./validation-progress";
import { trackViaParcelsAppStep1 } from "./trackViaParcelsAppStep1";

export async function trackViaParcelsAppStep2(
  {
    MAERSK_PREFIXES,
  }: Pick<Extract<Awaited<ReturnType<typeof trackViaParcelsAppStep1>>, { done: false }>, "MAERSK_PREFIXES">,
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null
) {
  if (isMaerskDirectScraperAvailable() && MAERSK_PREFIXES.test(containerNumber)) {
    ep(containerId, "Maersk Puppeteer", "running");
    logger.info(`[ContainerTracking] ${containerNumber}: trying Maersk scraper...`);
    const mdResult = await scrapeMaerskDirect(containerNumber);

    await saveTrackingCheck(
      containerId,
      "maersk_scraper",
      mdResult.success ? "success" : mdResult.blocked ? "blocked" : "error",
      mdResult.error ?? null,
      mdResult.raw ?? null
    );

    if (mdResult.success && (mdResult.latestStatus || mdResult.eta)) {
      const updateSet: Record<string, unknown> = {
        trackingLastCheckedAt: now,
        trackingLastStatus: mdResult.latestStatus,
        trackingLastEventDate: mdResult.latestEventDate,
        trackingLastDescription: mdResult.latestDescription,
        trackingError: null,
        trackingChangedAt: now,
        trackingProvider: "maersk_scraper",
        trackingDetectedCarrier: detectedCarrier,
        trackingFallbackUsed: !!fallbackReason,
        trackingFallbackReason: fallbackReason,
      };

      // Hoist finalEta so the early-return guard below can see it regardless of events branch
      let finalEta: string | null = null;
      let etaSrc: string | null;

      // Save events
      if (mdResult.events?.length) {
        ({ eta: finalEta, source: etaSrc } = resolveEtaFromProvider(mdResult.eta ?? null, mdResult.events, currentEta));
        logEtaResolution(containerNumber, "maersk_scraper", currentEta, mdResult.eta ?? null, finalEta, etaSrc);
        if (finalEta) {
          updateSet.eta = finalEta;
          updateSet.etaSource = etaSrc;
        }

        await db.update(containers).set(updateSet).where(eq(containers.id, containerId));
        await logAndConfirmEta(
          containerId,
          containerNumber,
          currentEta,
          finalEta ?? null,
          etaSrc ?? null,
          "maersk_scraper",
          !finalEta ? "no ETA from maersk_scraper" : undefined
        );

        // Persist tracking events
        const fakeShipment: ParcelsAppShipment = {
          trackingId: containerNumber,
          done: true,
          attributes: {
            ...(mdResult.latestStatus ? { status: mdResult.latestStatus } : {}),
            ...(mdResult.latestLocation ? { location: mdResult.latestLocation } : {}),
            ...(finalEta ? { estimatedArrival: finalEta } : {}),
          },
          states: mdResult.events.map((e) => ({
            date: e.date?.toISOString().slice(0, 10) ?? "",
            status: e.status ?? "",
            location: e.location ?? "",
            description: e.description ?? "",
          })),
        };
        await saveParcelsAppEvents(containerId, fakeShipment);
      } else {
        if (mdResult.eta && !currentEta) {
          finalEta = mdResult.eta;
          updateSet.eta = mdResult.eta;
          updateSet.etaSource = "api";
        }
        await db.update(containers).set(updateSet).where(eq(containers.id, containerId));
      }

      ep(containerId, "Maersk Puppeteer", "success", mdResult.latestStatus ?? "got data");
      logger.info(`[ContainerTracking] ${containerNumber} → maersk_scraper: status=${mdResult.latestStatus ?? "?"}`);
      if (finalEta || currentEta) {
        // ETA is known (new from provider or already in DB) — full success, stop here
        return {
          done: true as const,
          value: {
            success: true,
            lastStatus: mdResult.latestStatus,
            lastLocation: mdResult.latestLocation,
            lastDescription: mdResult.latestDescription,
            lastCheckedAt: now,
            error: null,
          },
        };
      }
      // Status/events saved but no ETA anywhere — continue to Maersk public / ParcelsApp for ETA
      logger.info(
        `[ContainerTracking] ${containerNumber}: maersk_scraper got status/events but no ETA — continuing to Maersk public for ETA`
      );
    } else {
      ep(containerId, "Maersk Puppeteer", "fail", mdResult.error ?? "no data");
      logger.info(
        `[ContainerTracking] ${containerNumber}: maersk_scraper got no data (${mdResult.error}) — trying Maersk public HTTP...`
      );
    }
  } else if (MAERSK_PREFIXES.test(containerNumber) && !isMaerskDirectScraperAvailable()) {
    ep(containerId, "Maersk Puppeteer", "skip", "Chrome not available in this environment");
  }

  // ── Attempt 2: Maersk public HTTP (no browser, no API key, always available) ──
  // Runs when maersk_direct is unavailable (no Puppeteer) or returned no data.
  // Hits Maersk's undocumented public JSON API after loading a session cookie.
  // Blocked by Akamai roughly half the time — falls through gracefully.
  if (MAERSK_PREFIXES.test(containerNumber)) {
    ep(containerId, "Maersk public HTTP", "running");
    logger.info(`[ContainerTracking] ${containerNumber}: trying Maersk public HTTP provider...`);
    const mpResult = await maerskPublicProvider.track(containerNumber);

    const mpStatus = mpResult.success
      ? "success"
      : mpResult.blocked
        ? "blocked"
        : mpResult.error === "rate_limited"
          ? "skipped"
          : "error";

    await saveTrackingCheck(containerId, "maersk_public", mpStatus, mpResult.error ?? null, mpResult.raw ?? null);

    if (mpResult.success && (mpResult.latestStatus || mpResult.events.length > 0)) {
      await saveDirectEvents(containerId, mpResult);
      const { eta: finalEta, source: etaSrc } = resolveEtaFromProvider(
        mpResult.eta ?? null,
        mpResult.events,
        currentEta
      );
      logEtaResolution(containerNumber, "maersk_public", currentEta, mpResult.eta ?? null, finalEta, etaSrc);

      const updateSet: Record<string, unknown> = {
        trackingLastCheckedAt: now,
        trackingLastStatus: mpResult.latestStatus,
        trackingLastEventDate: mpResult.latestEventDate,
        trackingLastDescription: mpResult.latestDescription,
        trackingError: null,
        trackingChangedAt: now,
        trackingProvider: "maersk_public",
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
        finalEta ?? null,
        etaSrc ?? null,
        "maersk_public",
        !finalEta ? "no ETA from maersk_public" : undefined
      );

      ep(containerId, "Maersk public HTTP", "success", mpResult.latestStatus ?? "got data");
      logger.info(`[ContainerTracking] ${containerNumber} → maersk_public: status=${mpResult.latestStatus ?? "?"}`);
      if (finalEta || currentEta) {
        // ETA is known (new from provider or already in DB) — full success, stop here
        return {
          done: true as const,
          value: {
            success: true,
            lastStatus: mpResult.latestStatus,
            lastLocation: mpResult.latestLocation,
            lastDescription: mpResult.latestDescription,
            lastCheckedAt: now,
            error: null,
          },
        };
      }
      // Status/events saved but no ETA anywhere — continue to ParcelsApp to try to get one
      logger.info(
        `[ContainerTracking] ${containerNumber}: maersk_public got status/events but no ETA — continuing to ParcelsApp for ETA`
      );
    } else if (mpResult.error === "rate_limited") {
      ep(containerId, "Maersk public HTTP", "skip", "rate-limited — 6 h cooldown");
    } else {
      ep(containerId, "Maersk public HTTP", "fail", mpResult.error ?? "no data");
      logger.info(`[ContainerTracking] ${containerNumber}: maersk_public got no data (${mpResult.error})`);
    }
  }

  // Maersk guard: NEVER fall through to ParcelsApp/generic scrapers for Maersk containers.
  // ParcelsApp has stale/unreliable data for Maersk and risks clobbering correct ETAs.
  // Both dedicated Maersk providers have been tried above — stop here and preserve state.
  if (MAERSK_PREFIXES.test(containerNumber)) {
    logger.info(
      `[ContainerTracking] ${containerNumber}: Maersk chain exhausted — preserving ETA=${currentEta ?? "none"}`
    );
    await db.update(containers).set({ trackingLastCheckedAt: now }).where(eq(containers.id, containerId));
    return {
      done: true as const,
      value: {
        success: false,
        lastStatus: null,
        lastLocation: null,
        lastDescription: null,
        lastCheckedAt: now,
        error: "maersk_providers_unavailable",
      },
    };
  }
  return { done: false as const };
}
