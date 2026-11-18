// Extracted from ./parcels-app.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { factoryContainers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { deriveLastEventDate, deriveLastLocation, deriveLastStatus, trackContainer } from "../../lib/parcelsAppClient";
import { isScraperAvailable, scrapeTracking } from "../../lib/parcelsAppScraper";
import * as seventeenTrack from "../../lib/trackingProviders/seventeenTrackProvider";
import * as cmaCgmApiProvider from "../../lib/trackingProviders/cmaCgmApiProvider";
import {
  resolveEtaFromProvider,
  resolveEtaFromShipment,
  saveDirectEvents,
  saveParcelsAppEvents,
  saveTrackingCheck,
} from "./persistence";
import { check17trackQuota, ep } from "./progress-quota";
import { trackViaParcelsAppStep1 } from "./trackViaParcelsAppStep1";
import { trackViaParcelsAppStep2 } from "./trackViaParcelsAppStep2";

export async function trackViaParcelsAppStep3(
  {
    CMA_PREFIXES,
    MAERSK_PREFIXES_FC,
  }: Pick<
    Extract<Awaited<ReturnType<typeof trackViaParcelsAppStep1>>, { done: false }> &
      Extract<Awaited<ReturnType<typeof trackViaParcelsAppStep2>>, { done: false }>,
    "CMA_PREFIXES" | "MAERSK_PREFIXES_FC"
  >,
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  now: Date,
  currentEta: string | null,
  destinationCountry: string,
  manualCarrierHint: string | null
) {
  if (
    !CMA_PREFIXES.test(containerNumber) &&
    !MAERSK_PREFIXES_FC.test(containerNumber) &&
    cmaCgmApiProvider.isConfigured()
  ) {
    ep(containerId, "CMA CGM API", "running", "checking if container is on a CMA ship");
    logger.info(`[FactoryTracking] ${containerNumber}: trying CMA CGM API (leasing/unknown carrier)...`);
    const cmaFallResult = await cmaCgmApiProvider.track(containerNumber);
    await saveTrackingCheck(
      containerId,
      "cma_cgm_api",
      cmaFallResult.success ? "success" : cmaFallResult.noData ? "no_data" : "error",
      cmaFallResult.error ?? null,
      cmaFallResult.raw ?? null
    );
    if (cmaFallResult.success && (cmaFallResult.latestStatus || cmaFallResult.events.length > 0)) {
      await saveDirectEvents(containerId, cmaFallResult);
      const { eta: finalEta } = resolveEtaFromProvider(cmaFallResult.eta ?? null, cmaFallResult.events, currentEta);
      const updateSet: Record<string, unknown> = {
        trackingLastCheckedAt: now,
        trackingLastStatus: cmaFallResult.latestStatus,
        trackingLastEventDate: cmaFallResult.latestEventDate,
        trackingLastDescription: cmaFallResult.latestDescription,
        trackingError: null,
        trackingChangedAt: now,
        trackingProvider: "cma_cgm_api",
        trackingDetectedCarrier: detectedCarrier,
      };
      if (finalEta) updateSet.arrivalDate = finalEta;
      await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
      ep(containerId, "CMA CGM API", "success", cmaFallResult.latestStatus ?? "got data");
      logger.info(
        `[FactoryTracking] ${containerNumber} → cma_cgm_api (leasing): status=${cmaFallResult.latestStatus ?? "?"}`
      );
      return {
        done: true as const,
        value: {
          success: true,
          lastStatus: cmaFallResult.latestStatus,
          lastLocation: cmaFallResult.latestLocation,
          lastDescription: cmaFallResult.latestDescription,
          lastCheckedAt: now,
          error: null,
        },
      };
    }
    ep(containerId, "CMA CGM API", cmaFallResult.noData ? "skip" : "fail", cmaFallResult.error ?? "not on CMA ship");
    logger.info(
      `[FactoryTracking] ${containerNumber}: CMA API — not on CMA ship (${cmaFallResult.error ?? "no data"}) — proceeding`
    );
  }

  // ── Puppeteer scraper ─────────────────────────────────────────────────────
  if (isScraperAvailable()) {
    ep(containerId, "Puppeteer scraper", "running");
    const scraped = await scrapeTracking(containerNumber);

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
        trackingProvider: "parcelsapp_scraper",
        trackingDetectedCarrier: detectedCarrier,
      };
      if (finalEta) updateSet.arrivalDate = finalEta;
      await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
      ep(containerId, "Puppeteer scraper", "success", lastStatus ?? "got data");
      logger.info(`[FactoryTracking] ${containerNumber} → parcelsapp_scraper: status=${lastStatus ?? "?"}`);
      return {
        done: true as const,
        value: { success: true, lastStatus, lastLocation, lastDescription, lastCheckedAt: now, error: null },
      };
    }
    ep(containerId, "Puppeteer scraper", scraped.blocked ? "blocked" : "fail", scraped.error ?? "no data");
  }

  // ── 17track API ───────────────────────────────────────────────────────────
  if (seventeenTrack.isConfigured()) {
    const quotaOk17 = await check17trackQuota();
    if (quotaOk17) {
      ep(containerId, "17track API", "running");
      const result17 = await seventeenTrack.track(containerNumber);
      await saveTrackingCheck(
        containerId,
        "17track",
        result17.success ? "success" : result17.noData ? "no_data" : "error",
        result17.error ?? null,
        result17.raw
      );

      if (result17.success) {
        await saveDirectEvents(containerId, result17);
        const { eta: finalEta } = resolveEtaFromProvider(result17.eta ?? null, result17.events, currentEta);
        const updateSet: Record<string, unknown> = {
          trackingLastCheckedAt: now,
          trackingLastStatus: result17.latestStatus,
          trackingLastEventDate: result17.latestEventDate,
          trackingLastDescription: result17.latestDescription,
          trackingError: null,
          trackingChangedAt: now,
          trackingProvider: "17track",
          trackingDetectedCarrier: detectedCarrier,
        };
        if (finalEta) updateSet.arrivalDate = finalEta;
        await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
        ep(containerId, "17track API", "success", result17.latestStatus ?? "got data");
        logger.info(`[FactoryTracking] ${containerNumber} → 17track: status=${result17.latestStatus ?? "?"}`);
        return {
          done: true as const,
          value: {
            success: true,
            lastStatus: result17.latestStatus,
            lastLocation: result17.latestLocation,
            lastDescription: result17.latestDescription,
            lastCheckedAt: now,
            error: null,
          },
        };
      }
      ep(containerId, "17track API", "fail", result17.error ?? "no data");
    } else {
      ep(containerId, "17track API", "skip", "quota exhausted");
    }
  }

  // ── ParcelsApp API ────────────────────────────────────────────────────────
  if (!process.env.PARCELSAPP_API_KEY) {
    const noProviderError = "No tracking provider configured";
    await db
      .update(factoryContainers)
      .set({ trackingLastCheckedAt: now, trackingError: noProviderError })
      .where(eq(factoryContainers.id, containerId));
    return {
      done: true as const,
      value: {
        success: false,
        lastStatus: null,
        lastLocation: null,
        lastDescription: null,
        lastCheckedAt: now,
        error: noProviderError,
      },
    };
  }

  ep(containerId, "ParcelsApp API", "running");
  const effectiveHintMain =
    manualCarrierHint || (detectedCarrier && detectedCarrier !== "OTHER" ? detectedCarrier : null);
  logger.info(
    `[FactoryTracking] ${containerNumber} ParcelsApp: dest=${destinationCountry} hint=${effectiveHintMain ?? "none"} manualHint=${manualCarrierHint ?? "none"} detected=${detectedCarrier ?? "none"}`
  );
  let result = await trackContainer(containerNumber, destinationCountry, effectiveHintMain ?? undefined);

  await saveTrackingCheck(
    containerId,
    "parcelsapp",
    result.success ? "success" : result.timedOut ? "timeout" : "error",
    result.error ?? null,
    result.rawResponse
  );

  if (result.timedOut && effectiveHintMain) {
    logger.info(
      `[FactoryTracking] ${containerNumber} ParcelsApp timed out with hint="${effectiveHintMain}" — retrying without hint`
    );
    ep(containerId, "ParcelsApp API (retry no hint)", "running");
    const retryResult = await trackContainer(containerNumber, destinationCountry, undefined);
    await saveTrackingCheck(
      containerId,
      "parcelsapp_retry_no_hint",
      retryResult.success ? "success" : retryResult.timedOut ? "timeout" : "error",
      retryResult.error ?? null,
      retryResult.rawResponse
    );
    if (retryResult.success && retryResult.shipment) {
      result = { ...retryResult, rawResponse: retryResult.rawResponse };
      ep(containerId, "ParcelsApp API (retry no hint)", "success", "got data");
    } else {
      ep(containerId, "ParcelsApp API (retry no hint)", "fail", retryResult.error ?? "no data");
    }
  }

  if (!result.success || !result.shipment) {
    ep(containerId, "ParcelsApp API", "fail", result.error ?? "no data");
    const errMsg = result.timedOut
      ? `Carrier timed out (dest=${destinationCountry})`
      : (result.error ?? "Tracking failed");
    await db
      .update(factoryContainers)
      .set({ trackingLastCheckedAt: now, trackingError: errMsg, trackingProvider: "parcelsapp" })
      .where(eq(factoryContainers.id, containerId));
    return {
      done: true as const,
      value: {
        success: false,
        lastStatus: null,
        lastLocation: null,
        lastDescription: null,
        lastCheckedAt: now,
        error: errMsg,
      },
    };
  }

  const shipment = result.shipment;
  const lastStatus = deriveLastStatus(shipment);
  const lastLocation = deriveLastLocation(shipment);
  const lastEventDate = deriveLastEventDate(shipment);
  const lastDescription = shipment.states?.[0]?.description ?? null;
  const { eta: finalEta } = resolveEtaFromShipment(shipment, currentEta);
  await saveParcelsAppEvents(containerId, shipment);
  return { done: false as const, finalEta, lastDescription, lastEventDate, lastLocation, lastStatus };
}
