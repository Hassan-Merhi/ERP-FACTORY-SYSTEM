import { db } from "../../db";
import { logger } from "../../lib/logger";
import { containers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { deriveLastStatus, deriveLastLocation, deriveLastEventDate } from "../../lib/parcelsAppClient";
import { scrapeTracking, isScraperAvailable } from "../../lib/parcelsAppScraper";
import * as seventeenTrack from "../../lib/trackingProviders/seventeenTrackProvider";
import * as cmaCgmApiProvider from "../../lib/trackingProviders/cmaCgmApiProvider";
import { logAndConfirmEta, logEtaResolution, resolveEtaFromProvider, resolveEtaFromShipment } from "./eta";
import { trackViaParcelsAppApi } from "./parcels-app-api";
import { saveDirectEvents, saveParcelsAppEvents, saveTrackingCheck } from "./persistence";
import { check17trackQuota } from "./quotas";
import { CMA_PREFIXES, ep } from "./validation-progress";
import { trackViaParcelsAppStep1 } from "./trackViaParcelsAppStep1";
import { trackViaParcelsAppStep2 } from "./trackViaParcelsAppStep2";
import { trackViaParcelsAppStep4 } from "./trackViaParcelsAppStep4";

export async function trackViaParcelsApp(
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null,
  lastCheckedAt: Date | null,
  destinationCountry?: string
): Promise<{
  success: boolean;
  lastStatus: string | null;
  lastLocation: string | null;
  lastDescription: string | null;
  lastCheckedAt: Date;
  error: string | null;
}> {
  const step1Result = await trackViaParcelsAppStep1(
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now,
    currentEta,
    lastCheckedAt
  );
  if (step1Result.done) return step1Result.value;
  const { MAERSK_PREFIXES } = step1Result;
  const step2Result = await trackViaParcelsAppStep2(
    { MAERSK_PREFIXES },
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now,
    currentEta
  );
  if (step2Result.done) return step2Result.value;
  const step3Result = await trackViaParcelsAppStep3(
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now,
    currentEta
  );
  if (step3Result.done) return step3Result.value;
  const step4Result = await trackViaParcelsAppStep4(
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now,
    currentEta,
    destinationCountry
  );
  if (step4Result.done) return step4Result.value;
  const step5Result = await trackViaParcelsAppStep5(
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now,
    currentEta
  );
  if (step5Result.done) return step5Result.value;

  // ── Final: ParcelsApp API ─────────────────────────────────────────────────────
  return await trackViaParcelsAppApi(
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now,
    currentEta,
    destinationCountry
  );
}

async function trackViaParcelsAppStep3(
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null
) {
  // ── CMA CGM API — leasing / unknown-carrier containers ───────────────────────
  // Leasing containers (TCNU, TIIU, UETU, ECNU…) may be shipped by CMA CGM.
  // The official DCSA API looks up by equipmentReference (container number) and
  // returns events regardless of the container prefix — if the box is on a CMA
  // vessel we get full tracking; a 404/no_data is returned quickly for non-CMA
  // cargo so the overhead is negligible.
  // CMA-prefix containers have their own dedicated chain below — skip them here.
  if (!CMA_PREFIXES.test(containerNumber) && cmaCgmApiProvider.isConfigured()) {
    ep(containerId, "CMA CGM API", "running", "checking if container is on a CMA ship");
    logger.info(`[ContainerTracking] ${containerNumber}: trying CMA CGM API (leasing/unknown carrier)...`);
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
      const { eta: finalEta, source: etaSrc } = resolveEtaFromProvider(
        cmaFallResult.eta ?? null,
        cmaFallResult.events,
        currentEta
      );
      logEtaResolution(containerNumber, "cma_cgm_api", currentEta, cmaFallResult.eta ?? null, finalEta, etaSrc);
      const updateSet: Record<string, unknown> = {
        trackingLastCheckedAt: now,
        trackingLastStatus: cmaFallResult.latestStatus,
        trackingLastEventDate: cmaFallResult.latestEventDate,
        trackingLastDescription: cmaFallResult.latestDescription,
        trackingError: null,
        trackingChangedAt: now,
        trackingProvider: "cma_cgm_api",
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
        "cma_cgm_api",
        !finalEta ? "CMA API: no ETA returned" : undefined
      );
      ep(containerId, "CMA CGM API", "success", cmaFallResult.latestStatus ?? "got data");
      logger.info(
        `[ContainerTracking] ${containerNumber} → cma_cgm_api (leasing): status=${cmaFallResult.latestStatus ?? "?"}`
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
      `[ContainerTracking] ${containerNumber}: CMA API — not on CMA ship (${cmaFallResult.error ?? "no data"}) — proceeding`
    );
  }
  return { done: false as const };
}

async function trackViaParcelsAppStep5(
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null
) {
  // ── Attempt 2: Puppeteer stealth scraper (ParcelsApp, no API key, no quota cost) ──
  if (isScraperAvailable()) {
    ep(containerId, "Puppeteer scraper", "running");
    logger.info(`[ContainerTracking] ${containerNumber}: trying ParcelsApp web scraper...`);
    const scraped = await scrapeTracking(containerNumber);

    await saveTrackingCheck(
      containerId,
      "parcelsapp_scraper",
      scraped.success ? "success" : scraped.blocked ? "blocked" : "error",
      scraped.error ?? null,
      scraped.rawResponse ?? null
    );

    if (scraped.success && scraped.shipment) {
      const shipment = scraped.shipment;
      const lastStatus = deriveLastStatus(shipment);
      const lastLocation = deriveLastLocation(shipment);
      const lastEventDate = deriveLastEventDate(shipment);
      const lastDescription = shipment.states?.[0]?.description ?? null;
      const { eta: finalEta, source: etaSrc } = resolveEtaFromShipment(shipment, currentEta);

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
        "parcelsapp_scraper",
        !finalEta ? "no ETA derived from shipment states" : undefined
      );

      ep(containerId, "Puppeteer scraper", "success", lastStatus ?? "got data");
      logger.info(`[ContainerTracking] ${containerNumber} → parcelsapp_scraper: status=${lastStatus ?? "?"}`);
      return {
        done: true as const,
        value: { success: true, lastStatus, lastLocation, lastDescription, lastCheckedAt: now, error: null },
      };
    }

    ep(containerId, "Puppeteer scraper", scraped.blocked ? "blocked" : "fail", scraped.error ?? "no data");
    if (scraped.blocked) {
      logger.warn(`[ContainerTracking] ${containerNumber}: scraper blocked by reCaptcha — trying 17track...`);
    } else {
      logger.warn(`[ContainerTracking] ${containerNumber}: scraper failed (${scraped.error}) — trying 17track...`);
    }
  }

  // ── Attempt 2: 17track API ────────────────────────────────────────────────────
  if (seventeenTrack.isConfigured()) {
    const quotaOk17 = await check17trackQuota();
    if (!quotaOk17) {
      ep(containerId, "17track API", "skip", "quota exhausted this month");
      logger.warn(`[ContainerTracking] ${containerNumber}: 17track quota exhausted — skipping`);
    } else {
      ep(containerId, "17track API", "running");
      logger.info(`[ContainerTracking] ${containerNumber}: trying 17track...`);
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

        const { eta: finalEta, source: etaSrc } = resolveEtaFromProvider(
          result17.eta ?? null,
          result17.events,
          currentEta
        );
        logEtaResolution(containerNumber, "17track", currentEta, result17.eta ?? null, finalEta, etaSrc);

        const updateSet: Record<string, unknown> = {
          trackingLastCheckedAt: now,
          trackingLastStatus: result17.latestStatus,
          trackingLastEventDate: result17.latestEventDate,
          trackingLastDescription: result17.latestDescription,
          trackingError: null,
          trackingChangedAt: now,
          trackingProvider: "17track",
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
          "17track",
          !finalEta ? "17track returned no ETA and no events with dates" : undefined
        );

        ep(containerId, "17track API", "success", result17.latestStatus ?? "got data");
        logger.info(`[ContainerTracking] ${containerNumber} → 17track: status=${result17.latestStatus ?? "?"}`);
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
      logger.warn(
        `[ContainerTracking] ${containerNumber}: 17track failed (${result17.error}) — trying ParcelsApp API...`
      );
    }
  }
  return { done: false as const };
}
