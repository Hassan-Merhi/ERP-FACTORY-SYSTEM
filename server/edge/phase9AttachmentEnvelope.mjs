/**
 * Phase 9: typed, immutable LAN evidence for a file uploaded to the factory
 * LAN server (POST /api/files/upload) during an outage.
 *
 * Owner policy (2026-11-01): files up to 10 MB are kept on the factory
 * server; the record syncs first as this event (metadata + SHA-256), then the
 * bytes are uploaded separately and the cloud accepts them only if their
 * SHA-256 matches. The record is applied in the cloud only once its verified
 * file has arrived.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_REF = 2147483647;

export const PHASE9_ATTACHMENT_KIND = "attachment.file.v1";
export const PHASE9_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PHASE9_ATTACHMENT_FOLDER_MISSING = "PHASE9_ATTACHMENT_FOLDER_MISSING";

const INPUT_FIELDS = Object.freeze([
  "actorUserId",
  "actorUsername",
  "companyId",
  "description",
  "fileName",
  "fileSize",
  "fileType",
  "folderId",
  "localFileId",
  "requestId",
  "sha256",
]);

export class Phase9AttachmentRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9AttachmentRefusal";
  }
}

const ref = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;
const text = (value, max) => typeof value === "string" && value.length >= 1 && value.length <= max;

export function phase9AttachmentEnvelope(evidence) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== INPUT_FIELDS.join(",") ||
    !ref(evidence.companyId) ||
    !ref(evidence.localFileId) ||
    (evidence.folderId !== null && !ref(evidence.folderId)) ||
    !text(evidence.actorUserId, 255) ||
    !text(evidence.actorUsername, 255) ||
    typeof evidence.requestId !== "string" ||
    !UUID.test(evidence.requestId) ||
    !text(evidence.fileName, 255) ||
    !text(evidence.fileType, 255) ||
    !Number.isSafeInteger(evidence.fileSize) ||
    evidence.fileSize < 1 ||
    evidence.fileSize > PHASE9_ATTACHMENT_MAX_BYTES ||
    (evidence.description !== null && !text(evidence.description, 1000)) ||
    typeof evidence.sha256 !== "string" ||
    !HASH.test(evidence.sha256)
  ) {
    throw new Phase9AttachmentRefusal("PHASE9_ATTACHMENT_EVIDENCE_INVALID");
  }
  return {
    kind: PHASE9_ATTACHMENT_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localFileId: evidence.localFileId,
    folderId: evidence.folderId,
    fileName: evidence.fileName,
    fileType: evidence.fileType,
    fileSize: evidence.fileSize,
    description: evidence.description,
    sha256: evidence.sha256,
  };
}
