import { db } from "../../db";
import { logger } from "../../lib/logger";
import { factoryContainers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { ep } from "./progress-quota";
import { trackViaParcelsAppStep1 } from "./trackViaParcelsAppStep1";
import { trackViaParcelsAppStep2 } from "./trackViaParcelsAppStep2";
import { trackViaParcelsAppStep3 } from "./trackViaParcelsAppStep3";

export async function trackViaParcelsApp(
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date,
  currentEta: string | null,
  destinationCountry: string = "Congo",
  manualCarrierHint: string | null = null
): Promise<{
  success: boolean;
  lastStatus: string | null;
  lastLocation: string | null;
  lastDescription: string | null;
  lastCheckedAt: Date;
  error: string | null;
}> {
  const step1Result = await trackViaParcelsAppStep1(containerId, containerNumber, detectedCarrier, now, currentEta);
  if (step1Result.done) return step1Result.value;
  const { CMA_PREFIXES } = step1Result;
  const step2Result = await trackViaParcelsAppStep2(
    { CMA_PREFIXES },
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now,
    currentEta,
    destinationCountry,
    manualCarrierHint
  );
  if (step2Result.done) return step2Result.value;
  const { MAERSK_PREFIXES_FC } = step2Result;
  const step3Result = await trackViaParcelsAppStep3(
    { CMA_PREFIXES, MAERSK_PREFIXES_FC },
    containerId,
    containerNumber,
    detectedCarrier,
    now,
    currentEta,
    destinationCountry,
    manualCarrierHint
  );
  if (step3Result.done) return step3Result.value;
  const { finalEta, lastDescription, lastEventDate, lastLocation, lastStatus } = step3Result;
  await trackViaParcelsAppStep4(
    { finalEta, lastDescription, lastEventDate, lastStatus },
    containerId,
    containerNumber,
    detectedCarrier,
    fallbackReason,
    now
  );
  return { success: true, lastStatus, lastLocation, lastDescription, lastCheckedAt: now, error: null };
}

async function trackViaParcelsAppStep4(
  {
    finalEta,
    lastDescription,
    lastEventDate,
    lastStatus,
  }: Pick<
    Extract<Awaited<ReturnType<typeof trackViaParcelsAppStep3>>, { done: false }>,
    "finalEta" | "lastDescription" | "lastEventDate" | "lastStatus"
  >,
  containerId: number,
  containerNumber: string,
  detectedCarrier: string | null,
  fallbackReason: string | null,
  now: Date
) {
  const updateSet: Record<string, unknown> = {
    trackingLastCheckedAt: now,
    trackingLastStatus: lastStatus,
    trackingLastEventDate: lastEventDate,
    trackingLastDescription: lastDescription,
    trackingError: null,
    trackingChangedAt: now,
    trackingProvider: "parcelsapp",
    trackingDetectedCarrier: detectedCarrier,
    trackingFallbackUsed: !!fallbackReason,
    trackingFallbackReason: fallbackReason,
  };
  if (finalEta) updateSet.arrivalDate = finalEta;
  await db.update(factoryContainers).set(updateSet).where(eq(factoryContainers.id, containerId));

  ep(containerId, "ParcelsApp API", "success", lastStatus ?? "got data");
  logger.info(`[FactoryTracking] ${containerNumber} → parcelsapp: status=${lastStatus ?? "?"}`);
  return {};
}
