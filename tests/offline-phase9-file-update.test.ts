/**
 * Plan batch 4 (owner-approved 2026-11-05): files renamed or moved on the
 * factory LAN server (PATCH /api/files/:id), on the full application schema.
 *
 * LAN: the rename / move and its record commit together. A file uploaded
 * offline is named by its upload record.
 *
 * Cloud: the change applies only while the cloud file still has the name and
 * folder the factory saw. A file changed in the cloud is held (approvable); a
 * missing target folder is reject-only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";

const SITE = randomUUID();
const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { ensurePhase9AttachmentOutboxSchema } from "../server/edge/phase9AttachmentOutbox";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { phase9OverridableConflicts, validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { ensurePhase9CloudEventSchema, Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import {
  PHASE9_ATTACHMENT_FILE_CHANGED,
  phase9AttachmentUpdateEnvelope,
  type Phase9AttachmentPlacement,
} from "../server/edge/phase9AttachmentEnvelope.mjs";
import { phase9AttachmentUpdateApplyHandler } from "../server/edge/phase9AttachmentUpdateApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p9fileup";
const LAN = { mode: "lan", primary: true, siteId: SITE, approvedPlanBatches: [4] };
const CLOUD = { mode: "cloud", primary: false, siteId: null };
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let folderA: number;
let folderB: number;
let seq = 0;

async function storedFile(displayName: string | null, folderId: number | null): Promise<number> {
  const row = await pool.query(
    `INSERT INTO stored_files (company_id, folder_id, file_name, display_name, file_type, file_size, file_data)
     VALUES ($1, $2, 'scan.pdf', $3, 'application/pdf', 3, 'AAAA') RETURNING id`,
    [ctx.companyId, folderId, displayName]
  );
  return Number(row.rows[0].id);
}

function updateEvent(
  fileRef: { origin: "cloud"; fileId: number } | { origin: "lan"; localFileId: number },
  localFileId: number,
  before: Phase9AttachmentPlacement,
  after: Phase9AttachmentPlacement
) {
  seq += 1;
  const payload = phase9AttachmentUpdateEnvelope({
    companyId: ctx.companyId,
    localFileId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId: randomUUID(),
    fileRef,
    before,
    after,
  });
  const event = {
    sequence: String(seq),
    operationId: payload.requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef: localFileId,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("attachments", event);
  return event;
}

async function inRolledBackTx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await run(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
}

async function replay(client: PoolClient, event: unknown, overrideConflicts: string[] = []) {
  await phase9AttachmentUpdateApplyHandler.authorize(client, event as never);
  const result = await phase9AttachmentUpdateApplyHandler.apply(client, event as never, {
    overrideConflicts,
    siteId: SITE,
  });
  expect(await phase9AttachmentUpdateApplyHandler.verify(client, event as never, result)).toBe(true);
  return result;
}

async function conflictCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Phase9EventConflict) return error.message;
    throw error;
  }
  throw new Error("expected a Phase 9 conflict");
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const folders = await pool.query(
    "INSERT INTO file_folders (company_id, name) VALUES ($1, 'Invoices'), ($1, 'Archive') RETURNING id",
    [ctx.companyId]
  );
  folderA = Number(folders.rows[0].id);
  folderB = Number(folders.rows[1].id);
  edge.config = LAN;
  await ensurePhase9AttachmentOutboxSchema(pool);
  edge.config = CLOUD;
  await ensurePhase9CloudEventSchema(pool);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  await pool.query("ALTER TABLE factory_edge_attachment_outbox DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_attachment_outbox WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_attachment_outbox ENABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_attachment_counter WHERE site_id = $1", [SITE]);
  await pool.query("DELETE FROM stored_files WHERE company_id = $1", [ctx.companyId]);
  await pool.query("DELETE FROM file_folders WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("File rename / move on the factory LAN server", () => {
  it("records the change with the name and folder it replaced", async () => {
    const fileId = await storedFile("Old name", folderA);
    edge.config = LAN;
    try {
      const moved = await agent
        .patch(`/api/files/${fileId}`)
        .send({ displayName: "Signed invoice", folderId: folderB });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    } finally {
      edge.config = CLOUD;
    }
    const outbox = await pool.query(
      "SELECT payload FROM factory_edge_attachment_outbox WHERE site_id = $1 AND operation_kind = 'attachment.file-update.v1'",
      [SITE]
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({
      localFileId: fileId,
      fileRef: { origin: "cloud", fileId },
      before: { displayName: "Old name", folderId: folderA },
      after: { displayName: "Signed invoice", folderId: folderB },
    });
  });
});

describe("Cloud replay of a file rename / move", () => {
  it("applies while the file matches, holds it once the cloud changed it, and applies it when approved", async () => {
    const fileId = await storedFile("Scan 1", folderA);
    const ref = { origin: "cloud" as const, fileId };
    await inRolledBackTx(async (client) => {
      const first = updateEvent(
        ref,
        fileId,
        { displayName: "Scan 1", folderId: folderA },
        { displayName: "Scan 1", folderId: folderB }
      );
      expect((await replay(client, first)).outcome).toBe("cloud-applied");
      expect((await replay(client, first)).outcome).toBe("already-present");

      const stale = updateEvent(
        ref,
        fileId,
        { displayName: "Scan 1", folderId: folderA },
        { displayName: "Renamed", folderId: folderA }
      );
      expect(await conflictCode(replay(client, stale))).toBe(PHASE9_ATTACHMENT_FILE_CHANGED);
      expect(phase9OverridableConflicts("attachments", stale.kind)).toContain(PHASE9_ATTACHMENT_FILE_CHANGED);
      expect((await replay(client, stale, [PHASE9_ATTACHMENT_FILE_CHANGED])).outcome).toBe("cloud-applied");
    });
  });

  it("refuses a move into a folder the cloud does not have, and finds a file uploaded offline by its upload's receipt", async () => {
    const fileId = await storedFile(null, null);
    await inRolledBackTx(async (client) => {
      const missing = updateEvent(
        { origin: "cloud", fileId },
        fileId,
        { displayName: null, folderId: null },
        { displayName: null, folderId: 2_000_000_000 }
      );
      expect(await conflictCode(replay(client, missing))).toBe("PHASE9_ATTACHMENT_FOLDER_MISSING");
      expect(phase9OverridableConflicts("attachments", missing.kind)).not.toContain("PHASE9_ATTACHMENT_FOLDER_MISSING");

      await client.query(
        `INSERT INTO factory_edge_applied_events
           (site_id, stream, sequence, operation_id, company_id, actor_user_id, operation_kind,
            local_ref, cloud_ref, payload_sha256, business_date, outcome)
         VALUES ($1, 'attachments', 900001, $2, $3, $4, 'attachment.file.v1', 777001, $5, $6, '2026-11-05', 'cloud-applied')`,
        [SITE, randomUUID(), ctx.companyId, ctx.userId, fileId, "0".repeat(64)]
      );
      const viaLan = updateEvent(
        { origin: "lan", localFileId: 777001 },
        777001,
        { displayName: null, folderId: null },
        { displayName: "Offline scan", folderId: folderA }
      );
      expect(await replay(client, viaLan)).toMatchObject({ outcome: "cloud-applied", cloudRef: fileId });
    });
  });
});
