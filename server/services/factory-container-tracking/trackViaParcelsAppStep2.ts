// Extracted from ./parcels-app.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { factoryContainers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import * as seventeenTrack from "../../lib/trackingProviders/seventeenTrackProvider";
import * as cmaPublicProvider from "../../lib/trackingProviders/cmaPublicProvider";
import * as cmaCgmApiProvider from "../../lib/trackingProviders/cmaCgmApiProvider";
import { resolveEtaFromProvider, saveDirectEvents, saveTrackingCheck } from "./persistence";
import { check17trackQuota, ep } from "./progress-quota";
import { trackViaParcelsAppFallback } from "./track-one";
import { trackViaParcelsAppStep1 } from "./trackViaParcelsAppStep1";

export async function trackViaParcelsAppStep2(
  { CMA_PREFIXES }: Pick<Extract<Awaited<ReturnType<typeof trackViaParcelsAppStep1>>, { done: false }>, "CMA_PREFIXES">,
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null,
  destinationCountry: string,
  manualCarrierHint: string | null
) {
  // ── CMA CGM provider chain ─────────────────────────────────────────────────
  // CMA_PREFIXES already defined above (before the HTTP scraper block).
  if (CMA_PREFIXES.test(containerNumber)) {
    logger.info(`[FactoryTracking] ${containerNumber}: CMA detected — trying carrier-specific providers...`);

    // Step 1: CMA CGM Official DCSA API (needs API key)
    if (cmaCgmApiProvider.isConfigured()) {
      ep(containerId, "CMA CGM API", "running");
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
        const { eta: finalEta } = resolveEtaFromProvider(apiResult.eta ?? null, apiResult.events, currentEta);
        const updateSet: Record<string, unknown> = {
          trackingLastCheckedAt: now,
          trackingLastStatus: apiResult.latestStatus,
          trackingLastEventDate: apiResult.latestEventDate,
          trackingLastDescription: apiResult.latestDescription,
          trackingError: null,
          trackingChangedAt: now,
          trackingProvider: "cma_cgm_api",
          trackingDetectedCarrier: detectedCarrier,
        };
        if (finalEta) updateSet.arrivalDate = finalEta;
        await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
        ep(containerId, "CMA CGM API", "success", apiResult.latestStatus ?? "got data");
        logger.info(`[FactoryTracking] ${containerNumber} → cma_cgm_api: status=${apiResult.latestStatus ?? "?"}`);
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
      ep(containerId, "CMA CGM API", apiResult.noData ? "skip" : "fail", apiResult.error ?? "no data");
      logger.info(`[FactoryTracking] ${containerNumber}: CMA official API returned no data — trying public...`);
    } else {
      ep(containerId, "CMA CGM API", "skip", "CMA_CGM_API_KEY not configured");
    }

    // Step 2: CMA CGM public endpoint (no key, sometimes blocked by DataDome)
    if (cmaPublicProvider.isEnabled()) {
      ep(containerId, "CMA public HTTP", "running");
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
        const { eta: finalEta } = resolveEtaFromProvider(cmaResult.eta ?? null, cmaResult.events, currentEta);
        const updateSet: Record<string, unknown> = {
          trackingLastCheckedAt: now,
          trackingLastStatus: cmaResult.latestStatus,
          trackingLastEventDate: cmaResult.latestEventDate,
          trackingLastDescription: cmaResult.latestDescription,
          trackingError: null,
          trackingChangedAt: now,
          trackingProvider: "cma_public",
          trackingDetectedCarrier: detectedCarrier,
        };
        if (finalEta) updateSet.arrivalDate = finalEta;
        await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
        ep(containerId, "CMA public HTTP", "success", cmaResult.latestStatus ?? "got data");
        logger.info(`[FactoryTracking] ${containerNumber} → cma_public: status=${cmaResult.latestStatus ?? "?"}`);
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
      ep(containerId, "CMA public HTTP", cmaResult.blocked ? "blocked" : "fail", cmaResult.error ?? "no data");
      logger.info(`[FactoryTracking] ${containerNumber}: CMA public failed — trying 17track...`);
    } else {
      ep(containerId, "CMA public HTTP", "skip", "not enabled");
    }

    // Step 3: 17track with CMA carrier code (skip generic 17track block below)
    if (seventeenTrack.isConfigured()) {
      const quotaOk17 = await check17trackQuota();
      if (quotaOk17) {
        ep(containerId, "17track API (CMA)", "running");
        const result17 = await seventeenTrack.track(containerNumber, seventeenTrack.CARRIER_CODES?.CMA);
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
          ep(containerId, "17track API (CMA)", "success", result17.latestStatus ?? "got data");
          logger.info(`[FactoryTracking] ${containerNumber} → 17track (CMA): status=${result17.latestStatus ?? "?"}`);
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
        ep(containerId, "17track API (CMA)", "fail", result17.error ?? "no data");
      }
    }

    // Fall through to ParcelsApp for CMA (skip generic Puppeteer / 17track blocks)
    return {
      done: true as const,
      value: await trackViaParcelsAppFallback(
        containerId,
        containerNumber,
        detectedCarrier,
        fallbackReason,
        now,
        currentEta,
        destinationCountry,
        manualCarrierHint
      ),
    };
  }

  // ── CMA CGM API — leasing / unknown-carrier containers ───────────────────────
  // Leasing containers (TCNU, TIIU, UETU, ECNU…) may be shipped by CMA CGM.
  // The DCSA API looks up by equipmentReference regardless of container prefix;
  // if the box is on a CMA vessel we get full tracking — a 404/no_data comes
  // back quickly for non-CMA cargo so the overhead is negligible.
  // Maersk and CMA-prefix containers are already handled above.
  // Note: CAJU is a CMA CGM prefix — excluded from Maersk regex intentionally.
  const MAERSK_PREFIXES_FC = /^(MAEU|MSKU|MRKU|MRSU|HASU|HJSC|HJCU|SUDU|SAFM)/i;
  return { done: false as const, MAERSK_PREFIXES_FC };
}
