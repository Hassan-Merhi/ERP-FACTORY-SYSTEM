/**
 * Phase 9 (owner-approved plan 2026-11-05, batch 3): changes to an existing
 * stock transfer made on the factory LAN server during an outage. The changes
 * are an edit (PUT /api/stock-transfers/:id), a finalize/approve, a revision,
 * and a revision approve/reject.
 *
 * Each record names its transfer (or revision) in one of two ways:
 * - `origin: "lan"`: it was created on the LAN during the outage. The cloud
 *   finds its own copy through the applied receipt of the record that
 *   created it, on the same stream.
 * - `origin: "cloud"`: it existed before the outage and has the same id on
 *   both sides.
 *
 * Edits and finalizes also carry the transfer as the factory saw it (the
 * destination, the lifecycle flags and the lines), so the cloud applies them
 * only while its own copy still matches. Revisions carry their original
 * quantities, which the revision service already checks.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY = /^(?:0|[1-9][0-9]{0,14})\.[0-9]{3}$/;
const MAX_REF = 2147483647;
const MAX_LINES = 500;

export const PHASE9_STOCK_TRANSFER_EDIT_KIND = "stock.transfer-edit.v1";
export const PHASE9_STOCK_TRANSFER_FINALIZE_KIND = "stock.transfer-finalize.v1";
export const PHASE9_STOCK_TRANSFER_REVISION_KIND = "stock.transfer-revision.v1";
export const PHASE9_STOCK_TRANSFER_REVISION_REVIEW_KIND = "stock.transfer-revision-review.v1";
/** Overridable: the cloud copy of the transfer changed after the factory saw it; approve = the factory's change wins. */
export const PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT = "PHASE9_STOCK_TRANSFER_CHANGED";

export class Phase9StockTransferWorkflowRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9StockTransferWorkflowRefusal";
  }
}

function ref(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;
}

function plainObject(value, fields) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...fields].sort().join(",")
  );
}

function validDay(date) {
  if (typeof date !== "string" || !DAY.test(date)) return false;
  const value = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

function text(value, max) {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= max;
}

function textOrNull(value, max) {
  return value === null || (typeof value === "string" && value.length <= max);
}

function finiteNumber(value, min, inclusive) {
  return typeof value === "number" && Number.isFinite(value) && (inclusive ? value >= min : value > min);
}

const ACTOR_FIELDS = ["actorUserId", "actorUsername", "businessDate", "companyId", "requestId"];

function validActor(evidence) {
  return (
    ref(evidence.companyId) &&
    text(evidence.actorUserId, 255) &&
    text(evidence.actorUsername, 255) &&
    typeof evidence.requestId === "string" &&
    UUID.test(evidence.requestId) &&
    validDay(evidence.businessDate)
  );
}

function actorOf(evidence) {
  return {
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    businessDate: evidence.businessDate,
  };
}

/** `{origin:"lan", localTransferId}` or `{origin:"cloud", transferId}` (same shape for revisions). */
function recordRef(value, localKey, cloudKey) {
  if (plainObject(value, ["origin", localKey]) && value.origin === "lan" && ref(value[localKey])) {
    return { origin: "lan", [localKey]: value[localKey] };
  }
  if (plainObject(value, ["origin", cloudKey]) && value.origin === "cloud" && ref(value[cloudKey])) {
    return { origin: "cloud", [cloudKey]: value[cloudKey] };
  }
  return null;
}

const SNAPSHOT_LINE_FIELDS = ["quantity", "sourceLocationId", "stockItemId"];

function snapshotKey(line) {
  return `${line.sourceLocationId}:${line.stockItemId}:${line.quantity}`;
}

/** The transfer as the factory saw it: destination, lifecycle flags and lines (sorted). */
function snapshot(value) {
  if (
    !plainObject(value, ["destinationLocationId", "inventoryApplied", "lines", "optional"]) ||
    !ref(value.destinationLocationId) ||
    typeof value.inventoryApplied !== "boolean" ||
    typeof value.optional !== "boolean" ||
    !Array.isArray(value.lines) ||
    value.lines.length > MAX_LINES
  ) {
    return null;
  }
  const lines = [];
  for (const line of value.lines) {
    if (
      !plainObject(line, SNAPSHOT_LINE_FIELDS) ||
      !ref(line.sourceLocationId) ||
      !ref(line.stockItemId) ||
      typeof line.quantity !== "string" ||
      !QUANTITY.test(line.quantity)
    ) {
      return null;
    }
    lines.push({ sourceLocationId: line.sourceLocationId, stockItemId: line.stockItemId, quantity: line.quantity });
  }
  const sorted = [...lines].sort((a, b) => (snapshotKey(a) < snapshotKey(b) ? -1 : 1));
  if (sorted.some((line, index) => snapshotKey(line) !== snapshotKey(lines[index]))) return null;
  return {
    destinationLocationId: value.destinationLocationId,
    optional: value.optional,
    inventoryApplied: value.inventoryApplied,
    lines,
  };
}

/** Build a snapshot from database rows (LAN capture and cloud comparison use the same rule). */
export function phase9TransferSnapshot(header, rows) {
  const lines = rows
    .map((row) => ({
      sourceLocationId: Number(row.sourceLocationId),
      stockItemId: Number(row.stockItemId),
      quantity: Number(row.quantity).toFixed(3),
    }))
    .sort((a, b) => (snapshotKey(a) < snapshotKey(b) ? -1 : 1));
  return {
    destinationLocationId: Number(header.destinationLocationId),
    optional: Boolean(header.optional),
    inventoryApplied: Boolean(header.inventoryApplied),
    lines,
  };
}

const EDIT_ITEM_FIELDS = ["quantity", "rate", "sourceLocationId", "stockItemId"];

function editTarget(value) {
  if (
    !plainObject(value, ["destinationLocationId", "items", "notes"]) ||
    !ref(value.destinationLocationId) ||
    typeof value.notes !== "string" ||
    value.notes.length > 5000 ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > MAX_LINES
  ) {
    return null;
  }
  const items = [];
  for (const item of value.items) {
    if (
      !plainObject(item, EDIT_ITEM_FIELDS) ||
      !ref(item.stockItemId) ||
      !ref(item.sourceLocationId) ||
      !finiteNumber(item.quantity, 0, false) ||
      !finiteNumber(item.rate, 0, true)
    ) {
      return null;
    }
    items.push({
      stockItemId: item.stockItemId,
      sourceLocationId: item.sourceLocationId,
      quantity: item.quantity,
      rate: item.rate,
    });
  }
  return { destinationLocationId: value.destinationLocationId, notes: value.notes, items };
}

function refuse(code) {
  throw new Phase9StockTransferWorkflowRefusal(code);
}

export function phase9StockTransferEditEnvelope(evidence) {
  const code = "PHASE9_STOCK_TRANSFER_EDIT_EVIDENCE_INVALID";
  if (!plainObject(evidence, [...ACTOR_FIELDS, "after", "before", "localEditId", "transfer"])) refuse(code);
  if (!validActor(evidence) || !ref(evidence.localEditId)) refuse(code);
  const transfer = recordRef(evidence.transfer, "localTransferId", "transferId");
  const before = snapshot(evidence.before);
  const after = editTarget(evidence.after);
  if (!transfer || !before || !after) refuse(code);
  return {
    kind: PHASE9_STOCK_TRANSFER_EDIT_KIND,
    ...actorOf(evidence),
    localEditId: evidence.localEditId,
    transfer,
    before,
    after,
  };
}

export function phase9StockTransferFinalizeEnvelope(evidence) {
  const code = "PHASE9_STOCK_TRANSFER_FINALIZE_EVIDENCE_INVALID";
  if (!plainObject(evidence, [...ACTOR_FIELDS, "before", "localEditId", "transfer"])) refuse(code);
  if (!validActor(evidence) || !ref(evidence.localEditId)) refuse(code);
  const transfer = recordRef(evidence.transfer, "localTransferId", "transferId");
  const before = snapshot(evidence.before);
  if (!transfer || !before) refuse(code);
  return {
    kind: PHASE9_STOCK_TRANSFER_FINALIZE_KIND,
    ...actorOf(evidence),
    localEditId: evidence.localEditId,
    transfer,
    before,
  };
}

const REVISION_ITEM_FIELDS = [
  "newQuantity",
  "originalQuantity",
  "sourceLocationId",
  "sourceLocationName",
  "stockItemId",
  "stockItemName",
];

function revisionBody(value) {
  if (
    !plainObject(value, ["items", "note", "pending", "sourceLocationIdLimit"]) ||
    !textOrNull(value.note, 5000) ||
    typeof value.pending !== "boolean" ||
    !(value.sourceLocationIdLimit === null || ref(value.sourceLocationIdLimit)) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > MAX_LINES
  ) {
    return null;
  }
  const items = [];
  for (const item of value.items) {
    if (
      !plainObject(item, REVISION_ITEM_FIELDS) ||
      !ref(item.stockItemId) ||
      !text(item.stockItemName, 500) ||
      !ref(item.sourceLocationId) ||
      !textOrNull(item.sourceLocationName, 500) ||
      !finiteNumber(item.originalQuantity, 0, true) ||
      !finiteNumber(item.newQuantity, 0, true)
    ) {
      return null;
    }
    items.push({
      stockItemId: item.stockItemId,
      stockItemName: item.stockItemName,
      sourceLocationId: item.sourceLocationId,
      sourceLocationName: item.sourceLocationName,
      originalQuantity: item.originalQuantity,
      newQuantity: item.newQuantity,
    });
  }
  return {
    note: value.note,
    pending: value.pending,
    sourceLocationIdLimit: value.sourceLocationIdLimit,
    items,
  };
}

export function phase9StockTransferRevisionEnvelope(evidence) {
  const code = "PHASE9_STOCK_TRANSFER_REVISION_EVIDENCE_INVALID";
  if (!plainObject(evidence, [...ACTOR_FIELDS, "localRevisionId", "revision", "transfer"])) refuse(code);
  if (!validActor(evidence) || !ref(evidence.localRevisionId)) refuse(code);
  const transfer = recordRef(evidence.transfer, "localTransferId", "transferId");
  const revision = revisionBody(evidence.revision);
  if (!transfer || !revision) refuse(code);
  return {
    kind: PHASE9_STOCK_TRANSFER_REVISION_KIND,
    ...actorOf(evidence),
    localRevisionId: evidence.localRevisionId,
    transfer,
    revision,
  };
}

export function phase9StockTransferRevisionReviewEnvelope(evidence) {
  const code = "PHASE9_STOCK_TRANSFER_REVISION_REVIEW_EVIDENCE_INVALID";
  if (!plainObject(evidence, [...ACTOR_FIELDS, "decision", "localEditId", "reason", "revision"])) refuse(code);
  if (
    !validActor(evidence) ||
    !ref(evidence.localEditId) ||
    (evidence.decision !== "approve" && evidence.decision !== "reject") ||
    !textOrNull(evidence.reason, 1000) ||
    (evidence.decision === "approve" && evidence.reason !== null)
  ) {
    refuse(code);
  }
  const revision = recordRef(evidence.revision, "localRevisionId", "revisionId");
  if (!revision) refuse(code);
  return {
    kind: PHASE9_STOCK_TRANSFER_REVISION_REVIEW_KIND,
    ...actorOf(evidence),
    localEditId: evidence.localEditId,
    revision,
    decision: evidence.decision,
    reason: evidence.reason,
  };
}
