/**
 * providerResolver.ts — Detect carrier from container number prefix.
 *
 * The resolver identifies which carrier operates the container so the
 * tracking service can route it to the right provider:
 *   MAERSK → maersk_direct (Puppeteer intercept of Maersk's own API)
 *   CMA    → parcelsapp API directly
 *   MSC    → http_scraper (direct MSC API)
 *   HAPAG  → http_scraper (direct Hapag-Lloyd API)
 *   Others → http_scraper → parcelsapp_scraper → 17track → parcelsapp API
 *
 * tryDirect is always empty — carrier routing is handled in
 * containerTrackingService.ts via the http_scraper and maersk_direct steps.
 */

import type { CarrierTrackResult } from "./types";
import { logger } from "../../lib/logger";

export type DetectedCarrier = "MAERSK" | "CMA" | "MSC" | "HAPAG" | "OTHER" | null;

// ── Prefix → carrier map ──────────────────────────────────────────────────────

const PREFIX_MAP: Record<string, DetectedCarrier> = {
  // ── Maersk Line (incl. Hamburg Süd, SafMarine, Seago subsidiaries) ─────────
  MAEU: "MAERSK",
  MRKU: "MAERSK",
  MSKU: "MAERSK",
  MRSU: "MAERSK",
  MCIU: "MAERSK",
  SUDU: "MAERSK",
  HASU: "MAERSK",
  TRHU: "MAERSK",
  TEMU: "MAERSK",
  SEAU: "MAERSK",
  PONU: "MAERSK",
  SEGU: "MAERSK",
  HJSC: "MAERSK",
  HJCU: "MAERSK",
  SAFM: "MAERSK",

  // ── CMA CGM (incl. ANL, APL, CNC) ─────────────────────────────────────────
  CMAU: "CMA",
  CMDU: "CMA",
  APZU: "CMA",
  CGMU: "CMA",
  APMU: "CMA",
  APHU: "CMA",
  CXDU: "CMA",
  CAAU: "CMA",
  CAJU: "CMA",
  CAIU: "CMA",

  // ── MSC ───────────────────────────────────────────────────────────────────
  MSCU: "MSC",
  MEDU: "MSC",
  MSDU: "MSC",
  MSMU: "MSC",
  MSWU: "MSC",

  // ── Hapag-Lloyd ───────────────────────────────────────────────────────────
  HLCU: "HAPAG",
  HLXU: "HAPAG",

  // ── COSCO ─────────────────────────────────────────────────────────────────
  COSU: "OTHER",
  CBHU: "OTHER",
  CCLU: "OTHER",
  COSJ: "OTHER",

  // ── Evergreen ─────────────────────────────────────────────────────────────
  EVRU: "OTHER",
  EVRG: "OTHER",
  EMCU: "OTHER",
  EGHU: "OTHER",

  // ── Leasing (box owner ≠ shipping line — let ParcelsApp auto-detect) ──────
  TCNU: "OTHER",
  TGBU: "OTHER",
  TCKU: "OTHER",
  TLLU: "OTHER",
  TCLU: "OTHER",
  TGHU: "OTHER",
  TIIU: "OTHER",
  UETU: "OTHER",
  ECMU: "OTHER",
  TXGI: "OTHER",
};

// Real ISO container numbers are 11 characters; skip obvious placeholders.
const MIN_LEN = 9;

export function detectCarrier(containerNumber: string): DetectedCarrier {
  const trimmed = containerNumber.trim();
  if (trimmed.length < MIN_LEN) return null;
  const prefix = trimmed.toUpperCase().slice(0, 4);
  return PREFIX_MAP[prefix] ?? null;
}

// ── Resolution result ─────────────────────────────────────────────────────────

export interface ProviderResolution {
  detectedCarrier: DetectedCarrier;
  /**
   * Always empty — carrier-specific routing is handled inside
   * containerTrackingService.trackViaParcelsApp() via http_scraper and
   * maersk_direct steps. This field is kept for API compatibility.
   */
  tryDirect: Array<() => Promise<CarrierTrackResult>>;
}

export function resolveProvider(containerNumber: string): ProviderResolution {
  const detectedCarrier = detectCarrier(containerNumber);
  logger.info(
    `[ProviderResolver] container=${containerNumber} prefix=${containerNumber.slice(0, 4).toUpperCase()} ` +
      `detectedCarrier=${detectedCarrier ?? "unknown"} directProviders=[none]`
  );
  return { detectedCarrier, tryDirect: [] };
}
