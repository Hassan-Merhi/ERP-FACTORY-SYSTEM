/**
 * Full offline mode: container receiving (offloads) and file renames / moves
 * made on a PC while offline.
 *
 * The PC records exactly what the factory LAN server records and writes the
 * finished envelope to pc_local.outbox in the change's own transaction. The
 * cloud accepts these envelopes only from the PC route, for the signed-in
 * person and company, and applies them through the existing exactly-once
 * handlers. Proves: a rename of a cloud file applies once; a receiving
 * envelope reaches its handler (and a container the cloud does not have is
 * held, never invented); envelopes on the browser route are refused; the PC
 * writes both in the change's transaction; the guard opens these routes only
 * in entry mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import express from "express";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type DbTransaction } from "../server/db";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import { capturePhase9ReceivingTx } from "../server/edge/phase9ReceivingOutbox";
import { capturePhase9AttachmentUpdateTx, phase9AttachmentFileRefTx } from "../server/edge/phase9AttachmentOutbox";
import { phase9AttachmentUpdateEnvelope } from "../server/edge/phase9AttachmentEnvelope.mjs";
import { phase9ReceivingEnvelope, phase9ReceivingLineDigest } from "../server/edge/phase9ReceivingEnvelope.mjs";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcrecv_${Date.now()}`;
const DEVICE = randomUUID();
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

function body(kind: string, envelope: unknown, ref: number, operationId: string) {
  return { deviceId: DEVICE, operationId, kind, localRef: ref, capturedAt: new Date().toISOString(), envelope };
}

function actor(requestId: string) {
  return { companyId: ctx.companyId, actorUserId: ctx.userId, actorUsername: `${PREFIX}_testuser`, requestId };
}

function offload() {
  return {
    duties: "0",
    dutiesAccountId: null,
    officeCharges: "0",
    officeChargesAccountId: null,
    officeChargesCashAccountId: null,
    transferCharges: "0",
    transportFees: "0",
    transportAccountId: null,
    additionalCharges: [],
    inventoryCostCorrections: [],
    agentChargeLines: [],
  };
}

function receivingEvidence(requestId: string, containerId: number) {
  return {
    ...actor(requestId),
    localOffloadId: 1_000_000_601,
    containerId,
    locationId: ctx.locationId,
    offloadDate: new Date().toISOString().slice(0, 10),
    lineDigest: phase9ReceivingLineDigest([]),
    mode: "create" as const,
    offload: offload(),
  };
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
  await pool.query("ALTER TABLE factory_edge_applied_events DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_applied_events WHERE site_id = $1::uuid", [DEVICE]);
  await pool.query("ALTER TABLE factory_edge_applied_events ENABLE TRIGGER USER");
  await pool.query("DELETE FROM stored_files WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline receiving and file changes: in the cloud", () => {
  it("applies a rename of a cloud file once, and refuses it on the browser route", async () => {
    const file = await pool.query(
      `INSERT INTO stored_files (company_id, folder_id, file_name, file_type, file_size, file_data)
       VALUES ($1, NULL, 'gate.pdf', 'application/pdf', 3, 'YWJj') RETURNING id`,
      [ctx.companyId]
    );
    const fileId = Number(file.rows[0].id);
    const operationId = randomUUID();
    const envelope = phase9AttachmentUpdateEnvelope({
      ...actor(operationId),
      localFileId: fileId,
      fileRef: { origin: "cloud", fileId },
      before: { displayName: null, folderId: null },
      after: { displayName: "Gate pass", folderId: null },
    });
    const sent = body("attachment.file-update.v1", envelope, fileId, operationId);
    expect((await agent.post("/api/offline/browser-sync/operations").send(sent)).status).toBe(422);

    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.body).toMatchObject({ replayed: true });
    const row = await pool.query("SELECT display_name FROM stored_files WHERE id = $1", [fileId]);
    expect(row.rows[0].display_name).toBe("Gate pass");
  });

  it("sends a receiving envelope to its handler, which holds a container the cloud does not have", async () => {
    const operationId = randomUUID();
    const envelope = phase9ReceivingEnvelope(receivingEvidence(operationId, 2_000_000_000));
    const sent = body("receiving.container-offload.v1", envelope, envelope.localOffloadId, operationId);
    expect((await agent.post("/api/offline/browser-sync/operations").send(sent)).status).toBe(422);
    const res = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "PHASE9_RECEIVING_CONTAINER_MISSING" });
  });
});

describe("PC offline receiving: the live route's roles hold in the cloud", () => {
  it("holds an offload edit from someone who is not an Admin, whatever the PC sent", async () => {
    await pool.query("UPDATE user_company_roles SET role = 'Manager' WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      const operationId = randomUUID();
      const envelope = phase9ReceivingEnvelope({ ...receivingEvidence(operationId, 2_000_000_001), mode: "edit" });
      const res = await agent
        .post("/api/offline/pc-sync/operations")
        .send(body("receiving.container-offload.v1", envelope, envelope.localOffloadId, operationId));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "PHASE9_ACTOR_ROLE_NOT_PERMITTED", overridable: false });
    } finally {
      await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        ctx.companyId,
      ]);
    }
  });
});

describe("PC offline receiving and file changes: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_recv_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_recv_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_recv_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    delete process.env.OFFLINE_PC_LOCAL_MODE;
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_recv_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records an offload and a file rename as finished envelopes in the change's own transaction", async () => {
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      const pcDb = drizzle(local);
      const offloadId = randomUUID();
      const renameId = randomUUID();
      await pcDb.transaction(async (tx) => {
        const t = tx as unknown as DbTransaction;
        expect(await phase9AttachmentFileRefTx(t, 1_000_000_050)).toEqual({
          origin: "lan",
          localFileId: 1_000_000_050,
        });
        expect(await phase9AttachmentFileRefTx(t, 50)).toEqual({ origin: "cloud", fileId: 50 });
        await capturePhase9ReceivingTx(t, receivingEvidence(offloadId, 44));
        await capturePhase9AttachmentUpdateTx(t, {
          ...actor(renameId),
          localFileId: 50,
          fileRef: { origin: "cloud", fileId: 50 },
          before: { displayName: null, folderId: null },
          after: { displayName: "Renamed", folderId: null },
        });
      });
      const rows = await local.query(
        "SELECT kind, status, local_ref FROM pc_local.outbox WHERE operation_id = ANY($1::uuid[]) ORDER BY kind",
        [[offloadId, renameId]]
      );
      expect(rows.rows).toEqual([
        { kind: "attachment.file-update.v1", status: "pending", local_ref: 50 },
        { kind: "receiving.container-offload.v1", status: "pending", local_ref: 1_000_000_601 },
      ]);

      const rolledBack = randomUUID();
      await expect(
        pcDb.transaction(async (tx) => {
          await capturePhase9ReceivingTx(tx as unknown as DbTransaction, receivingEvidence(rolledBack, 44));
          throw new Error("the offload failed");
        })
      ).rejects.toThrow("the offload failed");
      expect((await local.query("SELECT 1 FROM pc_local.outbox WHERE operation_id = $1", [rolledBack])).rowCount).toBe(
        0
      );
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
  });

  it("opens the offload and file rename routes only in entry mode", async () => {
    await local.query("UPDATE pc_local.state SET copy_complete = true, last_sync_at = now()");
    const connect = async () => ({
      query: (text: string, values?: unknown[]) => local.query(text, values as unknown[]),
      release: () => undefined,
    });
    const build = (mode: string) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { session: Record<string, unknown> }).session = { userId: "u1", currentCompanyId: 1 };
        next();
      });
      app.use(makePcLocalReadOnlyGuard({ OFFLINE_PC_LOCAL_MODE: mode }, connect));
      const ok = (_req: express.Request, res: express.Response) => res.json({ ok: true });
      app.post("/api/containers/:id/offload", ok);
      app.patch("/api/containers/:id/offload", ok);
      app.patch("/api/files/:id", ok);
      app.delete("/api/files/:id", ok);
      app.post("/api/files/upload", ok);
      return app;
    };
    const entry = build("entry");
    expect((await request(entry).post("/api/containers/9/offload").send({})).status).toBe(200);
    expect((await request(entry).patch("/api/containers/9/offload").send({})).status).toBe(200);
    expect((await request(entry).patch("/api/files/9").send({})).status).toBe(200);
    expect((await request(entry).post("/api/files/upload").send({})).status).toBe(200);
    // Not replayable from a PC.
    expect((await request(entry).delete("/api/files/9")).status).toBe(423);
    expect((await request(build("read-only")).patch("/api/files/9").send({})).status).toBe(423);
  });
});
