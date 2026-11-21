/**
 * Full offline mode (Phase C1b): the two fields only a PC's entry may carry on
 * top of a browser-sync operation.
 *
 * - `pcKey`: the key the PC files its own customers and ledgers under, one per
 *   PC and company and shared by everyone using that PC, so an entry one person
 *   makes can name a customer another person created there. Without it, the
 *   delivery device id is used.
 * - `mergeInto`: with the possible-duplicate approval of a held customer, the
 *   existing cloud customer the PC's customer is approved as.
 */
import {
  PHASE9_CUSTOMER_CREATE_KIND,
  PHASE9_CUSTOMER_DUPLICATE_CONFLICT,
} from "../../edge/phase9CustomerCreateEnvelope.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PcRequestExtras {
  /** Where the PC's own records are filed: its key, or the delivery device id. */
  recordSite: string;
  mergeInto?: number;
}

/** The PC-only fields, checked; null when they are malformed or not allowed here. */
export function pcRequestExtras(
  request: { pcKey?: unknown; mergeInto?: unknown },
  { pcRoute, deviceId, kind, override }: { pcRoute: boolean; deviceId: string; kind: string; override: string | null }
): PcRequestExtras | null {
  const { pcKey, mergeInto } = request;
  if (pcKey !== undefined && (!pcRoute || typeof pcKey !== "string" || !UUID.test(pcKey))) return null;
  if (
    mergeInto !== undefined &&
    (!pcRoute ||
      typeof mergeInto !== "number" ||
      !Number.isSafeInteger(mergeInto) ||
      mergeInto < 1 ||
      kind !== PHASE9_CUSTOMER_CREATE_KIND ||
      override !== PHASE9_CUSTOMER_DUPLICATE_CONFLICT)
  ) {
    return null;
  }
  return {
    recordSite: typeof pcKey === "string" ? pcKey.toLowerCase() : deviceId,
    ...(typeof mergeInto === "number" ? { mergeInto } : {}),
  };
}
