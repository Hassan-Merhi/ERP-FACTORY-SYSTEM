// Extracted from ./parcels-app.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { containers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import * as seventeenTrack from "../../lib/trackingProviders/seventeenTrackProvider";
import * as cmaPublicProvider from "../../lib/trackingProviders/cmaPublicProvider";
import * as cmaCgmApiProvider from "../../lib/trackingProviders/cmaCgmApiProvider";
import { logAndConfirmEta, logEtaResolution, resolveEtaFromProvider } from "./eta";
import { trackViaParcelsAppApi } from "./parcels-app-api";
import { saveDirectEvents, saveTrackingCheck } from "./persistence";
import { check17trackQuota } from "./quotas";
import { CMA_PREFIXES } from "./validation-progress";

export async function trackViaParcelsAppStep4(
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null,
  destinationCountry?: string
) {
  // ── CMA provider chain ────────────────────────────────────────────────────────
  // Priority order:
  //   1. CMA CGM Official DCSA API (api key, most accurate ETA)
  //   2. CMA CGM public JSON endpoint (free, no key, often blocked by DataDome)
  //   3. 17track
  //   4. ParcelsApp API
  if (CMA_PREFIXES.test(containerNumber)) {
    logger.info(`[ContainerTracking] ${containerNumber}: CMA detected — trying CMA CGM official API...`);

    // ── Step 1: CMA CGM Official DCSA Track & Trace API ──────────────────────
    if (cmaCgmApiProvider.isConfigured()) {
      const apiResult = await cmaCgmApiProvider.track(containerNumber);
      await saveTrackingCheck(
        containerId,
        "cma_cgm_api",
        apiResult.success ? "success" : apiResult.noData ? "no_data" : "error",
        apiResult.error ?? null,
        apiResult.raw ?? null
      );

      if (apiResult.success && (apiResult.latestStatus || apiResult.events.length > 0)) {
        await saveDirectEvents(containerId, apiResult);
        const { eta: finalEta, source: etaSrc } = resolveEtaFromProvider(
          apiResult.eta ?? null,
          apiResult.events,
          currentEta
        );
        logEtaResolution(containerNumber, "cma_cgm_api", currentEta, apiResult.eta ?? null, finalEta, etaSrc);
        const updateSet: Record<string, unknown> = {
          trackingLastCheckedAt: now,
          trackingLastStatus: apiResult.latestStatus,
          trackingLastEventDate: apiResult.latestEventDate,
          trackingLastDescription: apiResult.latestDescription,
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
          !finalEta ? "no ETA from CMA CGM official API" : undefined
        );
        logger.info(
          `[ContainerTracking] ${containerNumber} → cma_cgm_api: status=${apiResult.latestStatus ?? "?"} eta=${finalEta ?? "none"}`
        );
        return {
          done: true as const,
          value: {
            success: true,
            lastStatus: apiResult.latestStatus,
            lastLocation: apiResult.latestLocation,
            lastDescription: apiResult.latestDescription,
            lastCheckedAt: now,
            error: null,
          },
        };
      }

      logger.info(
        `[ContainerTracking] ${containerNumber}: CMA official API returned no data (${apiResult.error}) — trying public endpoint...`
      );
    }

    if (cmaPublicProvider.isEnabled()) {
      const cmaResult = await cmaPublicProvider.track(containerNumber);
      await saveTrackingCheck(
        containerId,
        "cma_public",
        cmaResult.success ? "success" : cmaResult.blocked ? "blocked" : "error",
        cmaResult.error ?? null,
        cmaResult.raw ?? null
      );

      if (cmaResult.success && (cmaResult.latestStatus || cmaResult.events.length > 0)) {
        await saveDirectEvents(containerId, cmaResult);
        const { eta: finalEta, source: etaSrc } = resolveEtaFromProvider(
          cmaResult.eta ?? null,
          cmaResult.events,
          currentEta
        );
        logEtaResolution(containerNumber, "cma_public", currentEta, cmaResult.eta ?? null, finalEta, etaSrc);
        const updateSet: Record<string, unknown> = {
          trackingLastCheckedAt: now,
          trackingLastStatus: cmaResult.latestStatus,
          trackingLastEventDate: cmaResult.latestEventDate,
          trackingLastDescription: cmaResult.latestDescription,
          trackingError: null,
          trackingChangedAt: now,
          trackingProvider: "cma_public",
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
          "cma_public",
          !finalEta ? "no ETA from CMA public endpoint" : undefined
        );
        logger.info(`[ContainerTracking] ${containerNumber} → cma_public: status=${cmaResult.latestStatus ?? "?"}`);
        return {
          done: true as const,
          value: {
            success: true,
            lastStatus: cmaResult.latestStatus,
            lastLocation: cmaResult.latestLocation,
            lastDescription: cmaResult.latestDescription,
            lastCheckedAt: now,
            error: null,
          },
        };
      }

      logger.info(
        `[ContainerTracking] ${containerNumber}: CMA public endpoint failed (${cmaResult.error}) — trying 17track...`
      );
    }

    // 17track handles CMA well — try it before burning ParcelsApp quota
    if (seventeenTrack.isConfigured()) {
      const quotaOk17 = await check17trackQuota();
      if (quotaOk17) {
        logger.info(`[ContainerTracking] ${containerNumber}: trying 17track for CMA (carrier=100755)...`);
        const result17 = await seventeenTrack.track(containerNumber, seventeenTrack.CARRIER_CODES.CMA);
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
            !finalEta ? "17track returned no ETA" : undefined
          );
          logger.info(`[ContainerTracking] ${containerNumber} → 17track (CMA): status=${result17.latestStatus ?? "?"}`);
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
        logger.info(
          `[ContainerTracking] ${containerNumber}: 17track failed for CMA (${result17.error}) — trying ParcelsApp scraper...`
        );
      }
    }

    // ParcelsApp website (scraped via Puppeteer) has no CMA CGM data — skip it.
    // Go straight to the ParcelsApp v3 API which may have broader carrier coverage.
    return {
      done: true as const,
      value: await trackViaParcelsAppApi(
        containerId,
        containerNumber,
        null,
        fallbackReason,
        now,
        currentEta,
        destinationCountry
      ),
    };
  }
  return { done: false as const };
}
