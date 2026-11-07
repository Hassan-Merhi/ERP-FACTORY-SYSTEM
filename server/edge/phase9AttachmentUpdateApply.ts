/**
 * Phase 9 cloud apply handler for attachment.file-update.v1 (plan batch 4,
 * owner-approved 2026-11-05): a file renamed or moved on the factory LAN
 * server during an outage.
 *
 * The cloud file is found in one of two ways: through the applied receipt of
 * the offline upload that created it, or by its shared id. The rename / move
 * applies only while the cloud file still has the name and folder the factory
 * saw.
 * - A file the cloud renamed or moved meanwhile is held as
 *   PHASE9_ATTACHMENT_FILE_CHANGED; an Admin/Developer approves (the
 *   factory's change wins) or rejects it.
 * - A target folder missing in the cloud, or a missing file, can only be
 *   rejected.
 * File deletes stay online-only.
 */
import type { PoolClient } from "pg";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import {
  PHASE9_ATTACHMENT_FILE_CHANGED,
  PHASE9_ATTACHMENT_FOLDER_MISSING,
  PHASE9_ATTACHMENT_KIND,
  type Phase9AttachmentPlacement,
  type Phase9AttachmentUpdateEvidence,
} from "./phase9AttachmentEnvelope.mjs";

type Queryable = Pick<PoolClient, "query">;
type Context = { readonly overrideConflicts: readonly string[]; readonly siteId: string };

export interface Phase9AttachmentUpdateEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: { kind: string } & { [K in keyof Phase9AttachmentUpdateEvidence]: Phase9AttachmentUpdateEvidence[K] };
  payloadSha256: string;
}

interface Result {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester"]);

/** The live route needs an authenticated writing member; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9AttachmentUpdateEvent): Promise<void> {
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
  if (row.pos_view_only === true || NOT_PERMITTED_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

async function cloudFileId(client: Queryable, siteId: string, event: Phase9AttachmentUpdateEvent): Promise<number> {
  const ref = event.payload.fileRef;
  if (ref.origin === "cloud") return ref.fileId;
  const uploaded = await client.query(
    `SELECT cloud_ref FROM factory_edge_applied_events
      WHERE site_id = $1::uuid AND stream = 'attachments' AND operation_kind = $2 AND local_ref = $3
        AND company_id = $4 AND outcome <> 'rejected-conflict'`,
    [siteId, PHASE9_ATTACHMENT_KIND, ref.localFileId, event.companyId]
  );
  if (uploaded.rows.length !== 1) throw new Phase9EventConflict("PHASE9_ATTACHMENT_FILE_MISSING", { file: ref });
  return Number(uploaded.rows[0].cloud_ref);
}

async function placementOf(client: Queryable, companyId: number, fileId: number, lock: boolean) {
  const found = await client.query(
    `SELECT display_name AS "displayName", folder_id AS "folderId"
       FROM stored_files WHERE id = $1 AND company_id = $2${lock ? " FOR UPDATE" : ""}`,
    [fileId, companyId]
  );
  const row = found.rows[0];
  return row
    ? ({
        displayName: row.displayName ?? null,
        folderId: row.folderId === null ? null : Number(row.folderId),
      } as Phase9AttachmentPlacement)
    : null;
}

const same = (a: Phase9AttachmentPlacement, b: Phase9AttachmentPlacement) =>
  a.displayName === b.displayName && a.folderId === b.folderId;

async function apply(client: Queryable, event: Phase9AttachmentUpdateEvent, context: Context): Promise<Result> {
  const p = event.payload;
  const businessDate = new Date().toISOString().slice(0, 10);
  const fileId = await cloudFileId(client, context.siteId, event);
  const current = await placementOf(client, event.companyId, fileId, true);
  if (!current) throw new Phase9EventConflict("PHASE9_ATTACHMENT_FILE_MISSING", { file: p.fileRef, fileId });
  if (same(current, p.after)) return { outcome: "already-present", cloudRef: fileId, businessDate };
  if (!same(current, p.before) && !context.overrideConflicts.includes(PHASE9_ATTACHMENT_FILE_CHANGED)) {
    throw new Phase9EventConflict(PHASE9_ATTACHMENT_FILE_CHANGED, { fileId, factorySaw: p.before, cloudHas: current });
  }
  if (p.after.folderId !== null) {
    const folder = await client.query("SELECT 1 FROM file_folders WHERE id = $1 AND company_id = $2", [
      p.after.folderId,
      event.companyId,
    ]);
    if (!folder.rows.length) {
      throw new Phase9EventConflict(PHASE9_ATTACHMENT_FOLDER_MISSING, { folderId: p.after.folderId, fileId });
    }
  }
  await client.query("UPDATE stored_files SET display_name = $3, folder_id = $4 WHERE id = $1 AND company_id = $2", [
    fileId,
    event.companyId,
    p.after.displayName,
    p.after.folderId,
  ]);
  return { outcome: "cloud-applied", cloudRef: fileId, businessDate };
}

async function verify(client: Queryable, event: Phase9AttachmentUpdateEvent, result: Result): Promise<boolean> {
  const now = await placementOf(client, event.companyId, result.cloudRef, false);
  return !!now && same(now, event.payload.after);
}

export const phase9AttachmentUpdateApplyHandler = Object.freeze({ authorize, apply, verify });
