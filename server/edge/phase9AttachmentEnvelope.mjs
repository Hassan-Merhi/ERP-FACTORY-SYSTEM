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
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  "uploadedOn",
]);

export class Phase9AttachmentRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "Phase9AttachmentRefusal";
  }
}

const ref = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_REF;
function validDay(date) {
  if (typeof date !== "string" || !DAY.test(date)) return false;
  const value = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

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
    !HASH.test(evidence.sha256) ||
    !validDay(evidence.uploadedOn)
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
    uploadedOn: evidence.uploadedOn,
  };
}

// ---- Plan batch 4 (owner-approved 2026-11-05): offline file rename / move ----
//
// Names the file by the LAN record that uploaded it ({origin: "lan"}) or by
// its shared pre-outage id ({origin: "cloud"}), with its name and folder as
// the factory saw them and as the factory left them.

export const PHASE9_ATTACHMENT_UPDATE_KIND = "attachment.file-update.v1";
/** Overridable: the cloud file was renamed or moved after the factory saw it; approve = the factory's change wins. */
export const PHASE9_ATTACHMENT_FILE_CHANGED = "PHASE9_ATTACHMENT_FILE_CHANGED";

function placement(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "displayName,folderId" ||
    !(value.displayName === null || (typeof value.displayName === "string" && value.displayName.length <= 500)) ||
    !(
      value.folderId === null ||
      (Number.isSafeInteger(value.folderId) && value.folderId > 0 && value.folderId <= MAX_REF)
    )
  ) {
    return null;
  }
  return { displayName: value.displayName, folderId: value.folderId };
}

function fileRef(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";
  const ref = (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_REF;
  if (keys === "localFileId,origin" && value.origin === "lan" && ref(value.localFileId)) {
    return { origin: "lan", localFileId: value.localFileId };
  }
  if (keys === "fileId,origin" && value.origin === "cloud" && ref(value.fileId)) {
    return { origin: "cloud", fileId: value.fileId };
  }
  return null;
}

export function phase9AttachmentUpdateEnvelope(evidence) {
  const fields = [
    "actorUserId",
    "actorUsername",
    "after",
    "before",
    "companyId",
    "fileRef",
    "localFileId",
    "requestId",
  ];
  const ok =
    evidence &&
    typeof evidence === "object" &&
    !Array.isArray(evidence) &&
    Object.keys(evidence).sort().join(",") === fields.join(",") &&
    Number.isSafeInteger(evidence.companyId) &&
    evidence.companyId > 0 &&
    Number.isSafeInteger(evidence.localFileId) &&
    evidence.localFileId > 0 &&
    evidence.localFileId <= MAX_REF &&
    typeof evidence.actorUserId === "string" &&
    evidence.actorUserId.length >= 1 &&
    evidence.actorUserId.length <= 255 &&
    typeof evidence.actorUsername === "string" &&
    evidence.actorUsername.length >= 1 &&
    evidence.actorUsername.length <= 255 &&
    typeof evidence.requestId === "string" &&
    UUID.test(evidence.requestId);
  const target = ok ? fileRef(evidence.fileRef) : null;
  const before = ok ? placement(evidence.before) : null;
  const after = ok ? placement(evidence.after) : null;
  if (!target || !before || !after) throw new Phase9AttachmentRefusal("PHASE9_ATTACHMENT_UPDATE_EVIDENCE_INVALID");
  return {
    kind: PHASE9_ATTACHMENT_UPDATE_KIND,
    requestId: evidence.requestId,
    companyId: evidence.companyId,
    actorUserId: evidence.actorUserId,
    actorUsername: evidence.actorUsername,
    localFileId: evidence.localFileId,
    fileRef: target,
    before,
    after,
  };
}
