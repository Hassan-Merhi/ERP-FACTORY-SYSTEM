/**
 * Factory LAN -> cloud evidence transport v1.
 * This protocol stages immutable, signed evidence. No business posting occurs.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SEQUENCE = /^[1-9][0-9]{0,18}$/;
export const EDGE_SYNC_STAGE_PATH = "/api/edge/sync/stage";
export const EDGE_SYNC_STAGE_VERSION = "factory-lan-voucher-stage/v1";
export const EDGE_SYNC_STAGE_LIMIT = 25;

function validIdentifier(value) {
  return typeof value === "string" && UUID.test(value);
}

export function canonicalEvidence(input) {
  if (Array.isArray(input)) return input.map(canonicalEvidence);
  if (input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, value]) => [key, canonicalEvidence(value)])
    );
  }
  return input;
}

export function hashEvidence(payload) {
  return createHash("sha256").update(JSON.stringify(canonicalEvidence(payload)), "utf8").digest("hex");
}

export function validateStageEnvelope(body, expectedSiteId) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "events,protocol,siteId" ||
      body.protocol !== EDGE_SYNC_STAGE_VERSION || body.siteId !== expectedSiteId ||
      !validIdentifier(body.siteId) || !Array.isArray(body.events) ||
      body.events.length < 1 || body.events.length > EDGE_SYNC_STAGE_LIMIT) {
    throw new Error("EDGE_SYNC_ENVELOPE_INVALID");
  }
  let last = 0n;
  return body.events.map((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e) ||
        Object.keys(e).sort().join(",") !== "actorUserId,companyId,kind,localVoucherId,operationId,payload,payloadSha256,sequence" ||
        typeof e.sequence !== "string" || !SEQUENCE.test(e.sequence) ||
        BigInt(e.sequence) > 9223372036854775807n ||
        !validIdentifier(e.operationId) ||
        !Number.isSafeInteger(e.companyId) || e.companyId < 1 ||
        !Number.isSafeInteger(e.localVoucherId) || e.localVoucherId < 1 ||
        typeof e.actorUserId !== "string" || e.actorUserId.length < 1 || e.actorUserId.length > 255 ||
        e.kind !== "voucher.with-entries.v1" ||
        !e.payload || typeof e.payload !== "object" || Array.isArray(e.payload) ||
        !e.payload.voucher || !Array.isArray(e.payload.entries) ||
        typeof e.payloadSha256 !== "string" || !HASH.test(e.payloadSha256) ||
        hashEvidence(e.payload) !== e.payloadSha256) {
      throw new Error("EDGE_SYNC_EVENT_INVALID");
    }
    const sequence = BigInt(e.sequence);
    if (sequence <= last) throw new Error("EDGE_SYNC_ORDER_INVALID");
    last = sequence;
    return e;
  });
}

function checkKey(secret) {
  if (typeof secret !== "string" || secret.length < 48 || /^REPLACE/i.test(secret)) {
    throw new Error("EDGE_SYNC_KEY_INVALID");
  }
}

function computeSignature(raw, timestamp, secret) {
  return createHmac("sha256", secret)
    .update("ERP_FACTORY_VOUCHER_STAGE_V1\n" + timestamp + "\n", "utf8")
    .update(raw)
    .digest("hex");
}

export function makeStageSignature(bodyBytes, timestamp, secret) {
  checkKey(secret);
  if (!Buffer.isBuffer(bodyBytes) || bodyBytes.length === 0 ||
      !/^[1-9][0-9]{9}$/.test(timestamp)) {
    throw new Error("EDGE_SYNC_SIGN_INPUT_INVALID");
  }
  return computeSignature(bodyBytes, timestamp, secret);
}

export function verifyStageSignature(raw, timestamp, signature, secret, nowSeconds = Date.now() / 1000) {
  checkKey(secret);
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 1048576 ||
      typeof timestamp !== "string" || !/^[1-9][0-9]{9}$/.test(timestamp) ||
      Math.abs(Number(timestamp) - nowSeconds) > 300 ||
      typeof signature !== "string" || !HASH.test(signature)) {
    throw new Error("EDGE_SYNC_SIGNATURE_INVALID");
  }
  const received = Buffer.from(signature, "hex");
  const expected = Buffer.from(computeSignature(raw, timestamp, secret), "hex");
  if (!timingSafeEqual(received, expected)) throw new Error("EDGE_SYNC_SIGNATURE_INVALID");
}

export function readCloudSyncStageConfiguration(env = process.env) {
  if (env.FACTORY_SYNC_RECEIVE_ENABLED !== "1") return Object.freeze({ enabled: false });
  if (!validIdentifier(env.FACTORY_SYNC_SITE_ID)) throw new Error("EDGE_SYNC_SITE_INVALID");
  checkKey(env.FACTORY_SYNC_HMAC_KEY);
  if (env.FACTORY_EDGE_MODE === "lan" || env.FACTORY_CLOUD_WRITE_MODE !== "fenced") {
    throw new Error("EDGE_SYNC_REQUIRES_FENCED_CLOUD");
  }
  return Object.freeze({ enabled: true, siteId: env.FACTORY_SYNC_SITE_ID, secret: env.FACTORY_SYNC_HMAC_KEY });
}
