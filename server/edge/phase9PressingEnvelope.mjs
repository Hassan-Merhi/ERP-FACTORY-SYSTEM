/**
 * Phase 9: typed, immutable LAN evidence for PHYSICAL pressing confirmations.
 * Pressing does not finalize stock, produce a voucher or alter bale ownership.
 * This is deliberately a different stream than the Phase 8 voucher cursor.
 *
 * NOTE: the route remains denied by the LAN writer fence until a supervised
 * cloud-side apply, receipt protocol and full factory reconciliation exist.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF = /^[A-Z0-9][A-Z0-9._/-]{0,99}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class Phase9PressingRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9PressingRefusal";
  }
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validDay(date) {
  if (typeof date !== "string" || !DAY.test(date)) return false;
  const value = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

/**
 * Accept only the authoritative source receipt created within the DB txn.
 * Never substitute device-provided machine, operator, weight or timestamps.
 */
export function phase9PressingEnvelope(evidence) {
  if (!evidence || !positive(evidence.companyId) ||
      !positive(evidence.localConfirmationId) || !positive(evidence.baleId) ||
      !positive(evidence.machineId) || !positive(evidence.assignmentId) ||
      typeof evidence.actorUserId !== "string" ||
      !evidence.actorUserId || evidence.actorUserId.length > 255 ||
      !UUID.test(evidence.requestId ?? "") ||
      typeof evidence.referenceNumber !== "string" ||
      !REF.test(evidence.referenceNumber) ||
      evidence.referenceNumber !== evidence.referenceNumber.toUpperCase() ||
      !validDay(evidence.productionDate) ||
      typeof evidence.timezoneName !== "string" ||
      evidence.timezoneName.length < 1 || evidence.timezoneName.length > 80 ||
      typeof evidence.confirmedAt !== "string" ||
      !UTC.test(evidence.confirmedAt) ||
      !Number.isFinite(Date.parse(evidence.confirmedAt)) ||
      new Date(evidence.confirmedAt).toISOString() !== evidence.confirmedAt ||
      (evidence.deviceCapturedAt !== null &&
       (typeof evidence.deviceCapturedAt !== "string" ||
        !UTC.test(evidence.deviceCapturedAt) ||
        !Number.isFinite(Date.parse(evidence.deviceCapturedAt)) ||
        new Date(evidence.deviceCapturedAt).toISOString() !== evidence.deviceCapturedAt))) {
    throw new Phase9PressingRefusal("PHASE9_PRESSING_EVIDENCE_INVALID");
  }
  return {
    kind: "pressing.confirmation.v1",
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    localConfirmationId: evidence.localConfirmationId,
    baleId: evidence.baleId,
    machineId: evidence.machineId,
    assignmentId: evidence.assignmentId,
    referenceNumber: evidence.referenceNumber,
    confirmedAt: evidence.confirmedAt,
    deviceCapturedAt: evidence.deviceCapturedAt,
    productionDate: evidence.productionDate,
    timezoneName: evidence.timezoneName,
    inventoryFinalized: false,
  };
}
