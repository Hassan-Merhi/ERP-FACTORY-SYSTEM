// Extracted from ./parcels-app.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { factoryContainers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import {
  deriveLastEventDate,
  deriveLastLocation,
  deriveLastStatus,
  type ParcelsAppShipment,
} from "../../lib/parcelsAppClient";
import { httpScrapeTracking, isHttpScraperAvailable } from "../../lib/httpTrackingScraper";
import { isMaerskDirectScraperAvailable, scrapeMaerskDirect } from "../../lib/maerskDirectScraper";
import * as maerskPublicProvider from "../../lib/trackingProviders/maerskPublicProvider";
import {
  resolveEtaFromProvider,
  resolveEtaFromShipment,
  saveDirectEvents,
  saveParcelsAppEvents,
  saveTrackingCheck,
} from "./persistence";
import { ep, initProgress } from "./progress-quota";

// ── In-flight tracking cap ────────────────────────────────────────────────────
// Prevents "Track All" from launching unlimited concurrent background jobs
// which, combined with Chrome's memory footprint, OOMs a 2 GB host.

export async function trackViaParcelsAppStep1(
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  now: Date,
  currentEta: string | null
) {
  initProgress(containerId);

  // ── CMA prefix — defined early so the HTTP scraper block can skip CMA ───────
  const CMA_PREFIXES = /^(CMAU|CMDU|APZU|CGMU|APMU|APHU|CXDU|CAAU|CAJU|CAIU)/i;

  // ── HTTP scraper ──────────────────────────────────────────────────────────
  // CMA containers bypass this step — DataDome blocks page scraping for CMA CGM.
  // The dedicated CMA chain below (official DCSA API → public endpoint → 17track)
  // is the correct path for all CMA prefixes.
  if (detectedCarrier === "CMA") {
    ep(containerId, "HTTP scraper", "skip", "CMA uses dedicated provider chain");
  } else if (isHttpScraperAvailable()) {
    ep(containerId, "HTTP scraper", "running");
    const scraped = await httpScrapeTracking(containerNumber);

    if (scraped.success && scraped.shipment) {
      const shipment = scraped.shipment;
      const lastStatus = deriveLastStatus(shipment);
      const lastLocation = deriveLastLocation(shipment);
      const lastEventDate = deriveLastEventDate(shipment);
      const lastDescription = shipment.states?.[0]?.description ?? null;
      const { eta: finalEta } = resolveEtaFromShipment(shipment, currentEta);
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
      };
      if (finalEta) updateSet.arrivalDate = finalEta;
      await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
      ep(containerId, "HTTP scraper", "success", lastStatus ?? "got data");
      logger.info(`[FactoryTracking] ${containerNumber} → http_scraper: status=${lastStatus ?? "?"}`);
      return {
        done: true as const,
        value: { success: true, lastStatus, lastLocation, lastDescription, lastCheckedAt: now, error: null },
      };
    }
    ep(containerId, "HTTP scraper", "fail", scraped.error ?? "no data");
  }

  // ── Maersk provider chain ─────────────────────────────────────────────────
  // Note: CAJU is a CMA CGM prefix — excluded from this regex intentionally.
  const MAERSK_PREFIXES = /^(MAEU|MSKU|MRKU|MRSU|HASU|HJSC|HJCU|SUDU|SAFM)/i;
  if (MAERSK_PREFIXES.test(containerNumber)) {
    // Maersk direct scraper (Puppeteer intercept)
    if (isMaerskDirectScraperAvailable()) {
      ep(containerId, "Maersk Puppeteer", "running");
      const mdResult = await scrapeMaerskDirect(containerNumber);
      await saveTrackingCheck(
        containerId,
        "maersk_scraper",
        mdResult.success ? "success" : mdResult.blocked ? "blocked" : "error",
        mdResult.error ?? null,
        mdResult.raw ?? null
      );

      if (mdResult.success && (mdResult.latestStatus || mdResult.eta)) {
        const { eta: finalEta } = resolveEtaFromProvider(mdResult.eta ?? null, mdResult.events, currentEta);
        const updateSet: Record<string, unknown> = {
          trackingLastCheckedAt: now,
          trackingLastStatus: mdResult.latestStatus,
          trackingLastEventDate: mdResult.latestEventDate,
          trackingLastDescription: mdResult.latestDescription,
          trackingError: null,
          trackingChangedAt: now,
          trackingProvider: "maersk_scraper",
          trackingDetectedCarrier: detectedCarrier,
        };
        if (finalEta) updateSet.arrivalDate = finalEta;
        await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
        if (mdResult.events?.length) {
          const fakeShipment: ParcelsAppShipment = {
            trackingId: containerNumber,
            done: true,
            attributes: {
              ...(mdResult.latestStatus ? { status: mdResult.latestStatus } : {}),
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
        }
        ep(containerId, "Maersk Puppeteer", "success", mdResult.latestStatus ?? "got data");
        logger.info(`[FactoryTracking] ${containerNumber} → maersk_scraper: status=${mdResult.latestStatus ?? "?"}`);
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
      ep(containerId, "Maersk Puppeteer", "fail", mdResult.error ?? "no data");
    } else {
      ep(containerId, "Maersk Puppeteer", "skip", "not available");
    }

    // Maersk public HTTP (no credentials, always available)
    ep(containerId, "Maersk public HTTP", "running");
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
      const { eta: finalEta } = resolveEtaFromProvider(mpResult.eta ?? null, mpResult.events, currentEta);
      const updateSet: Record<string, unknown> = {
        trackingLastCheckedAt: now,
        trackingLastStatus: mpResult.latestStatus,
        trackingLastEventDate: mpResult.latestEventDate,
        trackingLastDescription: mpResult.latestDescription,
        trackingError: null,
        trackingChangedAt: now,
        trackingProvider: "maersk_public",
        trackingDetectedCarrier: detectedCarrier,
      };
      if (finalEta) updateSet.arrivalDate = finalEta;
      await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
      ep(containerId, "Maersk public HTTP", "success", mpResult.latestStatus ?? "got data");
      logger.info(`[FactoryTracking] ${containerNumber} → maersk_public: status=${mpResult.latestStatus ?? "?"}`);
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
    } else if (mpResult.error === "rate_limited") {
      ep(containerId, "Maersk public HTTP", "skip", "rate-limited");
    } else {
      ep(containerId, "Maersk public HTTP", "fail", mpResult.error ?? "no data");
    }

    logger.info(`[FactoryTracking] ${containerNumber}: Maersk chain exhausted — falling through to ParcelsApp`);
  }
  return { done: false as const, CMA_PREFIXES };
}
