/**
 * Phase 9: generic factory LAN -> cloud business EVENT transport.
 *
 * The Phase 4/8 voucher stream stays separate. Every non-voucher business
 * workflow is a named stream with its own gapless LAN sequence, its own cloud
 * staging cursor and its own exactly-once apply cursor, so a blocked or
 * conflicting pressing scan can never create a gap in financial replay.
 *
 * A stream only accepts the event kinds registered here, and every payload
 * must be byte-for-byte the canonical envelope that the LAN capture produced.
 * Registering a kind is the review gate for a new offline write workflow.
 */
import { canonicalEvidence, hashEvidence } from "./edgeSyncStageProtocol.mjs";
import { phase9PressingEnvelope } from "./phase9PressingEnvelope.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SEQUENCE = /^[1-9][0-9]{0,18}$/;
const MAX_SEQUENCE = 9223372036854775807n;

export const EDGE_EVENT_STAGE_PATH = "/api/edge/sync/events/stage";
export const EDGE_EVENT_STAGE_PROTOCOL = "factory-lan-event-stage/v1";
export const EDGE_EVENT_STAGE_RECEIPT_PROTOCOL = "factory-lan-event-stage-receipt/v1";
export const EDGE_EVENT_RECEIPT_QUERY_PATH = "/api/edge/sync/events/applied-receipts";
export const EDGE_EVENT_RECEIPT_QUERY_PROTOCOL = "factory-lan-event-applied-query/v1";
export const EDGE_EVENT_RECEIPT_PROTOCOL = "factory-lan-event-applied-receipts/v1";
export const EDGE_EVENT_STAGE_LIMIT = 25;

/** Outcomes a cloud apply receipt may carry. Never "staged". */
export const EVENT_APPLY_OUTCOMES = Object.freeze(["cloud-applied", "already-present", "rejected-conflict"]);

// Key order is not significant (JSONB reorders keys); values and the exact
// set of keys are.
function stableEqual(left, right) {
  return JSON.stringify(canonicalEvidence(left)) === JSON.stringify(canonicalEvidence(right));
}

/**
 * Rebuild the envelope from the received payload. Any extra, missing or
 * altered field (for example inventoryFinalized: true) fails closed.
 */
function pressingPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.kind !== "pressing.confirmation.v1" || payload.inventoryFinalized !== false) return null;
  const { kind: _kind, inventoryFinalized: _final, ...evidence } = payload;
  let rebuilt;
  try {
    rebuilt = phase9PressingEnvelope(evidence);
  } catch {
    return null;
  }
  return stableEqual(rebuilt, payload) ? rebuilt : null;
}

const STREAMS = Object.freeze({
  pressing: Object.freeze({
    kinds: Object.freeze({
      "pressing.confirmation.v1": Object.freeze({
        parse: pressingPayload,
        localRef: (payload) => payload.localConfirmationId,
      }),
    }),
  }),
});

export function phase9EventStreams() {
  return Object.keys(STREAMS);
}

export function isPhase9EventStream(stream) {
  return typeof stream === "string" && Object.prototype.hasOwnProperty.call(STREAMS, stream);
}

/**
 * Validate one event against its stream's registry. Identity fields on the
 * envelope must equal the same fields inside the hashed payload, so a relay
 * can never re-label the company, actor or operation of signed evidence.
 */
export function validatePhase9Event(stream, event) {
  if (!isPhase9EventStream(stream)) throw new Error("EDGE_EVENT_STREAM_INVALID");
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    Object.keys(event).sort().join(",") !==
      "actorUserId,companyId,kind,localRef,operationId,payload,payloadSha256,sequence" ||
    typeof event.sequence !== "string" ||
    !SEQUENCE.test(event.sequence) ||
    BigInt(event.sequence) > MAX_SEQUENCE ||
    typeof event.operationId !== "string" ||
    !UUID.test(event.operationId) ||
    !Number.isSafeInteger(event.companyId) ||
    event.companyId < 1 ||
    !Number.isSafeInteger(event.localRef) ||
    event.localRef < 1 ||
    typeof event.actorUserId !== "string" ||
    event.actorUserId.length < 1 ||
    event.actorUserId.length > 255 ||
    typeof event.payloadSha256 !== "string" ||
    !HASH.test(event.payloadSha256)
  ) {
    throw new Error("EDGE_EVENT_INVALID");
  }
  const kinds = STREAMS[stream].kinds;
  if (typeof event.kind !== "string" || !Object.prototype.hasOwnProperty.call(kinds, event.kind)) {
    throw new Error("EDGE_EVENT_KIND_NOT_ALLOWED");
  }
  const kind = kinds[event.kind];
  const payload = kind.parse(event.payload);
  if (
    !payload ||
    payload.requestId !== event.operationId ||
    payload.companyId !== event.companyId ||
    payload.actorUserId !== event.actorUserId ||
    kind.localRef(payload) !== event.localRef
  ) {
    throw new Error("EDGE_EVENT_PAYLOAD_INVALID");
  }
  if (hashEvidence(event.payload) !== event.payloadSha256) throw new Error("EDGE_EVENT_HASH_MISMATCH");
  return event;
}

export function validatePhase9EventStageEnvelope(body, expectedSiteId) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(",") !== "events,protocol,siteId,stream" ||
    body.protocol !== EDGE_EVENT_STAGE_PROTOCOL ||
    typeof body.siteId !== "string" ||
    !UUID.test(body.siteId) ||
    body.siteId !== expectedSiteId ||
    !isPhase9EventStream(body.stream) ||
    !Array.isArray(body.events) ||
    body.events.length < 1 ||
    body.events.length > EDGE_EVENT_STAGE_LIMIT
  ) {
    throw new Error("EDGE_EVENT_ENVELOPE_INVALID");
  }
  let last = 0n;
  return body.events.map((event) => {
    validatePhase9Event(body.stream, event);
    const sequence = BigInt(event.sequence);
    if (sequence <= last) throw new Error("EDGE_EVENT_ORDER_INVALID");
    last = sequence;
    return event;
  });
}

export function validatePhase9ReceiptQuery(body, expectedSiteId) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(",") !== "fromSequence,protocol,siteId,stream" ||
    body.protocol !== EDGE_EVENT_RECEIPT_QUERY_PROTOCOL ||
    typeof body.siteId !== "string" ||
    !UUID.test(body.siteId) ||
    body.siteId !== expectedSiteId ||
    !isPhase9EventStream(body.stream) ||
    typeof body.fromSequence !== "string" ||
    !SEQUENCE.test(body.fromSequence) ||
    BigInt(body.fromSequence) > MAX_SEQUENCE
  ) {
    throw new Error("PHASE9_RECEIPT_QUERY_INVALID");
  }
  return body;
}
