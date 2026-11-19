// Extracted from ./parcels-app.ts
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { containers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import * as cmaCgmApiProvider from "../../lib/trackingProviders/cmaCgmApiProvider";
import { logAndConfirmEta, logEtaResolution, resolveEtaFromProvider } from "./eta";
import { saveDirectEvents, saveTrackingCheck } from "./persistence";
import { CMA_PREFIXES, ep } from "./validation-progress";

export async function trackViaParcelsAppStep3(
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
