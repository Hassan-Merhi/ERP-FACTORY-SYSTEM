/**
 * Phase 9: typed, immutable LAN evidence for receiving a container against
 * its existing purchase orders (POST /api/containers/:id/offload) while the
 * factory LAN server is the writer.
 *
 * Owner policy (2026-11-01): offline receiving is against existing purchase
 * orders only and records quantities only — no duties, charges, cost
 * corrections or price edits. The cloud applies its own current purchase
 * order prices when the receipt is replayed. `lineDigest` fingerprints the
 * ordered quantities (stock item + quantity per line, no prices) the LAN
 * received, so the cloud can tell if the order's quantities changed.
 */
import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_REF = 2147483647;

export const PHASE9_RECEIVING_KIND = "receiving.container-offload.v1";
export const PHASE9_RECEIVING_ORDER_CHANGED = "PHASE9_RECEIVING_ORDER_CHANGED";

const INPUT_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "companyId",
  "containerId",
  "lineDigest",
  "localOffloadId",
  "locationId",
  "offloadDate",
  "requestId",
]);

export class Phase9ReceivingRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9ReceivingRefusal";
  }
}

const ref = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;

function validDay(date) {
  if (typeof date !== "string" || !DAY.test(date)) return false;
  const value = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

/**
 * Order-independent digest of what is being received: each line's stock
 * item and quantity (normalised decimal), sorted. Prices are excluded.
 */
export function phase9ReceivingLineDigest(lines) {
  const normalised = lines
    .map((line) => {
      const quantity = String(line.quantity).trim();
      const [whole, fraction = ""] = quantity.split(".");
      const trimmed = fraction.replace(/0+$/, "");
      return `${Number(line.stockItemId)}:${String(BigInt(whole || "0"))}${trimmed ? "." + trimmed : ""}`;
    })
    .sort();
  return createHash("sha256").update(normalised.join("\n"), "utf8").digest("hex");
}

export function phase9ReceivingEnvelope(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== INPUT_FIELDS.join(",") ||
    !ref(evidence.companyId) ||
    !ref(evidence.localOffloadId) ||
    !ref(evidence.containerId) ||
    !ref(evidence.locationId) ||
    typeof evidence.actorUserId !== "string" ||
    evidence.actorUserId.length < 1 ||
    evidence.actorUserId.length > 255 ||
    typeof evidence.actorUsername !== "string" ||
    evidence.actorUsername.length < 1 ||
    evidence.actorUsername.length > 255 ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    !validDay(evidence.offloadDate) ||
    typeof evidence.lineDigest !== "string" ||
    !HASH.test(evidence.lineDigest)
  ) {
    throw new Phase9ReceivingRefusal("PHASE9_RECEIVING_EVIDENCE_INVALID");
  }
  return {
    kind: PHASE9_RECEIVING_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localOffloadId: evidence.localOffloadId,
    containerId: evidence.containerId,
    locationId: evidence.locationId,
    offloadDate: evidence.offloadDate,
    lineDigest: evidence.lineDigest,
  };
}
