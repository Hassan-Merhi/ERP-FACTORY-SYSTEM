/**
 * Phase 9 / 11 end-to-end drill for the pressing event stream on real
 * PostgreSQL: a LAN database and a separate cloud database under the Phase 7
 * writer fence, a restricted cloud runtime role, and a fault-injecting
 * transport in place of HTTPS. Uses only disposable databases it creates.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DbTransaction } from "../server/db";

const SITE = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const KEY = "drill-only-hmac-key-".repeat(4);
const SHA = "a".repeat(64);

vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => ({ mode: "lan", primary: true, siteId: SITE }),
}));

import { capturePhase9PressingTx, ensurePhase9PressingOutboxSchema } from "../server/edge/phase9PressingOutbox";
import { ensurePhase8ApplySchema } from "../server/edge/phase8ApplyStore.mjs";
import {
  applyPendingStagedEvents,
  applyStagedEventOnce,
  ensurePhase9CloudEventSchema,
  getPhase9AppliedReceipts,
  recordPhase9ConflictDecision,
  stagePhase9Events,
  summarizePhase9CloudStreams,
} from "../server/edge/phase9CloudEventStore.mjs";
import { EDGE_EVENT_STAGE_PATH, validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { EVENT_STAGE_SIGNATURE_DOMAIN, verifyStageSignature } from "../server/edge/edgeSyncStageProtocol.mjs";
import { phase9PressingApplyHandler } from "../server/edge/phase9PressingApply";
import { ensurePhase10SyncControlSchema, recordPhase10SyncControl } from "../server/edge/phase10SyncControl.mjs";
import { summarizeLanEvidence } from "../scripts/edge/factory-handover-preflight.mjs";
import {
  eventEnvelope,
  relayEventStreamOnce,
  verifyAppliedEventReceipts,
} from "../scripts/edge/relay-event-outbox.mjs";

const adminUrl = process.env.PHASE8_TEST_DATABASE_URL;
const handlers = { "pressing.confirmation.v1": phase9PressingApplyHandler };
const approval = {
  siteId: SITE,
  companyId: 5,
  cloudEpoch: "2",
  baselineSha256: SHA,
  operatorAck: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED",
  stream: "pressing",
};
const relayConfig = {
  siteId: SITE,
  key: KEY,
  stageEndpoint: "https://cloud.example.com" + EDGE_EVENT_STAGE_PATH,
  receiptEndpoint: "https://cloud.example.com/api/edge/sync/events/applied-receipts",
};

function dbUrl(name: string, user?: string): string {
  const url = new URL(adminUrl!);
  url.pathname = "/" + name;
  if (user) {
    url.username = user;
    url.password = "phase9-drill-runtime-pass";
  }
  return url.toString();
}

const GUC = `SELECT set_config('phase7_writer.mode','cloud-primary',false),
  set_config('phase7_writer.site_id','cloud',false), set_config('phase7_writer.epoch','2',false)`;

const CLOUD_DDL = `
  CREATE TABLE users (id text PRIMARY KEY, username text NOT NULL, active boolean NOT NULL);
  CREATE TABLE user_company_roles (id serial PRIMARY KEY, user_id text NOT NULL, company_id integer NOT NULL,
    role text NOT NULL, pos_view_only boolean NOT NULL DEFAULT false);
  CREATE TABLE vouchers (id serial PRIMARY KEY, company_id integer, voucher_date date);
  CREATE TABLE factory_user_profiles (company_id integer, user_id text, display_name text);
  CREATE TABLE factory_bales (id integer NOT NULL, company_id integer NOT NULL, reference_number text NOT NULL,
    article_code text, product_name text, weight_kg numeric(15,3) NOT NULL, status text NOT NULL DEFAULT 'STOCKED',
    deleted_at timestamp, PRIMARY KEY (company_id, id));
  CREATE TABLE factory_pressing_machines (id integer NOT NULL, company_id integer NOT NULL, name text NOT NULL,
    PRIMARY KEY (company_id, id));
  CREATE TABLE factory_pressing_assignments (id integer NOT NULL, company_id integer NOT NULL,
    machine_id integer NOT NULL, user_id text NOT NULL, unassigned_at timestamptz, PRIMARY KEY (company_id, id));
  CREATE TABLE factory_pressing_sessions (id serial PRIMARY KEY, company_id integer NOT NULL,
    machine_id integer NOT NULL, assignment_id integer NOT NULL, user_id text NOT NULL, shift_id integer,
    started_at timestamptz NOT NULL, ended_at timestamptz,
    UNIQUE (company_id, id, machine_id, assignment_id, user_id));
  CREATE UNIQUE INDEX sessions_active_user ON factory_pressing_sessions (company_id, user_id) WHERE ended_at IS NULL;
  CREATE TABLE factory_pressing_confirmations (id serial PRIMARY KEY, company_id integer NOT NULL,
    bale_id integer NOT NULL, machine_id integer NOT NULL, assignment_id integer NOT NULL,
    session_id integer NOT NULL, shift_id integer, user_id text NOT NULL, user_name_snapshot text,
    machine_name_snapshot text NOT NULL, reference_number text NOT NULL, article_code text, product_name text,
    weight_kg numeric(15,3) NOT NULL, request_id text NOT NULL, device_captured_at timestamptz,
    confirmed_at timestamptz NOT NULL, production_date date NOT NULL, timezone_name text NOT NULL,
    voided_at timestamptz, voided_by text,
    FOREIGN KEY (company_id, bale_id) REFERENCES factory_bales (company_id, id),
    FOREIGN KEY (company_id, session_id, machine_id, assignment_id, user_id)
      REFERENCES factory_pressing_sessions (company_id, id, machine_id, assignment_id, user_id));
  CREATE UNIQUE INDEX confirmations_request ON factory_pressing_confirmations (company_id, request_id);
  CREATE UNIQUE INDEX confirmations_active_bale ON factory_pressing_confirmations (company_id, bale_id)
    WHERE voided_at IS NULL;
  CREATE TABLE factory_pressing_corrections (id serial PRIMARY KEY, company_id integer NOT NULL,
    confirmation_id integer NOT NULL, replacement_confirmation_id integer, action text NOT NULL,
    reason text NOT NULL, supervisor_user_id text NOT NULL);
  CREATE TABLE audit_log (id serial PRIMARY KEY, user_id text NOT NULL, username text NOT NULL, company_id integer,
    action text NOT NULL, table_name text NOT NULL, record_id integer, record_identifier text, changes jsonb,
    created_at timestamp NOT NULL DEFAULT now(), request_id text, ip text, session_id text, reason text,
    prev_hash text, row_hash text);

  INSERT INTO users VALUES ('worker-1','w1',true), ('worker-2','w2',true), ('worker-3','w3',true);
  INSERT INTO user_company_roles (user_id, company_id, role) VALUES
    ('worker-1',5,'Factory Worker'), ('worker-2',5,'Factory Worker'), ('worker-3',5,'Factory Worker');
  INSERT INTO factory_user_profiles VALUES (5,'worker-1','Worker One');
  INSERT INTO factory_pressing_machines VALUES (4,5,'Press A');
  INSERT INTO factory_pressing_assignments VALUES (31,5,4,'worker-1',NULL), (32,5,4,'worker-2',NULL),
    (33,5,4,'worker-3',NULL);
  INSERT INTO factory_bales (id, company_id, reference_number, article_code, product_name, weight_kg)
    SELECT n, 5, 'BALE-' || n, 'ART-' || n, 'Product ' || n, 40 + n FROM generate_series(100, 111) AS n;
  -- Pre-outage cloud scan of BALE-109 by another request: a guaranteed conflict.
  INSERT INTO factory_pressing_sessions (company_id, machine_id, assignment_id, user_id, started_at, ended_at)
    VALUES (5, 4, 32, 'worker-2', '2026-10-29T08:00:00Z', '2026-10-29T09:00:00Z');
  INSERT INTO factory_pressing_confirmations (company_id, bale_id, machine_id, assignment_id, session_id, user_id,
    machine_name_snapshot, reference_number, weight_kg, request_id, confirmed_at, production_date, timezone_name)
    VALUES (5, 109, 4, 32, 1, 'worker-2', 'Press A', 'BALE-109', 149, '9b1f7c8e-1111-4c3d-8e2f-0a1b2c3d4e5f',
      '2026-10-29T08:30:00Z', '2026-10-29', 'Asia/Beirut');
`;

interface Faults {
  wanDown: boolean;
  dropNextResponse: boolean;
  calls: number;
}

/** In-process stand-in for HTTPS that still enforces the event HMAC. */
function cloudTransport(cloud: Pool, faults: Faults) {
  return async (url: string, init: { body: Buffer; headers: Record<string, string> }) => {
    faults.calls++;
    if (faults.wanDown) throw new TypeError("fetch failed: WAN down");
    verifyStageSignature(
      init.body,
      init.headers["X-Factory-Sync-Timestamp"],
      init.headers["X-Factory-Sync-Signature"],
      KEY,
      Date.now() / 1000,
      EVENT_STAGE_SIGNATURE_DOMAIN
    );
    const body = JSON.parse(init.body.toString("utf8"));
    const result = url.endsWith(EDGE_EVENT_STAGE_PATH)
      ? await stagePhase9Events(cloud, body, SITE)
      : await getPhase9AppliedReceipts(cloud, body, SITE);
    if (faults.dropNextResponse) {
      faults.dropNextResponse = false;
      throw new Error("socket hang up after commit");
    }
    return { ok: true, status: 200, json: async () => result };
  };
}

function evidence(localConfirmationId: number, bale: number, worker: number, requestId: string) {
  return {
    companyId: 5,
    actorUserId: "worker-" + worker,
    localConfirmationId,
    requestId,
    baleId: bale,
    machineId: 4,
    assignmentId: 30 + worker,
    referenceNumber: "BALE-" + bale,
    confirmedAt: "2026-10-30T07:" + String(localConfirmationId % 60).padStart(2, "0") + ":00.000Z",
    deviceCapturedAt: null,
    productionDate: "2026-10-30",
    timezoneName: "Asia/Beirut",
  };
}

function uuidFor(n: number): string {
  return "e53cdbd1-7c4b-4b5c-9a60-" + String(n).padStart(12, "0");
}

async function captureScan(lanUrl: string, local: number, bale: number, worker: number, commit = true) {
  const client = new Client({ connectionString: lanUrl, ssl: false });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO factory_pressing_confirmations (id, company_id) VALUES ($1, 5)", [local]);
    await capturePhase9PressingTx(
      drizzle(client) as unknown as DbTransaction,
      evidence(local, bale, worker, uuidFor(local))
    );
    await client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe.skipIf(!adminUrl)("Phase 9 pressing sync drill (disposable PostgreSQL)", () => {
  const admin = new Client({ connectionString: adminUrl, ssl: false });
  const lanUrl = adminUrl ? dbUrl("phase9_drill_lan") : "";
  let lan: Client;
  let cloudAdmin: Client;
  let cloud: Pool;
  const faults: Faults = { wanDown: false, dropNextResponse: false, calls: 0 };

  beforeAll(async () => {
    await admin.connect();
    for (const name of ["phase9_drill_lan_restored", "phase9_drill_lan", "phase9_drill_cloud"]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin.query("DROP ROLE IF EXISTS phase9_drill_runtime");
    await admin.query("CREATE DATABASE phase9_drill_lan");
    await admin.query("CREATE DATABASE phase9_drill_cloud");
    await admin.query(`CREATE ROLE phase9_drill_runtime LOGIN PASSWORD 'phase9-drill-runtime-pass'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);

    lan = new Client({ connectionString: lanUrl, ssl: false });
    await lan.connect();
    await lan.query(`CREATE TABLE factory_pressing_confirmations (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL,
      UNIQUE (company_id, id))`);
    await ensurePhase9PressingOutboxSchema(lan as never);
    await ensurePhase10SyncControlSchema(lan);

    cloudAdmin = new Client({ connectionString: dbUrl("phase9_drill_cloud"), ssl: false });
    await cloudAdmin.connect();
    await cloudAdmin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await cloudAdmin.query(CLOUD_DDL);
    await ensurePhase8ApplySchema(cloudAdmin);
    await ensurePhase9CloudEventSchema(cloudAdmin);
    await cloudAdmin.query(
      await readFile(new URL("../deploy/lan/phase7-install-writer-fence.sql", import.meta.url), "utf8")
    );
    await cloudAdmin.query(`
      UPDATE phase7_writer.state SET mode='cloud-primary', site_id='cloud', epoch=2, baseline_sha256='${SHA}'
        WHERE singleton;
      GRANT CONNECT ON DATABASE phase9_drill_cloud TO phase9_drill_runtime;
      GRANT USAGE ON SCHEMA public, phase7_writer TO phase9_drill_runtime;
      GRANT SELECT ON phase7_writer.state TO phase9_drill_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO phase9_drill_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO phase9_drill_runtime;
      GRANT INSERT ON factory_pressing_sessions, factory_pressing_confirmations, factory_pressing_corrections,
        audit_log, factory_edge_staged_events, factory_edge_applied_events, factory_edge_event_conflicts
        TO phase9_drill_runtime;
      GRANT INSERT, UPDATE ON factory_edge_event_stage_cursor, factory_edge_event_apply_cursor
        TO phase9_drill_runtime;
      -- SELECT ... FOR UPDATE row locks (same as the live route) need UPDATE.
      GRANT UPDATE ON factory_pressing_machines, factory_pressing_assignments, factory_bales
        TO phase9_drill_runtime;
    `);
    await cloudAdmin.query(GUC);
    cloud = new Pool({ connectionString: dbUrl("phase9_drill_cloud", "phase9_drill_runtime"), ssl: false, max: 4 });
    cloud.on("connect", (client) => void client.query(GUC));
  }, 60_000);

  afterAll(async () => {
    await lan?.end().catch(() => undefined);
    await cloudAdmin?.end().catch(() => undefined);
    await cloud?.end().catch(() => undefined);
    for (const name of ["phase9_drill_lan_restored", "phase9_drill_lan", "phase9_drill_cloud"]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.query("DROP ROLE IF EXISTS phase9_drill_runtime").catch(() => undefined);
    await admin.end();
  });

  it("captures concurrent scans from several laptops gaplessly; a failed transaction leaves no evidence", async () => {
    // Three laptops scan three bales each at the same time.
    await Promise.all(
      [1, 2, 3].map(async (worker) => {
        for (let i = 0; i < 3; i++) {
          const local = worker * 10 + i;
          await captureScan(lanUrl, local, 100 + (worker - 1) * 3 + i, worker);
        }
      })
    );
    await captureScan(lanUrl, 90, 111, 1, false); // browser refresh / failed txn: rolled back
    await captureScan(lanUrl, 40, 109, 1); // conflicts with the pre-outage cloud scan
    await captureScan(lanUrl, 41, 110, 3); // worker-3 is revoked before apply
    await captureScan(lanUrl, 42, 111, 2);
    const { rows } = await lan.query(
      "SELECT array_agg(sequence ORDER BY sequence)::text AS seqs, count(DISTINCT operation_id)::int AS ops FROM factory_edge_pressing_outbox"
    );
    expect(rows[0].seqs).toBe("{1,2,3,4,5,6,7,8,9,10,11,12}");
    expect(rows[0].ops).toBe(12);
    const counter = await lan.query("SELECT last_sequence::text FROM factory_edge_pressing_counter");
    expect(counter.rows[0].last_sequence).toBe("12");
  });

  it("keeps tenants isolated: no cross-company source, no relabelled evidence", async () => {
    await lan.query("INSERT INTO factory_pressing_confirmations (id, company_id) VALUES (500, 6)");
    const client = new Client({ connectionString: lanUrl, ssl: false });
    await client.connect();
    try {
      await client.query("BEGIN");
      await expect(
        capturePhase9PressingTx(drizzle(client) as unknown as DbTransaction, { ...evidence(500, 100, 1, uuidFor(500)) })
      ).rejects.toMatchObject({ cause: { code: "23503" } });
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
    const row = (
      await lan.query(
        "SELECT sequence, operation_id::text AS operation_id, company_id, actor_user_id, " +
          "local_confirmation_id AS local_ref, operation_kind, payload, payload_sha256 FROM factory_edge_pressing_outbox " +
          "WHERE sequence = 1"
      )
    ).rows[0];
    const [event] = eventEnvelope([row], SITE, "pressing").events;
    expect(() => validatePhase9Event("pressing", { ...event, companyId: 6 })).toThrow("EDGE_EVENT_PAYLOAD_INVALID");
    expect(() =>
      validatePhase9Event("pressing", { ...event, payload: { ...event.payload, companyId: 6 }, companyId: 6 })
    ).toThrow("EDGE_EVENT_HASH_MISMATCH");
    expect(() =>
      validatePhase9Event("pressing", { ...event, payload: { ...event.payload, inventoryFinalized: true } })
    ).toThrow("EDGE_EVENT_PAYLOAD_INVALID");
  });

  it("survives pause, WAN loss, a lost staging ACK and duplicate relays without loss or duplication", async () => {
    const transport = cloudTransport(cloud, faults);
    await recordPhase10SyncControl(lan, {
      siteId: SITE,
      action: "pause",
      operatorName: "Shift lead",
      reason: "Cloud incident under review",
    });
    expect(
      await relayEventStreamOnce({ client: lan, config: relayConfig, stream: "pressing", fetcher: transport })
    ).toMatchObject({ paused: true, staged: 0 });
    expect(faults.calls).toBe(0);
    await recordPhase10SyncControl(lan, {
      siteId: SITE,
      action: "resume",
      operatorName: "Shift lead",
      reason: "Cloud incident resolved",
    });

    faults.wanDown = true;
    await expect(
      relayEventStreamOnce({ client: lan, config: relayConfig, stream: "pressing", fetcher: transport })
    ).rejects.toThrow("WAN down");
    faults.wanDown = false;

    faults.dropNextResponse = true; // cloud commits the stage, the LAN never hears back
    await expect(
      relayEventStreamOnce({ client: lan, config: relayConfig, stream: "pressing", fetcher: transport })
    ).rejects.toThrow("socket hang up");
    expect((await lan.query("SELECT count(*)::int AS n FROM factory_edge_event_stage_receipts")).rows[0].n).toBe(0);

    const first = await relayEventStreamOnce({
      client: lan,
      config: relayConfig,
      stream: "pressing",
      fetcher: transport,
    });
    expect(first).toMatchObject({ staged: 12, receipts: 0 });
    const again = await relayEventStreamOnce({
      client: lan,
      config: relayConfig,
      stream: "pressing",
      fetcher: transport,
    });
    expect(again).toMatchObject({ staged: 0, receipts: 0 });
    const staged = await cloudAdmin.query("SELECT count(*)::int AS n FROM factory_edge_staged_events");
    expect(staged.rows[0].n).toBe(12);
    const preflight = await summarizeLanEvidence(lan, SITE);
    expect(preflight.handoverReady).toBe(false);
    expect(preflight.streams.find((s) => s.stream === "pressing")).toMatchObject({
      captured: 12,
      notStaged: 0,
      stagedNotApplied: 12,
      pending: 12,
    });
  });

  it("resumes from a restored LAN backup copy without re-staging or diverging", async () => {
    await lan.end();
    await admin.query("CREATE DATABASE phase9_drill_lan_restored TEMPLATE phase9_drill_lan");
    lan = new Client({ connectionString: dbUrl("phase9_drill_lan_restored"), ssl: false });
    await lan.connect();
    const resumed = await relayEventStreamOnce({
      client: lan,
      config: relayConfig,
      stream: "pressing",
      fetcher: cloudTransport(cloud, faults),
    });
    expect(resumed).toMatchObject({ staged: 0, receipts: 0 });
  });

  it("applies exactly once, survives an interrupted apply and lost ACK, and blocks on conflicts", async () => {
    const client = await cloud.connect();
    try {
      // Power loss during apply: everything in that transaction rolls back.
      await expect(
        applyStagedEventOnce(
          client,
          { ...approval, sequence: "1" },
          {
            "pressing.confirmation.v1": {
              ...phase9PressingApplyHandler,
              verify: async () => {
                throw new Error("power loss");
              },
            },
          }
        )
      ).rejects.toThrow("power loss");
      expect((await cloudAdmin.query("SELECT count(*)::int AS n FROM factory_pressing_confirmations")).rows[0].n).toBe(
        1
      );

      await expect(
        applyStagedEventOnce(client, { ...approval, sequence: "1", cloudEpoch: "3" }, handlers)
      ).rejects.toThrow("PHASE9_CLOUD_WRITER_FENCE_UNVERIFIED");
      await expect(
        applyStagedEventOnce(client, { ...approval, companyId: 6, sequence: "1" }, handlers)
      ).rejects.toThrow("PHASE9_COMPANY_NOT_APPROVED");
      await expect(applyStagedEventOnce(client, { ...approval, sequence: "3" }, handlers)).rejects.toThrow(
        "PHASE9_MISSING_PREDECESSOR"
      );

      await expect(applyPendingStagedEvents(client, approval, handlers)).rejects.toThrow(
        "PHASE9_PRESSING_ALREADY_CONFIRMED"
      );
      const applied = await cloudAdmin.query("SELECT count(*)::int AS n FROM factory_edge_applied_events");
      expect(applied.rows[0].n).toBe(9);
      const fifth = await cloudAdmin.query("SELECT cloud_ref FROM factory_edge_applied_events WHERE sequence = 5");

      // Lost ACK: replay returns the stored receipt and posts nothing new.
      const replay = await applyStagedEventOnce(client, { ...approval, sequence: "5" }, handlers);
      expect(replay).toMatchObject({ replayed: true, outcome: "cloud-applied", cloudRef: fifth.rows[0].cloud_ref });
      await expect(applyPendingStagedEvents(client, approval, handlers)).rejects.toThrow(
        "PHASE9_PRESSING_ALREADY_CONFIRMED"
      );
      expect((await cloudAdmin.query("SELECT count(*)::int AS n FROM factory_edge_event_conflicts")).rows[0].n).toBe(1);
      expect((await cloudAdmin.query("SELECT count(*)::int AS n FROM factory_pressing_confirmations")).rows[0].n).toBe(
        10
      );

      // worker-3 loses access while the LAN event is still pending.
      await cloudAdmin.query("DELETE FROM user_company_roles WHERE user_id = 'worker-3'");
      await expect(
        recordPhase9ConflictDecision(client, {
          siteId: SITE,
          stream: "pressing",
          sequence: "10",
          decidedBy: "Runtime role",
          reason: "Runtime may not decide",
        })
      ).rejects.toMatchObject({ code: "42501" });
      await recordPhase9ConflictDecision(cloudAdmin, {
        siteId: SITE,
        stream: "pressing",
        sequence: "10",
        decidedBy: "Factory DBA",
        reason: "Cloud already holds the pre-outage scan of BALE-109",
      });
      await expect(applyPendingStagedEvents(client, approval, handlers)).rejects.toThrow("PHASE9_ACTOR_ACCESS_REVOKED");
      await recordPhase9ConflictDecision(cloudAdmin, {
        siteId: SITE,
        stream: "pressing",
        sequence: "11",
        decidedBy: "Factory DBA",
        reason: "Worker access was revoked before reconciliation",
      });
      const rest = await applyPendingStagedEvents(client, approval, handlers);
      expect(rest.map((r) => [r.sequence, r.outcome])).toEqual([
        ["11", "rejected-conflict"],
        ["12", "cloud-applied"],
      ]);
    } finally {
      client.release();
    }
    const outcomes = await cloudAdmin.query(
      "SELECT outcome, count(*)::int AS n FROM factory_edge_applied_events GROUP BY outcome ORDER BY outcome"
    );
    expect(outcomes.rows).toEqual([
      { outcome: "cloud-applied", n: 10 },
      { outcome: "rejected-conflict", n: 2 },
    ]);
    expect(await summarizePhase9CloudStreams(cloudAdmin, SITE)).toEqual([
      { stream: "pressing", stagedThrough: "12", appliedThrough: "12", openConflicts: 0 },
    ]);
    await expect(
      cloudAdmin.query("UPDATE factory_edge_applied_events SET outcome = 'cloud-applied'")
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("records only verified cloud receipts on the LAN and reconciles every scan", async () => {
    const transport = cloudTransport(cloud, faults);
    const result = await relayEventStreamOnce({
      client: lan,
      config: relayConfig,
      stream: "pressing",
      fetcher: transport,
    });
    expect(result).toMatchObject({ staged: 0, receipts: 12 });
    expect(
      await relayEventStreamOnce({ client: lan, config: relayConfig, stream: "pressing", fetcher: transport })
    ).toMatchObject({ receipts: 0 });

    const local = await lan.query(
      "SELECT sequence::text AS sequence, operation_id::text AS operation_id, company_id, actor_user_id, " +
        "local_confirmation_id AS local_ref, operation_kind, payload, payload_sha256 FROM factory_edge_pressing_outbox"
    );
    const bySequence = new Map(local.rows.map((row) => [row.sequence, row]));
    const cloudReceipts = await getPhase9AppliedReceipts(
      cloudAdmin,
      { protocol: "factory-lan-event-applied-query/v1", siteId: SITE, stream: "pressing", fromSequence: "1" },
      SITE
    );
    const forged = {
      ...cloudReceipts,
      events: [{ ...cloudReceipts.events[0], payloadSha256: "b".repeat(64) }],
    };
    expect(() => verifyAppliedEventReceipts(forged, { siteId: SITE, stream: "pressing" }, bySequence)).toThrow(
      "EDGE_EVENT_APPLIED_RECEIPT_MISMATCH"
    );

    // Reconciliation: every LAN scan has exactly one verified outcome; every
    // applied outcome is exactly one cloud confirmation; nothing duplicated.
    const reconciliation = await lan.query(`
      SELECT count(*)::int AS outbox,
             count(r.sequence)::int AS receipts,
             count(*) FILTER (WHERE r.outcome = 'cloud-applied')::int AS applied,
             count(*) FILTER (WHERE r.outcome = 'rejected-conflict')::int AS rejected
        FROM factory_edge_pressing_outbox o
        LEFT JOIN factory_edge_event_applied_receipts r
          ON r.site_id = o.site_id AND r.stream = 'pressing' AND r.sequence = o.sequence
                                   AND r.operation_id = o.operation_id`);
    expect(reconciliation.rows[0]).toEqual({ outbox: 12, receipts: 12, applied: 10, rejected: 2 });
    const cloudScans = await cloudAdmin.query(
      `SELECT count(*)::int AS n, count(DISTINCT request_id)::int AS distinct_requests,
              count(DISTINCT bale_id)::int AS bales
         FROM factory_pressing_confirmations WHERE request_id LIKE 'e53cdbd1-%' AND voided_at IS NULL`
    );
    expect(cloudScans.rows[0]).toEqual({ n: 10, distinct_requests: 10, bales: 10 });
    const audits = await cloudAdmin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'factory_pressing_confirmations'"
    );
    expect(audits.rows[0].n).toBe(10);
    const handover = await summarizeLanEvidence(lan, SITE);
    expect(handover).toMatchObject({ handoverReady: true, pendingTotal: 0, relayPaused: false });
    expect(handover.streams.find((s) => s.stream === "pressing")).toMatchObject({
      applied: 10,
      rejectedByOperator: 2,
      pending: 0,
    });
  });
});
