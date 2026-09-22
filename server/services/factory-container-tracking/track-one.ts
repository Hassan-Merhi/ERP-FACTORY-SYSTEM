import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { factoryContainers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { trackContainer, deriveLastStatus, deriveLastLocation, deriveLastEventDate } from "../../lib/parcelsAppClient";
import { resolveProvider } from "../../lib/trackingProviders/providerResolver";
import { refreshFactoryContainerEta as refreshJsonCargoEta } from "../factoryJsonCargoTrackingService";
import { normalizeJsonCargoCarrier } from "../../lib/trackingProviders/jsonCargoProvider";
import { extractVesselIdentity, saveVesselMapping } from "../ais/vesselMapping";

import { trackViaParcelsApp } from "./parcels-app";
import { resolveEtaFromProvider, resolveEtaFromShipment, saveDirectEvents, saveParcelsAppEvents, saveTrackingCheck } from "./persistence";
import { ep, isValidContainerNumber } from "./progress-quota";

export async function trackOneContainer(containerId: number, containerNumber: string, destinationCountry: string = "Congo", manualCarrierHint: string | null = null): Promise<{ success: boolean; lastStatus: string | null; lastLocation: string | null; lastDescription: string | null; lastCheckedAt: Date; error: string | null; }> {
  const now = new Date();
  const [currentRow] = await db.select({ arrivalDate: factoryContainers.arrivalDate, trackingLastCheckedAt: factoryContainers.trackingLastCheckedAt, trackingCarrierHint: factoryContainers.trackingCarrierHint }).from(factoryContainers).where(eq(factoryContainers.id, containerId)).limit(1);
  let currentEta: string | null = currentRow?.arrivalDate ?? null;

  if (normalizeJsonCargoCarrier(currentRow?.trackingCarrierHint)) {
    ep(containerId, "JSON Cargo ETA", "running");
    try {
      const jc = await refreshJsonCargoEta(containerId);
      if (jc.newEta) currentEta = jc.newEta;
      if (jc.status === "skipped_recent") ep(containerId, "JSON Cargo ETA", "skip", jc.message);
      else if (jc.status === "updated" || jc.status === "unchanged") { ep(containerId, "JSON Cargo ETA", "success", jc.message); logger.info(`[FactoryTracking] ${containerNumber}: jsoncargo → ${jc.status} (${jc.message})`); }
      else { ep(containerId, "JSON Cargo ETA", "fail", jc.message); logger.info(`[FactoryTracking] ${containerNumber}: jsoncargo → ${jc.status} (${jc.message})`); }
    } catch (err: unknown) { ep(containerId, "JSON Cargo ETA", "fail", getErrorMessage(err) ?? "Unexpected error"); logger.warn(`[FactoryTracking] : jsoncargo pre-check error`, { error: getErrorMessage(err) ?? err }); }
  }

  if (!isValidContainerNumber(containerNumber)) {
    const errMsg = `Invalid container number format: "${containerNumber}" (must be 4 letters + 7 digits)`;
    await saveTrackingCheck(containerId, "skipped", "invalid_container_number", errMsg, null);
    await db.update(factoryContainers).set({ trackingLastCheckedAt: now, trackingError: errMsg }).where(eq(factoryContainers.id, containerId));
    return { success: false, lastStatus: null, lastLocation: null, lastDescription: null, lastCheckedAt: now, error: errMsg };
  }

  const { detectedCarrier, tryDirect } = resolveProvider(containerNumber);
  let lastDirectFallbackReason: string | null = null;
  for (const attempt of tryDirect) {
    const result = await attempt();
    if (result.success) {
      await saveDirectEvents(containerId, result);
      await saveTrackingCheck(containerId, result.provider, "success", null, result.raw);
      const identity = result.vessel ?? extractVesselIdentity(result.raw);
      if (identity) {
        await saveVesselMapping(containerId, { ...identity, carrier: result.carrier ?? detectedCarrier, source: result.provider, confidence: identity.mmsi || identity.imo ? "verified" : "probable" });
      }
      const { eta: finalEta } = resolveEtaFromProvider(result.eta ?? null, result.events, currentEta);
      const updateSet: Record<string, unknown> = { trackingLastCheckedAt: now, trackingLastStatus: result.latestStatus, trackingLastEventDate: result.latestEventDate, trackingLastDescription: result.latestDescription, trackingError: null, trackingChangedAt: now, trackingProvider: result.provider, trackingDetectedCarrier: detectedCarrier };
      if (finalEta) updateSet.arrivalDate = finalEta;
      await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
      return { success: true, lastStatus: result.latestStatus, lastLocation: result.latestLocation, lastDescription: result.latestDescription, lastCheckedAt: now, error: null };
    }
    const checkStatus = result.blocked ? "blocked" : result.noData ? "no_data" : "error";
    await saveTrackingCheck(containerId, result.provider, checkStatus, result.error ?? null, null);
    lastDirectFallbackReason = result.provider + "_failed";
  }
  return await trackViaParcelsApp(containerId, containerNumber, detectedCarrier, lastDirectFallbackReason, now, currentEta, destinationCountry, manualCarrierHint);
}

export async function trackViaParcelsAppFallback(containerId: number, containerNumber: string, detectedCarrier: string | null, fallbackReason: string | null, now: Date, currentEta: string | null, destinationCountry: string = "Congo", manualCarrierHint: string | null = null): Promise<{ success: boolean; lastStatus: string | null; lastLocation: string | null; lastDescription: string | null; lastCheckedAt: Date; error: string | null; }> {
  if (!process.env.PARCELSAPP_API_KEY) {
    const noProviderError = "No tracking provider configured";
    await db.update(factoryContainers).set({ trackingLastCheckedAt: now, trackingError: noProviderError }).where(eq(factoryContainers.id, containerId));
    return { success: false, lastStatus: null, lastLocation: null, lastDescription: null, lastCheckedAt: now, error: noProviderError };
  }
  ep(containerId, "ParcelsApp API", "running");
  const effectiveHint = manualCarrierHint || (detectedCarrier && detectedCarrier !== "OTHER" ? detectedCarrier : null);
  let result = await trackContainer(containerNumber, destinationCountry, effectiveHint ?? undefined);
  await saveTrackingCheck(containerId, "parcelsapp", result.success ? "success" : result.timedOut ? "timeout" : "error", result.error ?? null, result.rawResponse);
  if (result.timedOut && effectiveHint) {
    ep(containerId, "ParcelsApp API (retry no hint)", "running");
    const retryResult = await trackContainer(containerNumber, destinationCountry, undefined);
    await saveTrackingCheck(containerId, "parcelsapp_retry_no_hint", retryResult.success ? "success" : retryResult.timedOut ? "timeout" : "error", retryResult.error ?? null, retryResult.rawResponse);
    if (retryResult.success && retryResult.shipment) result = { ...retryResult, rawResponse: retryResult.rawResponse };
  }
  if (!result.success || !result.shipment) {
    const errMsg = result.timedOut ? `Carrier timed out (dest=${destinationCountry})` : (result.error ?? "Tracking failed");
    await db.update(factoryContainers).set({ trackingLastCheckedAt: now, trackingError: errMsg, trackingProvider: "parcelsapp" }).where(eq(factoryContainers.id, containerId));
    return { success: false, lastStatus: null, lastLocation: null, lastDescription: null, lastCheckedAt: now, error: errMsg };
  }
  const shipment = result.shipment;
  const lastStatus = deriveLastStatus(shipment), lastLocation = deriveLastLocation(shipment), lastEventDate = deriveLastEventDate(shipment), lastDescription = shipment.states?.[0]?.description ?? null;
  const identity = extractVesselIdentity(result.rawResponse ?? shipment);
  if (identity) await saveVesselMapping(containerId, { ...identity, carrier: detectedCarrier, source: "parcelsapp", confidence: identity.mmsi || identity.imo ? "verified" : "probable" });
  const { eta: finalEta } = resolveEtaFromShipment(shipment, currentEta);
  await saveParcelsAppEvents(containerId, shipment);
  const updateSet: Record<string, unknown> = { trackingLastCheckedAt: now, trackingLastStatus: lastStatus, trackingLastEventDate: lastEventDate, trackingLastDescription: lastDescription, trackingError: null, trackingChangedAt: now, trackingProvider: "parcelsapp", trackingDetectedCarrier: detectedCarrier, trackingFallbackUsed: !!fallbackReason, trackingFallbackReason: fallbackReason };
  if (finalEta) updateSet.arrivalDate = finalEta;
  await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));
  return { success: true, lastStatus, lastLocation, lastDescription, lastCheckedAt: now, error: null };
}
