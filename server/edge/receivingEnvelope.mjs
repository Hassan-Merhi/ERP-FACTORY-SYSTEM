/**
 * Phase 9: typed, immutable LAN evidence for receiving a container against
 * its existing purchase orders (POST /api/containers/:id/offload) while the
 * factory LAN server is the writer.
 *
 * Owner policy (2026-11-01, extended 2026-11-02): offline receiving is
 * against existing purchase orders and carries the full offload exactly as
 * entered — duties, office/transfer/transport charges with their accounts,
 * additional charges, cost corrections and agent lines — and an offload may
 * be edited offline (`mode: "edit"`). The cloud replays the same inputs
 * through the offload lifecycle with its current purchase order prices.
 * `lineDigest` fingerprints the ordered quantities (stock item + quantity per
 * line, no prices) so the cloud can tell if the order's quantities changed.
 */
import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_REF = 2147483647;
const MONEY = /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/;
const MAX_LINES = 500;

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
  "mode",
  "offload",
  "offloadDate",
  "requestId",
]);
const OFFLOAD_FIELDS = Object.freeze([
  "additionalCharges",
  "agentChargeLines",
  "duties",
  "dutiesAccountId",
  "inventoryCostCorrections",
  "officeCharges",
  "officeChargesAccountId",
  "officeChargesCashAccountId",
  "transferCharges",
  "transportAccountId",
  "transportFees",
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

const money = (value) => typeof value === "string" && MONEY.test(value);
const optionalRef = (value) => value === null || ref(value);
const exactKeys = (value, keys) =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;

/** The offload inputs as canonical strings/ids (amounts are decimal strings). */
function offloadInputs(offload) {
  if (
    !exactKeys(offload, OFFLOAD_FIELDS.join(",")) ||
    !money(offload.duties) ||
    !money(offload.officeCharges) ||
    !money(offload.transferCharges) ||
    !money(offload.transportFees) ||
    !optionalRef(offload.dutiesAccountId) ||
    !optionalRef(offload.officeChargesAccountId) ||
    !optionalRef(offload.officeChargesCashAccountId) ||
    !optionalRef(offload.transportAccountId) ||
    !Array.isArray(offload.additionalCharges) ||
    offload.additionalCharges.length > MAX_LINES ||
    !Array.isArray(offload.inventoryCostCorrections) ||
    offload.inventoryCostCorrections.length > MAX_LINES ||
    !Array.isArray(offload.agentChargeLines) ||
    offload.agentChargeLines.length > MAX_LINES
  ) {
    throw new Phase9ReceivingRefusal("PHASE9_RECEIVING_EVIDENCE_INVALID");
  }
  const additionalCharges = offload.additionalCharges.map((line) => {
    if (
      !exactKeys(line, "amount,description,ledgerAccountId") ||
      typeof line.description !== "string" ||
      line.description.length < 1 ||
      line.description.length > 500 ||
      !money(line.amount) ||
      !ref(line.ledgerAccountId)
    ) {
      throw new Phase9ReceivingRefusal("PHASE9_RECEIVING_EVIDENCE_INVALID");
    }
    return { description: line.description, amount: line.amount, ledgerAccountId: line.ledgerAccountId };
  });
  const inventoryCostCorrections = offload.inventoryCostCorrections.map((line) => {
    if (!exactKeys(line, "correctRate,stockItemId") || !ref(line.stockItemId) || !money(line.correctRate)) {
      throw new Phase9ReceivingRefusal("PHASE9_RECEIVING_EVIDENCE_INVALID");
    }
    return { stockItemId: line.stockItemId, correctRate: line.correctRate };
  });
  const agentChargeLines = offload.agentChargeLines.map((line) => {
    if (
      !exactKeys(line, "amountUsd,description,parentAgentAccountId") ||
      (line.description !== null && (typeof line.description !== "string" || line.description.length > 500)) ||
      !money(line.amountUsd) ||
      !ref(line.parentAgentAccountId)
    ) {
      throw new Phase9ReceivingRefusal("PHASE9_RECEIVING_EVIDENCE_INVALID");
    }
    return {
      description: line.description,
      amountUsd: line.amountUsd,
      parentAgentAccountId: line.parentAgentAccountId,
    };
  });
  return {
    duties: offload.duties,
    dutiesAccountId: offload.dutiesAccountId,
    officeCharges: offload.officeCharges,
    officeChargesAccountId: offload.officeChargesAccountId,
    officeChargesCashAccountId: offload.officeChargesCashAccountId,
    transferCharges: offload.transferCharges,
    transportFees: offload.transportFees,
    transportAccountId: offload.transportAccountId,
    additionalCharges,
    inventoryCostCorrections,
    agentChargeLines,
  };
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
    !HASH.test(evidence.lineDigest) ||
    (evidence.mode !== "create" && evidence.mode !== "edit")
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
    mode: evidence.mode,
    offload: offloadInputs(evidence.offload),
  };
}
