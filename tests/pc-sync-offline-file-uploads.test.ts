/**
 * Full offline mode: files uploaded on a PC while offline.
 *
 * The PC's upload route records the file exactly as the factory LAN server
 * does (name, type, size, SHA-256) in pc_local.outbox, in the upload's own
 * transaction. Its sync agent sends the bytes first, read from the PC's stored
 * copy, to POST /api/offline/pc-sync/files, which keeps them only when they
 * hash to the declared SHA-256; then the record, whose apply stores the file.
 * Proves: bytes that do not match are refused; a record whose bytes never
 * arrived does not create a file; a record with its bytes creates it once;
 * the PC records an upload in the upload's transaction; and the agent delivers
 * a file from the PC's copy end to end, refusing one whose copy changed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type DbTransaction } from "../server/db";
import { capturePhase9AttachmentTx } from "../server/edge/phase9AttachmentOutbox";
import { phase9AttachmentEnvelope } from "../server/edge/phase9AttachmentEnvelope.mjs";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { deliverOutbox, deliveryDeviceId } from "../scripts/pc-sync/local/outbox.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcfile_${Date.now()}`;
const DEVICE = randomUUID();
const KIND = "attachment.file.v1";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let deliveryDevice: string | null = null;

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidence(requestId: string, localFileId: number, bytes: Buffer, fileName = "gate-pass.pdf") {
  return {
    companyId: ctx.companyId,
    localFileId,
    folderId: null,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId,
    fileName,
    fileType: "application/pdf",
    fileSize: bytes.length,
    description: null,
    sha256: sha(bytes),
    uploadedOn: new Date().toISOString().slice(0, 10),
  };
}

function operation(envelope: { localFileId: number }, operationId: string) {
  return {
    deviceId: DEVICE,
    operationId,
    kind: KIND,
    localRef: envelope.localFileId,
    capturedAt: new Date().toISOString(),
    envelope,
  };
}

function sendBytes(bytes: Buffer, declared: string, deviceId = DEVICE) {
  return agent
    .post("/api/offline/pc-sync/files")
    .set("content-type", "application/octet-stream")
    .set("x-pc-sync-device-id", deviceId)
    .set("x-file-sha256", declared)
    .send(bytes);
}

async function filesNamed(name: string): Promise<Array<{ file_data: string }>> {
  const { rows } = await pool.query("SELECT file_data FROM stored_files WHERE company_id = $1 AND file_name = $2", [
    ctx.companyId,
    name,
  ]);
  return rows;
}

beforeAll(async () => {
  process.env.OFFLINE_PC_SYNC_ENABLED = "1";
  process.env.OFFLINE_BROWSER_SYNC_ENABLED = "1";
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  delete process.env.OFFLINE_PC_SYNC_ENABLED;
  delete process.env.OFFLINE_BROWSER_SYNC_ENABLED;
  delete process.env.OFFLINE_PC_LOCAL_MODE;
  const sites = [DEVICE, deliveryDevice ?? DEVICE];
  for (const table of ["factory_edge_applied_events", "factory_edge_staged_files"]) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await pool.query(`DELETE FROM ${table} WHERE site_id = ANY($1::uuid[])`, [sites]);
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  await pool.query("DELETE FROM stored_files WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline file uploads: in the cloud", () => {
  it("refuses bytes that do not match, and a record whose bytes never arrived creates nothing", async () => {
    const bytes = Buffer.from("%PDF-1.4 never sent");
    expect((await sendBytes(bytes, sha(Buffer.from("something else")))).status).toBe(422);
    expect((await sendBytes(bytes, sha(bytes), "not-a-device")).status).toBe(422);

    const operationId = randomUUID();
    const envelope = phase9AttachmentEnvelope(evidence(operationId, 1_000_000_801, bytes, "missing.pdf"));
    const res = await agent.post("/api/offline/pc-sync/operations").send(operation(envelope, operationId));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "PHASE9_ATTACHMENT_FILE_NOT_STAGED" });
    expect(await filesNamed("missing.pdf")).toEqual([]);
  });

  it("refuses a record whose size does not describe its bytes", async () => {
    const bytes = Buffer.from("%PDF-1.4 sized wrongly");
    expect((await sendBytes(bytes, sha(bytes))).status).toBe(200);
    const operationId = randomUUID();
    const envelope = phase9AttachmentEnvelope({
      ...evidence(operationId, 1_000_000_803, bytes, "wrong-size.pdf"),
      fileSize: 1,
    });
    const res = await agent.post("/api/offline/pc-sync/operations").send(operation(envelope, operationId));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "PHASE9_ATTACHMENT_FILE_SIZE_MISMATCH" });
    expect(await filesNamed("wrong-size.pdf")).toEqual([]);
  });

  it("stores a file once its bytes arrived, and only once", async () => {
    const bytes = Buffer.from("%PDF-1.4 gate pass for container 7");
    const staged = await sendBytes(bytes, sha(bytes));
    expect(staged.status, JSON.stringify(staged.body)).toBe(200);
    const operationId = randomUUID();
    const envelope = phase9AttachmentEnvelope(evidence(operationId, 1_000_000_802, bytes));
    const sent = operation(envelope, operationId);
    expect((await agent.post("/api/offline/browser-sync/operations").send(sent)).status).toBe(422);

    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.body).toMatchObject({ replayed: true });
    const stored = await filesNamed("gate-pass.pdf");
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0].file_data, "base64").equals(bytes)).toBe(true);
  });
});

describe("PC offline file uploads: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_files_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_files_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_files_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    delete process.env.OFFLINE_PC_LOCAL_MODE;
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_files_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records an upload in the upload's own transaction", async () => {
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      const pcDb = drizzle(local);
      const bytes = Buffer.from("local upload");
      const kept = randomUUID();
      await pcDb.transaction((tx) =>
        capturePhase9AttachmentTx(tx as unknown as DbTransaction, evidence(kept, 1_000_000_811, bytes))
      );
      const row = await local.query("SELECT kind, status, local_ref FROM pc_local.outbox WHERE operation_id = $1", [
        kept,
      ]);
      expect(row.rows[0]).toEqual({ kind: KIND, status: "pending", local_ref: 1_000_000_811 });

      const rolledBack = randomUUID();
      await expect(
        pcDb.transaction(async (tx) => {
          await capturePhase9AttachmentTx(tx as unknown as DbTransaction, evidence(rolledBack, 1_000_000_812, bytes));
          throw new Error("the upload failed");
        })
      ).rejects.toThrow("the upload failed");
      expect((await local.query("SELECT 1 FROM pc_local.outbox WHERE operation_id = $1", [rolledBack])).rowCount).toBe(
        0
      );
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
  });

  it("delivers a file from the PC's copy, bytes first, and refuses one whose copy changed", async () => {
    const state = await local.query("UPDATE pc_local.state SET cloud_user_id = $1 RETURNING device_id", [ctx.userId]);
    deliveryDevice = deliveryDeviceId(state.rows[0].device_id, ctx.userId, ctx.companyId);
    await local.query("DELETE FROM pc_local.outbox");
    const cloud = {
      get: async (path: string, query?: Record<string, unknown>) => {
        const res = await agent.get(path).query(query ?? {});
        return { status: res.status, body: res.body };
      },
      post: async (path: string, payload?: unknown) => {
        const res = await agent.post(path).send((payload ?? {}) as object);
        return { status: res.status, body: res.body };
      },
      postBytes: async (path: string, bytes: Buffer, headers: Record<string, string>) => {
        let req = agent.post(path).set("content-type", "application/octet-stream");
        for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
        const res = await req.send(bytes);
        return { status: res.status, body: res.body };
      },
    };
    const good = Buffer.from("%PDF-1.4 delivery note uploaded on the PC");
    const changed = Buffer.from("%PDF-1.4 this copy was altered");
    await local.query("BEGIN");
    await local.query("SET LOCAL session_replication_role = replica");
    for (const [id, name, bytes] of [
      [1_000_000_821, "delivery-note.pdf", good],
      [1_000_000_822, "altered.pdf", changed],
    ] as const) {
      await local.query(
        `INSERT INTO stored_files (id, company_id, file_name, file_type, file_size, file_data)
         VALUES ($1, $2, $3, 'application/pdf', $4, $5)`,
        [id, ctx.companyId, name, bytes.length, bytes.toString("base64")]
      );
    }
    await local.query("COMMIT");
    const queue = async (localFileId: number, declaredBytes: Buffer, name: string) => {
      const operationId = randomUUID();
      const envelope = phase9AttachmentEnvelope(evidence(operationId, localFileId, declaredBytes, name));
      await local.query(
        `INSERT INTO pc_local.outbox (operation_id, kind, input, envelope, local_ref, user_id, company_id, status)
         VALUES ($1::uuid, $2, '{}'::jsonb, $3::jsonb, $4, $5, $6, 'pending')`,
        [operationId, KIND, JSON.stringify(envelope), localFileId, ctx.userId, ctx.companyId]
      );
    };
    await queue(1_000_000_821, good, "delivery-note.pdf");
    // Recorded with other bytes than the PC now holds.
    await queue(1_000_000_822, Buffer.from("%PDF-1.4 the original"), "altered.pdf");

    expect(await deliverOutbox(local, cloud)).toMatchObject({ applied: 1, refused: 1, conflicts: 0 });
    const stored = await filesNamed("delivery-note.pdf");
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0].file_data, "base64").equals(good)).toBe(true);
    expect(await filesNamed("altered.pdf")).toEqual([]);
    const refused = await local.query("SELECT status, code FROM pc_local.outbox WHERE local_ref = 1000000822");
    expect(refused.rows[0]).toEqual({ status: "refused", code: "PC_SYNC_FILE_CHANGED" });
  });
});
