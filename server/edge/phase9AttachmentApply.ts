/**
 * Phase 9 cloud apply handler for `attachment.file.v1`.
 *
 * Creates the cloud stored_files row from the LAN record and its verified
 * bytes, on the SAME transaction as the Phase 9 receipt. If the bytes have not
 * arrived yet the apply is refused WITHOUT recording a conflict
 * (PHASE9_ATTACHMENT_FILE_NOT_STAGED): the stream simply waits for the relay
 * to upload the file. A folder that no longer exists in the cloud is held
 * for an Admin/Developer to approve (store at the top level) or reject.
 */
import type { PoolClient } from "pg";
import { Phase9ApplyRefusal, Phase9EventConflict, readPhase9StagedFile } from "./phase9CloudEventStore.mjs";
import { PHASE9_ATTACHMENT_FOLDER_MISSING } from "./phase9AttachmentEnvelope.mjs";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9AttachmentEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: {
    requestId: string;
    companyId: number;
    actorUserId: string;
    actorUsername: string;
    localFileId: number;
    folderId: number | null;
    fileName: string;
    fileType: string;
    fileSize: number;
    description: string | null;
    sha256: string;
    uploadedOn: string;
  };
  payloadSha256: string;
}

export interface Phase9AttachmentApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const READ_ONLY_ROLES = new Set(["View Only", "Create Only", "ERP Tester"]);

async function authorize(client: Queryable, event: Phase9AttachmentEvent): Promise<void> {
  const access = await client.query(
    `SELECT u.active, r.role, r.pos_view_only
       FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $2
      WHERE u.id = $1`,
    [event.actorUserId, event.companyId]
  );
  const row = access.rows[0];
  if (!row || row.active !== true) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ACCESS_REVOKED", { actorUserId: event.actorUserId });
  }
  if (row.pos_view_only === true || READ_ONLY_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

async function apply(
  client: Queryable,
  event: Phase9AttachmentEvent,
  context: { readonly overrideConflicts: readonly string[]; readonly siteId?: string } = { overrideConflicts: [] }
): Promise<Phase9AttachmentApplyResult> {
  const p = event.payload;
  if (!context.siteId) throw new Phase9ApplyRefusal("PHASE9_ATTACHMENT_SITE_MISSING");
  const bytes = await readPhase9StagedFile(client, context.siteId, p.sha256);
  if (!bytes) throw new Phase9ApplyRefusal("PHASE9_ATTACHMENT_FILE_NOT_STAGED");

  let folderId = p.folderId;
  if (folderId !== null) {
    const folder = await client.query("SELECT 1 FROM file_folders WHERE id = $1 AND company_id = $2", [
      folderId,
      event.companyId,
    ]);
    if (!folder.rows.length) {
      if (!context.overrideConflicts.includes(PHASE9_ATTACHMENT_FOLDER_MISSING)) {
        throw new Phase9EventConflict(PHASE9_ATTACHMENT_FOLDER_MISSING, { folderId });
      }
      folderId = null;
    }
  }
  const inserted = await client.query(
    `INSERT INTO stored_files
       (company_id, folder_id, file_name, display_name, file_type, file_size, file_data, description, uploaded_by)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, NULL)
     RETURNING id`,
    [event.companyId, folderId, p.fileName, p.fileType, p.fileSize, bytes.toString("base64"), p.description]
  );
  return {
    outcome: "cloud-applied",
    cloudRef: Number(inserted.rows[0].id),
    businessDate: p.uploadedOn,
  };
}

async function verify(
  client: Queryable,
  event: Phase9AttachmentEvent,
  result: Phase9AttachmentApplyResult
): Promise<boolean> {
  const check = await client.query(
    `SELECT 1 FROM stored_files
      WHERE id = $1 AND company_id = $2 AND file_size = $3
        AND encode(sha256(decode(file_data, 'base64')), 'hex') = $4`,
    [result.cloudRef, event.companyId, event.payload.fileSize, event.payload.sha256]
  );
  return check.rows.length === 1;
}

export const phase9AttachmentApplyHandler = Object.freeze({ authorize, apply, verify });
