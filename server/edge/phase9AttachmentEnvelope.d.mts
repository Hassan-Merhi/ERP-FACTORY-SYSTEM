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
}
export interface Phase9AttachmentEnvelope extends Phase9AttachmentEvidence {
  kind: "attachment.file.v1";
}
export function phase9AttachmentEnvelope(evidence: Phase9AttachmentEvidence): Phase9AttachmentEnvelope;
