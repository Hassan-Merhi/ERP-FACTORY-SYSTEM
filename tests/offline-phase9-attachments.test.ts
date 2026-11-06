/**
 * Phase 9 offline attachments (attachment.file.v1) on the full schema: the
 * LAN record commits with the upload, the relay stages the record and then
 * uploads the bytes, which the cloud accepts only when their SHA-256 matches
 * a staged record; the cloud replay creates the file only once its verified
 * bytes have arrived, and holds a missing folder for review.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// Cloud evidence is immutable: each run stages under its own site id.
const SITE = randomUUID();
const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool, type DbTransaction } from "../server/db";
import { capturePhase9AttachmentTx, ensurePhase9AttachmentOutboxSchema } from "../server/edge/phase9AttachmentOutbox";
import { ensurePhase9PressingOutboxSchema } from "../server/edge/phase9PressingOutbox";
import {
  ensurePhase9CloudEventSchema,
  getPhase9AppliedReceipts,
  Phase9ApplyRefusal,
  Phase9EventConflict,
  Phase9StageConflict,
  stagePhase9AttachmentFile,
  stagePhase9Events,
} from "../server/edge/phase9CloudEventStore.mjs";
import { EDGE_EVENT_STAGE_PATH, EDGE_FILE_STAGE_PATH } from "../server/edge/phase9EventProtocol.mjs";
import { phase9AttachmentApplyHandler, type Phase9AttachmentEvent } from "../server/edge/phase9AttachmentApply";
import { relayAttachmentFilesOnce, relayEventStreamOnce } from "../scripts/edge/relay-event-outbox.mjs";
import { capturePhase9AttachmentUpdateTx, phase9AttachmentFileRefTx } from "../server/edge/phase9AttachmentOutbox";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p9attach";
let ctx: TestContext;
const relayConfig = {
  siteId: SITE,
  key: "attachment-test-hmac-key-".repeat(3),
  stageEndpoint: "https://cloud.example.com" + EDGE_EVENT_STAGE_PATH,
  receiptEndpoint: "https://cloud.example.com/api/edge/sync/events/applied-receipts",
  fileEndpoint: "https://cloud.example.com" + EDGE_FILE_STAGE_PATH,
};

/** In-process cloud: the same store functions the signed receiver calls. */
const fetcher = async (url: string, init: { body: Buffer; headers: Record<string, string> }) => {
  const result = url.endsWith(EDGE_FILE_STAGE_PATH)
    ? await stagePhase9AttachmentFile(pool, SITE, init.headers["X-Factory-File-Sha256"], init.body)
    : url.endsWith(EDGE_EVENT_STAGE_PATH)
      ? await stagePhase9Events(pool, JSON.parse(init.body.toString("utf8")), SITE)
      : await getPhase9AppliedReceipts(pool, JSON.parse(init.body.toString("utf8")), SITE);
  return { ok: true, status: 200, json: async () => result };
};

async function uploadOnLan(bytes: Buffer, folderId: number | null): Promise<number> {
  edge.config = { mode: "lan", primary: true, siteId: SITE };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query(
      `INSERT INTO stored_files (company_id, folder_id, file_name, file_type, file_size, file_data)
       VALUES ($1, $2, 'delivery-note.pdf', 'application/pdf', $3, $4) RETURNING id`,
      [ctx.companyId, folderId, bytes.length, bytes.toString("base64")]
    );
    const localFileId = Number(row.rows[0].id);
    await capturePhase9AttachmentTx(drizzle(client) as unknown as DbTransaction, {
      companyId: ctx.companyId,
      localFileId,
      folderId,
      actorUserId: ctx.userId,
      actorUsername: `${PREFIX}_testuser`,
      requestId: randomUUID(),
      fileName: "delivery-note.pdf",
      fileType: "application/pdf",
      fileSize: bytes.length,
      description: null,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploadedOn: "2026-11-02",
    });
    await client.query("COMMIT");
    return localFileId;
  } finally {
    client.release();
    edge.config = { mode: "cloud", primary: false, siteId: null };
  }
}

async function stagedEvent(localFileId: number): Promise<Phase9AttachmentEvent> {
  const row = (
    await pool.query(
      `SELECT sequence::text AS sequence, operation_id::text AS operation_id, company_id, actor_user_id,
              local_ref, operation_kind, payload, payload_sha256
         FROM factory_edge_staged_events
        WHERE site_id = $1::uuid AND stream = 'attachments' AND local_ref = $2
          AND operation_kind = 'attachment.file.v1'`,
      [SITE, localFileId]
    )
  ).rows[0];
  return {
    sequence: row.sequence,
    operationId: row.operation_id,
    companyId: row.company_id,
    actorUserId: row.actor_user_id,
    kind: row.operation_kind,
    localRef: row.local_ref,
    payload: row.payload,
    payloadSha256: String(row.payload_sha256).trim(),
  };
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

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (
      error instanceof Phase9EventConflict ||
      error instanceof Phase9ApplyRefusal ||
      error instanceof Phase9StageConflict
    ) {
      return `${error.name}:${error.message}`;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  edge.config = { mode: "lan", primary: true, siteId: SITE };
  await ensurePhase9PressingOutboxSchema(pool);
  await ensurePhase9AttachmentOutboxSchema(pool);
  edge.config = { mode: "cloud", primary: false, siteId: null };
  await ensurePhase9CloudEventSchema(pool);
}, 120_000);

afterAll(async () => {
  // LAN evidence is immutable by design; lift the triggers only to clean up.
  for (const table of ["factory_edge_attachment_outbox", "factory_edge_attachment_file_receipts"]) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_no_mutation`);
    await pool.query(`DELETE FROM ${table} WHERE site_id = $1`, [SITE]);
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_no_mutation`);
  }
  await pool.query("DELETE FROM factory_edge_event_stage_receipts WHERE site_id = $1", [SITE]).catch(() => undefined);
  await pool.query("DELETE FROM factory_edge_attachment_counter WHERE site_id = $1", [SITE]);
  await pool.query("DELETE FROM stored_files WHERE company_id = $1", [ctx.companyId]);
  await pool.query("DELETE FROM file_folders WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 9 offline attachments (POST /api/files/upload)", () => {
  it("syncs the record first, then only bytes whose SHA-256 matches, and replays the file once they arrive", async () => {
    const bytes = Buffer.from("%PDF-1.4 offline delivery note " + randomUUID());
    const localFileId = await uploadOnLan(bytes, null);

    expect(
      await relayEventStreamOnce({ client: pool as never, config: relayConfig, stream: "attachments", fetcher })
    ).toMatchObject({
      staged: 1,
    });
    const event = await stagedEvent(localFileId);

    // Before the bytes arrive the record waits; no conflict is recorded.
    await inRolledBackTx(async (client) => {
      expect(
        await code(phase9AttachmentApplyHandler.apply(client, event, { overrideConflicts: [], siteId: SITE }))
      ).toBe("Phase9ApplyRefusal:PHASE9_ATTACHMENT_FILE_NOT_STAGED");
    });

    // The cloud refuses bytes that are not the referenced file.
    const sha = event.payload.sha256;
    expect(await code(stagePhase9AttachmentFile(pool, SITE, sha, Buffer.from("tampered")))).toBe(
      "Phase9StageConflict:PHASE9_FILE_HASH_MISMATCH"
    );
    const stranger = Buffer.from("not referenced by any staged record");
    expect(
      await code(stagePhase9AttachmentFile(pool, SITE, createHash("sha256").update(stranger).digest("hex"), stranger))
    ).toBe("Phase9StageConflict:PHASE9_FILE_NOT_REFERENCED");

    expect(await relayAttachmentFilesOnce({ client: pool as never, config: relayConfig, fetcher })).toEqual({
      paused: false,
      uploaded: 1,
    });
    // Acknowledged files are not sent again.
    expect(await relayAttachmentFilesOnce({ client: pool as never, config: relayConfig, fetcher })).toEqual({
      paused: false,
      uploaded: 0,
    });

    await inRolledBackTx(async (client) => {
      await phase9AttachmentApplyHandler.authorize(client, event);
      const result = await phase9AttachmentApplyHandler.apply(client, event, { overrideConflicts: [], siteId: SITE });
      expect(result).toMatchObject({ outcome: "cloud-applied", businessDate: "2026-11-02" });
      expect(await phase9AttachmentApplyHandler.verify(client, event, result)).toBe(true);
      const stored = await client.query("SELECT file_data, file_name FROM stored_files WHERE id = $1", [
        result.cloudRef,
      ]);
      expect(Buffer.from(stored.rows[0].file_data, "base64").equals(bytes)).toBe(true);
      expect(stored.rows[0].file_name).toBe("delivery-note.pdf");
    });
  });

  it("stages a rename of an offline upload after it and still uploads the file's bytes (plan batch 4)", async () => {
    const bytes = Buffer.from("%PDF-1.4 renamed offline " + randomUUID());
    const localFileId = await uploadOnLan(bytes, null);
    edge.config = { mode: "lan", primary: true, siteId: SITE };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = drizzle(client) as unknown as DbTransaction;
      await capturePhase9AttachmentUpdateTx(tx, {
        companyId: ctx.companyId,
        localFileId,
        actorUserId: ctx.userId,
        actorUsername: `${PREFIX}_testuser`,
        requestId: randomUUID(),
        fileRef: await phase9AttachmentFileRefTx(tx, localFileId),
        before: { displayName: null, folderId: null },
        after: { displayName: "Renamed offline", folderId: null },
      });
      await client.query("COMMIT");
    } finally {
      client.release();
      edge.config = { mode: "cloud", primary: false, siteId: null };
    }
    const kinds = await pool.query(
      "SELECT operation_kind, payload->'fileRef' AS ref FROM factory_edge_attachment_outbox WHERE site_id = $1 AND local_file_id = $2 ORDER BY sequence",
      [SITE, localFileId]
    );
    expect(kinds.rows).toEqual([
      { operation_kind: "attachment.file.v1", ref: null },
      { operation_kind: "attachment.file-update.v1", ref: { origin: "lan", localFileId } },
    ]);
    expect(
      await relayEventStreamOnce({ client: pool as never, config: relayConfig, stream: "attachments", fetcher })
    ).toMatchObject({ staged: 2 });
    expect(await relayAttachmentFilesOnce({ client: pool as never, config: relayConfig, fetcher })).toEqual({
      paused: false,
      uploaded: 1,
    });
  });

  it("holds a file whose folder no longer exists in the cloud until it is approved", async () => {
    const folder = await pool.query("INSERT INTO file_folders (company_id, name) VALUES ($1, 'Gate') RETURNING id", [
      ctx.companyId,
    ]);
    const folderId = Number(folder.rows[0].id);
    const bytes = Buffer.from("weighbridge ticket " + randomUUID());
    const localFileId = await uploadOnLan(bytes, folderId);
    await relayEventStreamOnce({ client: pool as never, config: relayConfig, stream: "attachments", fetcher });
    await relayAttachmentFilesOnce({ client: pool as never, config: relayConfig, fetcher });
    const event = await stagedEvent(localFileId);
    await inRolledBackTx(async (client) => {
      await client.query("DELETE FROM file_folders WHERE id = $1", [folderId]);
      expect(
        await code(phase9AttachmentApplyHandler.apply(client, event, { overrideConflicts: [], siteId: SITE }))
      ).toBe("Phase9EventConflict:PHASE9_ATTACHMENT_FOLDER_MISSING");
      const result = await phase9AttachmentApplyHandler.apply(client, event, {
        overrideConflicts: ["PHASE9_ATTACHMENT_FOLDER_MISSING"],
        siteId: SITE,
      });
      const stored = await client.query("SELECT folder_id FROM stored_files WHERE id = $1", [result.cloudRef]);
      expect(stored.rows[0].folder_id).toBeNull();
    });
  });
});
