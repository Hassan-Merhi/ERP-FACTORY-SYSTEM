/**
 * Phase 9 drill for the stock movement stream on real PostgreSQL: a LAN
 * database and a separate cloud database under the Phase 7 writer fence, a
 * restricted cloud runtime role and an HMAC-checking in-process transport.
 *
 * It proves the owner policy end to end: LAN movements replay as deltas in
 * order; one that would take cloud stock below zero blocks the stream until
 * an Admin/Developer approves (apply anyway) or rejects it; only conflicts the
 * stream declares overridable can be approved; every movement ends with
 * exactly one verified outcome on the LAN. The cloud business effect here is
 * a minimal stand-in table; the real quick-adjust replay is covered by
 * tests/offline-phase9-stock-apply.test.ts on the full schema.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DbTransaction } from "../server/db";

const SITE = "5b0c9d2e-1f3a-4b5c-8d6e-7f8091a2b3c4";
const KEY = "stock-drill-hmac-key-".repeat(4);
const SHA = "c".repeat(64);

vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => ({ mode: "lan", primary: true, siteId: SITE }),
}));

import { capturePhase9StockAdjustTx, ensurePhase9StockOutboxSchema } from "../server/edge/phase9StockOutbox";
import { ensurePhase9PressingOutboxSchema } from "../server/edge/phase9PressingOutbox";
import { ensurePhase8ApplySchema } from "../server/edge/phase8ApplyStore.mjs";
import {
  applyPendingStagedEvents,
  ensurePhase9CloudEventSchema,
  getPhase9AppliedReceipts,
  Phase9EventConflict,
  recordPhase9ConflictDecision,
  stagePhase9Events,
  summarizePhase9CloudStreams,
} from "../server/edge/phase9CloudEventStore.mjs";
import { EDGE_EVENT_STAGE_PATH } from "../server/edge/phase9EventProtocol.mjs";
import { EVENT_STAGE_SIGNATURE_DOMAIN, verifyStageSignature } from "../server/edge/edgeSyncStageProtocol.mjs";
import { PHASE9_STOCK_ADJUST_KIND, PHASE9_STOCK_NEGATIVE_CONFLICT } from "../server/edge/phase9StockEnvelope.mjs";
import { assertPhase9Reviewer } from "../server/edge/phase9OperatorApply";
import { summarizeLanEvidence } from "../scripts/edge/factory-handover-preflight.mjs";
import { relayEventStreamOnce } from "../scripts/edge/relay-event-outbox.mjs";

const adminUrl = process.env.PHASE8_TEST_DATABASE_URL;
const approval = {
  siteId: SITE,
  companyId: 5,
  cloudEpoch: "2",
  baselineSha256: SHA,
  operatorAck: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED",
  stream: "stock",
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
    url.password = "stock-drill-runtime-pass";
  }
  return url.toString();
}

const GUC = `SELECT set_config('phase7_writer.mode','cloud-primary',false),
  set_config('phase7_writer.site_id','cloud',false), set_config('phase7_writer.epoch','2',false)`;

const CLOUD_DDL = `
  CREATE TABLE users (id text PRIMARY KEY, username text NOT NULL UNIQUE, active boolean NOT NULL);
  CREATE TABLE user_company_roles (id serial PRIMARY KEY, user_id text NOT NULL, company_id integer NOT NULL,
    role text NOT NULL, pos_view_only boolean NOT NULL DEFAULT false);
  CREATE TABLE vouchers (id serial PRIMARY KEY, company_id integer, voucher_date date);
  CREATE TABLE drill_balance (company_id integer NOT NULL, stock_item_id integer NOT NULL,
    quantity numeric(18,6) NOT NULL, PRIMARY KEY (company_id, stock_item_id));
  CREATE TABLE drill_movement (id serial PRIMARY KEY, company_id integer NOT NULL, operation_id uuid NOT NULL UNIQUE,
    stock_item_id integer NOT NULL, delta numeric(18,6) NOT NULL);
  INSERT INTO users VALUES ('worker-1','storekeeper',true), ('admin-1','factory.admin',true), ('dev-1','developer',true);
  INSERT INTO user_company_roles (user_id, company_id, role) VALUES
    ('worker-1',5,'Manager'), ('admin-1',5,'Admin'), ('dev-1',5,'Developer');
  INSERT INTO drill_balance VALUES (5, 1, 25), (5, 2, 8);
`;

/** Stand-in for the real quick-adjust replay: same delta + below-zero rule. */
const stockHandler = {
  async authorize() {},
  async apply(client: PoolClient, event: any, context: { overrideConflicts: readonly string[] }) {
    const p = event.payload;
    const prior = await client.query("SELECT id FROM drill_movement WHERE operation_id = $1", [event.operationId]);
    if (prior.rows.length) {
      return { outcome: "already-present", cloudRef: prior.rows[0].id, businessDate: p.businessDate };
    }
    const balance = await client.query(
      "SELECT quantity::numeric AS q FROM drill_balance WHERE company_id = $1 AND stock_item_id = $2 FOR UPDATE",
      [event.companyId, p.stockItemId]
    );
    if (!balance.rows.length) throw new Phase9EventConflict("PHASE9_STOCK_ITEM_MISSING", { id: p.stockItemId });
    const delta = (p.direction === "add" ? 1 : -1) * Number(p.quantity);
    if (Number(balance.rows[0].q) + delta < 0 && !context.overrideConflicts.includes(PHASE9_STOCK_NEGATIVE_CONFLICT)) {
      throw new Phase9EventConflict(PHASE9_STOCK_NEGATIVE_CONFLICT, { available: balance.rows[0].q });
    }
    await client.query(
      "UPDATE drill_balance SET quantity = quantity + $3 WHERE company_id = $1 AND stock_item_id = $2",
      [event.companyId, p.stockItemId, delta]
    );
    const inserted = await client.query(
      "INSERT INTO drill_movement (company_id, operation_id, stock_item_id, delta) VALUES ($1,$2,$3,$4) RETURNING id",
      [event.companyId, event.operationId, p.stockItemId, delta]
    );
    return { outcome: "cloud-applied", cloudRef: inserted.rows[0].id, businessDate: p.businessDate };
  },
  async verify(client: PoolClient, event: any, result: { cloudRef: number }) {
    const check = await client.query("SELECT 1 FROM drill_movement WHERE id = $1 AND operation_id = $2", [
      result.cloudRef,
      event.operationId,
    ]);
    return check.rows.length === 1;
  },
};
const handlers = { [PHASE9_STOCK_ADJUST_KIND]: stockHandler };

function cloudTransport(cloud: Pool) {
  return async (url: string, init: { body: Buffer; headers: Record<string, string> }) => {
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
    return { ok: true, status: 200, json: async () => result };
  };
}

const uuidFor = (n: number) => "a1b2c3d4-e5f6-4a7b-8c9d-" + String(n).padStart(12, "0");

async function captureMovement(
  lanUrl: string,
  local: number,
  stockItemId: number,
  direction: "add" | "subtract",
  quantity: string,
  commit = true
) {
  const client = new Client({ connectionString: lanUrl, ssl: false });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO canonical_stock_movements (id) VALUES ($1)", [local]);
    await capturePhase9StockAdjustTx(drizzle(client) as unknown as DbTransaction, {
      companyId: 5,
      localMovementId: local,
      stockItemId,
      locationId: 3,
      actorUserId: "worker-1",
      actorUsername: "storekeeper",
      requestId: uuidFor(local),
      direction,
      quantity,
      occurredAt: "2026-10-31T09:00:00.000Z",
      businessDate: "2026-10-31",
    });
    await client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe.skipIf(!adminUrl)("Phase 9 stock movement sync drill (disposable PostgreSQL)", () => {
  const admin = new Client({ connectionString: adminUrl, ssl: false });
  const lanUrl = adminUrl ? dbUrl("phase9_stock_drill_lan") : "";
  let lan: Client;
  let cloudAdmin: Client;
  let cloud: Pool;

  beforeAll(async () => {
    await admin.connect();
    for (const name of ["phase9_stock_drill_lan", "phase9_stock_drill_cloud"]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin.query("DROP ROLE IF EXISTS phase9_stock_drill_runtime");
    await admin.query("CREATE DATABASE phase9_stock_drill_lan");
    await admin.query("CREATE DATABASE phase9_stock_drill_cloud");
    await admin.query(`CREATE ROLE phase9_stock_drill_runtime LOGIN PASSWORD 'stock-drill-runtime-pass'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);

    lan = new Client({ connectionString: lanUrl, ssl: false });
    await lan.connect();
    await lan.query("CREATE TABLE canonical_stock_movements (id BIGINT PRIMARY KEY)");
    // The pressing install owns the shared LAN receipt logs.
    await lan.query(`CREATE TABLE factory_pressing_confirmations (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL,
      UNIQUE (company_id, id))`);
    await ensurePhase9PressingOutboxSchema(lan as never);
    await ensurePhase9StockOutboxSchema(lan as never);

    cloudAdmin = new Client({ connectionString: dbUrl("phase9_stock_drill_cloud"), ssl: false });
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
      GRANT CONNECT ON DATABASE phase9_stock_drill_cloud TO phase9_stock_drill_runtime;
      GRANT USAGE ON SCHEMA public, phase7_writer TO phase9_stock_drill_runtime;
      GRANT SELECT ON phase7_writer.state TO phase9_stock_drill_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO phase9_stock_drill_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO phase9_stock_drill_runtime;
      GRANT INSERT ON drill_movement, factory_edge_staged_events, factory_edge_applied_events,
        factory_edge_event_conflicts TO phase9_stock_drill_runtime;
      GRANT INSERT, UPDATE ON factory_edge_event_stage_cursor, factory_edge_event_apply_cursor
        TO phase9_stock_drill_runtime;
      GRANT UPDATE ON drill_balance TO phase9_stock_drill_runtime;
    `);
    await cloudAdmin.query(GUC);
    cloud = new Pool({
      connectionString: dbUrl("phase9_stock_drill_cloud", "phase9_stock_drill_runtime"),
      ssl: false,
      max: 4,
    });
    cloud.on("connect", (client) => void client.query(GUC));
  }, 60_000);

  afterAll(async () => {
    await lan?.end().catch(() => undefined);
    await cloudAdmin?.end().catch(() => undefined);
    await cloud?.end().catch(() => undefined);
    for (const name of ["phase9_stock_drill_lan", "phase9_stock_drill_cloud"]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.query("DROP ROLE IF EXISTS phase9_stock_drill_runtime").catch(() => undefined);
    await admin.end();
  });

  it("captures LAN movements gaplessly in their own stream; a rolled-back adjustment leaves no evidence", async () => {
    await captureMovement(lanUrl, 101, 1, "add", "10.000"); // seq 1: 25 -> 35
    await captureMovement(lanUrl, 102, 1, "subtract", "50.000"); // seq 2: would be -15 -> held
    await captureMovement(lanUrl, 199, 1, "subtract", "1.000", false); // failed transaction
    await captureMovement(lanUrl, 103, 2, "subtract", "3.000"); // seq 3: 8 -> 5
    await captureMovement(lanUrl, 104, 9, "add", "1.000"); // seq 4: item 9 missing in cloud
    const { rows } = await lan.query(
      "SELECT array_agg(sequence ORDER BY sequence)::text AS seqs FROM factory_edge_stock_outbox"
    );
    expect(rows[0].seqs).toBe("{1,2,3,4}");
    await expect(lan.query("UPDATE factory_edge_stock_outbox SET company_id = 6")).rejects.toMatchObject({
      code: "23514",
    });
    expect(
      await relayEventStreamOnce({ client: lan, config: relayConfig, stream: "stock", fetcher: cloudTransport(cloud) })
    ).toMatchObject({ staged: 4, receipts: 0 });
  });

  it("holds a below-zero movement, blocking the stream, until an Admin/Developer approves it", async () => {
    const client = await cloud.connect();
    try {
      await expect(applyPendingStagedEvents(client, approval, handlers)).rejects.toThrow(
        PHASE9_STOCK_NEGATIVE_CONFLICT
      );
      // seq 1 applied; seq 2 held; seq 3 must NOT jump the queue.
      const balances = await cloudAdmin.query("SELECT stock_item_id, quantity::text FROM drill_balance ORDER BY 1");
      expect(balances.rows).toEqual([
        { stock_item_id: 1, quantity: "35.000000" },
        { stock_item_id: 2, quantity: "8.000000" },
      ]);
      expect(await summarizePhase9CloudStreams(cloudAdmin, SITE)).toEqual([
        { stream: "stock", stagedThrough: "4", appliedThrough: "1", openConflicts: 1 },
      ]);

      // Reviewers are active Admin/Developer users of the company only.
      await expect(assertPhase9Reviewer(cloudAdmin as never, 5, "storekeeper")).rejects.toThrow(
        "PHASE9_REVIEWER_NOT_AUTHORIZED"
      );
      await expect(assertPhase9Reviewer(cloudAdmin as never, 6, "factory.admin")).rejects.toThrow(
        "PHASE9_REVIEWER_NOT_AUTHORIZED"
      );
      const reviewer = await assertPhase9Reviewer(cloudAdmin as never, 5, "factory.admin");
      expect(await assertPhase9Reviewer(cloudAdmin as never, 5, "developer")).toBe("developer");

      await recordPhase9ConflictDecision(cloudAdmin, {
        siteId: SITE,
        stream: "stock",
        sequence: "2",
        decidedBy: reviewer,
        reason: "Physical count confirmed the LAN issue; cloud receipt is late",
        decision: "approve-override",
      });
      // Approved movement applies; seq 3 follows; seq 4 (missing item) blocks next.
      await expect(applyPendingStagedEvents(client, approval, handlers)).rejects.toThrow("PHASE9_STOCK_ITEM_MISSING");
      const after = await cloudAdmin.query("SELECT stock_item_id, quantity::text FROM drill_balance ORDER BY 1");
      expect(after.rows).toEqual([
        { stock_item_id: 1, quantity: "-15.000000" },
        { stock_item_id: 2, quantity: "5.000000" },
      ]);
    } finally {
      client.release();
    }
  });

  it("allows only rejection for conflicts the stream does not declare overridable", async () => {
    const decision = {
      siteId: SITE,
      stream: "stock",
      sequence: "4",
      decidedBy: "factory.admin",
      reason: "Item 9 was merged into item 1 in the cloud before the outage",
    };
    await expect(
      recordPhase9ConflictDecision(cloudAdmin, { ...decision, decision: "approve-override" })
    ).rejects.toThrow("PHASE9_CONFLICT_NOT_OVERRIDABLE");
    await recordPhase9ConflictDecision(cloudAdmin, { ...decision, decision: "reject-event" });
    const client = await cloud.connect();
    try {
      const receipts = await applyPendingStagedEvents(client, approval, handlers);
      expect(receipts.map((r) => [r.sequence, r.outcome])).toEqual([["4", "rejected-conflict"]]);
      // Re-running is a no-op: nothing is applied twice.
      expect(await applyPendingStagedEvents(client, approval, handlers)).toEqual([]);
    } finally {
      client.release();
    }
    const movements = await cloudAdmin.query("SELECT count(*)::int AS n FROM drill_movement");
    expect(movements.rows[0].n).toBe(3);
  });

  it("records one verified outcome per LAN movement and reports the stream ready for handover", async () => {
    expect(
      await relayEventStreamOnce({ client: lan, config: relayConfig, stream: "stock", fetcher: cloudTransport(cloud) })
    ).toMatchObject({ staged: 0, receipts: 4 });
    const outcomes = await lan.query(
      `SELECT sequence::int, outcome FROM factory_edge_event_applied_receipts WHERE stream = 'stock' ORDER BY sequence`
    );
    expect(outcomes.rows).toEqual([
      { sequence: 1, outcome: "cloud-applied" },
      { sequence: 2, outcome: "cloud-applied" },
      { sequence: 3, outcome: "cloud-applied" },
      { sequence: 4, outcome: "rejected-conflict" },
    ]);
    const report = await summarizeLanEvidence(lan, SITE);
    expect(report.streams.find((s: { stream: string }) => s.stream === "stock")).toMatchObject({
      captured: 4,
      applied: 3,
      rejectedByOperator: 1,
      pending: 0,
    });
  });
});
