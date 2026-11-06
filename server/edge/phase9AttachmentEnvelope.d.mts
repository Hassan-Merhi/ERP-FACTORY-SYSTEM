export const PHASE9_ATTACHMENT_KIND: "attachment.file.v1";
export const PHASE9_ATTACHMENT_MAX_BYTES: number;
export const PHASE9_ATTACHMENT_FOLDER_MISSING: "PHASE9_ATTACHMENT_FOLDER_MISSING";
export class Phase9AttachmentRefusal extends Error {
  constructor(code: string);
}
export interface Phase9AttachmentEvidence {
  companyId: number;
  localFileId: number;
  folderId: number | null;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  description: string | null;
  sha256: string;
  uploadedOn: string;
}
export interface Phase9AttachmentEnvelope extends Phase9AttachmentEvidence {
  kind: "attachment.file.v1";
}
export function phase9AttachmentEnvelope(evidence: Phase9AttachmentEvidence): Phase9AttachmentEnvelope;
export const PHASE9_ATTACHMENT_UPDATE_KIND: "attachment.file-update.v1";
export const PHASE9_ATTACHMENT_FILE_CHANGED: "PHASE9_ATTACHMENT_FILE_CHANGED";
export type Phase9AttachmentFileRef = { origin: "lan"; localFileId: number } | { origin: "cloud"; fileId: number };
export interface Phase9AttachmentPlacement {
  displayName: string | null;
  folderId: number | null;
}
export interface Phase9AttachmentUpdateEvidence {
  companyId: number;
  localFileId: number;
  actorUserId: string;
  actorUsername: string;
  requestId: string;
  fileRef: Phase9AttachmentFileRef;
  before: Phase9AttachmentPlacement;
  after: Phase9AttachmentPlacement;
}
export function phase9AttachmentUpdateEnvelope(
  evidence: Phase9AttachmentUpdateEvidence
): Phase9AttachmentUpdateEvidence & { kind: "attachment.file-update.v1" };
