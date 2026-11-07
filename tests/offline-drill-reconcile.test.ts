/**
 * Staging drill reconciliation (scripts/edge/drill-reconcile.mjs), owner-approved
 * drill plan of 2026-11-06.
 *
 * The comparisons are checked on hand-made rows; one database case runs the
 * real queries against the full schema, with the same database standing in for
 * both the factory server and the cloud.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { ensurePhase9StockOutboxSchema } from "../server/edge/phase9StockOutbox";
import { ensurePhase9StockItemMapSchema } from "../server/edge/phase9StockItemMap.mjs";
import { ensurePhase9CloudEventSchema } from "../server/edge/phase9CloudEventStore.mjs";
import {
  assertStagingUrl,
  compareBalances,
  compareEvents,
  compareFiles,
  compareInventory,
  compareItemCreates,
  compareItemDeletes,
  exitCodeFor,
  parseArgs,
  runDrillReconciliation,
} from "../scripts/edge/drill-reconcile.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const SITE = randomUUID();

describe("drill reconciliation: arguments and safety", () => {
  it("accepts only batches 2-4, a company id and a site UUID", () => {
    expect(parseArgs(["--batch", "3", "--company", "7", "--site", SITE])).toMatchObject({ batch: 3, companyId: 7 });
    expect(() => parseArgs(["--batch", "5", "--company", "7", "--site", SITE])).toThrow(/batch/);
    expect(() => parseArgs(["--batch", "2", "--company", "x", "--site", SITE])).toThrow(/company/);
    expect(() => parseArgs(["--batch", "2", "--company", "7", "--site", "factory"])).toThrow(/site/);
  });

  it("refuses a database URL that is not a staging or drill database", () => {
    expect(() => assertStagingUrl("X", "postgres://db.prod/erp", {})).toThrow(/staging/);
    expect(() => assertStagingUrl("X", "postgres://staging-db/erp", {})).not.toThrow();
    expect(() => assertStagingUrl("X", "postgres://db/erp", { DRILL_RECONCILE_ALLOW_ANY_URL: "1" })).not.toThrow();
  });
});

describe("drill reconciliation: comparisons", () => {
  it("needs exactly one cloud outcome per LAN record", () => {
    const lan = [
      { stream: "stock", sequence: "1", operation_id: "a", operation_kind: "stock.item-create.v1" },
      { stream: "stock", sequence: "2", operation_id: "b", operation_kind: "stock.item-delete.v1" },
    ];
    const result = compareEvents(lan, [{ stream: "stock", operation_id: "a", outcome: "cloud-applied" }]);
    expect(result.outcomes).toEqual({ stock: { "cloud-applied": 1 } });
    expect(result.failures).toEqual([expect.objectContaining({ sequence: "2", detail: "no cloud outcome" })]);
  });

  it("checks items created offline against the map and the typed code, and applied deletes", () => {
    const creates = [
      { local_ref: 1_000_000_001, cloud_ref: 50, outcome: "cloud-applied", code: "DRL-1" },
      { local_ref: 1_000_000_002, cloud_ref: 51, outcome: "cloud-applied", code: "DRL-2" },
      { local_ref: 1_000_000_003, cloud_ref: null, outcome: "rejected-conflict", code: "DRL-3" },
    ];
    const map = [
      { lan_item_id: 1_000_000_001, cloud_item_id: 50 },
      { lan_item_id: 1_000_000_002, cloud_item_id: 51 },
    ];
    const items = [
      { id: 50, code: "DRL-1", deleted_at: null },
      { id: 51, code: "OTHER", deleted_at: null },
    ];
    expect(compareItemCreates(creates, map, items)).toEqual([expect.objectContaining({ cloudItemId: 51 })]);
    expect(compareItemDeletes([{ cloud_ref: 50, outcome: "cloud-applied" }], items)).toHaveLength(1);
    expect(compareItemDeletes([{ cloud_ref: 50, outcome: "rejected-conflict" }], items)).toHaveLength(0);
  });

  it("compares stock through the item map and lists a rejected offline item", () => {
    const map = [{ lan_item_id: 1_000_000_001, cloud_item_id: 50 }];
    const lan = [
      { location_id: 1, stock_item_id: 1_000_000_001, quantity: "5" },
      { location_id: 1, stock_item_id: 1_000_000_009, quantity: "2" },
      { location_id: 1, stock_item_id: 7, quantity: "10" },
    ];
    const cloud = [
      { location_id: 1, stock_item_id: 50, quantity: "5.0000" },
      { location_id: 1, stock_item_id: 7, quantity: "12" },
    ];
    expect(compareInventory(lan, cloud, map)).toEqual([
      expect.objectContaining({ lanItemId: 1_000_000_009 }),
      expect.objectContaining({ stockItemId: 7, lan: 10, cloud: 12 }),
    ]);
  });

  it("compares ledger balances to the cent", () => {
    expect(
      compareBalances(
        [
          { ledger_account_id: 1, balance: "100.00" },
          { ledger_account_id: 2, balance: "-40.004" },
        ],
        [
          { ledger_account_id: 1, balance: "100.001" },
          { ledger_account_id: 2, balance: "-42" },
        ]
      )
    ).toEqual([expect.objectContaining({ ledgerAccountId: 2 })]);
  });

  it("fails a file whose records all applied but differs, and only lists one with a rejected record", () => {
    const events = [
      { local_ref: 1, cloud_ref: 1, outcome: "cloud-applied" },
      { local_ref: 2, cloud_ref: 2, outcome: "cloud-applied" },
      { local_ref: 2, cloud_ref: 2, outcome: "rejected-conflict" },
    ];
    const lan = [
      { id: 1, display_name: "A", folder_id: 3, file_size: 4, sha256: "x" },
      { id: 2, display_name: "B", folder_id: 3, file_size: 4, sha256: "y" },
    ];
    const cloud = [
      { id: 1, display_name: "A2", folder_id: 3, file_size: 4, sha256: "x" },
      { id: 2, display_name: "B", folder_id: 9, file_size: 4, sha256: "y" },
    ];
    const result = compareFiles(events, lan, cloud);
    expect(result.failures).toEqual([expect.objectContaining({ lanFileId: 1, detail: "display_name" })]);
    expect(result.differences).toEqual([expect.objectContaining({ lanFileId: 2, detail: "folder_id" })]);
  });

  it("maps a report to its exit code", () => {
    expect(exitCodeFor({ failures: [], differences: [] })).toBe(0);
    expect(exitCodeFor({ failures: [{}], differences: [] })).toBe(1);
    expect(exitCodeFor({ failures: [], differences: [{}] })).toBe(2);
  });
});

describe("drill reconciliation: real queries on the full schema", () => {
  let ctx: TestContext;
  let cloudItemId: number;
  const createOperation = randomUUID();

  beforeAll(async () => {
    ctx = await seedTestData("drillrec");
    edge.config = { mode: "lan", primary: true, siteId: SITE };
    await ensurePhase9StockOutboxSchema(pool);
    edge.config = { mode: "cloud", primary: false, siteId: null };
    await ensurePhase9CloudEventSchema(pool);
    await ensurePhase9StockItemMapSchema(pool);
    const item = await pool.query(
      "INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, 'DRL-1', 'Drill item', 'PCS') RETURNING id",
      [ctx.companyId]
    );
    cloudItemId = Number(item.rows[0].id);
    await pool.query(
      `INSERT INTO factory_edge_stock_outbox
         (site_id, sequence, operation_id, company_id, actor_user_id, local_movement_id, operation_kind, payload, payload_sha256)
       VALUES ($1, 1, $2, $3, $4, 1000000001, 'stock.item-create.v1', $5, $6)`,
      [SITE, createOperation, ctx.companyId, ctx.userId, JSON.stringify({ item: { code: "DRL-1" } }), "0".repeat(64)]
    );
    await pool.query(
      "INSERT INTO factory_edge_stock_item_map (site_id, lan_item_id, cloud_item_id, operation_id) VALUES ($1, 1000000001, $2, $3)",
      [SITE, cloudItemId, createOperation]
    );
    await pool.query(
      `INSERT INTO factory_edge_applied_events
         (site_id, stream, sequence, operation_id, company_id, actor_user_id, operation_kind,
          local_ref, cloud_ref, payload_sha256, business_date, outcome)
       VALUES ($1, 'stock', 1, $2, $3, $4, 'stock.item-create.v1', 1000000001, $5, $6, '2026-11-06', 'cloud-applied')`,
      [SITE, createOperation, ctx.companyId, ctx.userId, cloudItemId, "0".repeat(64)]
    );
  }, 120_000);

  afterAll(async () => {
    for (const table of ["factory_edge_stock_outbox", "factory_edge_applied_events", "factory_edge_stock_item_map"]) {
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await pool.query(`DELETE FROM ${table} WHERE site_id = $1`, [SITE]);
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    if (cloudItemId)
      await pool.query("DELETE FROM stock_items WHERE id = $1 AND company_id = $2", [cloudItemId, ctx.companyId]);
    await cleanupTestData("drillrec");
    closeTestServer();
  }, 60_000);

  async function run(batch: number) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      return await runDrillReconciliation({
        lan: client,
        cloud: client,
        batch,
        companyId: ctx.companyId,
        siteId: SITE,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("is clear when every record has one outcome and both sides agree", async () => {
    for (const batch of [2, 3, 4]) {
      const report = await run(batch);
      expect(report, JSON.stringify(report)).toMatchObject({ status: "clear", lanRecords: 1 });
      expect(report.outcomes).toEqual({ stock: { "cloud-applied": 1 } });
    }
  });

  it("fails when a factory record never reached the cloud", async () => {
    await pool.query(
      `INSERT INTO factory_edge_stock_outbox
         (site_id, sequence, operation_id, company_id, actor_user_id, local_movement_id, operation_kind, payload, payload_sha256)
       VALUES ($1, 2, $2, $3, $4, $5, 'stock.item-delete.v1', '{}', $6)`,
      [SITE, randomUUID(), ctx.companyId, ctx.userId, cloudItemId, "0".repeat(64)]
    );
    const report = await run(2);
    expect(report.status).toBe("failed");
    expect(report.failures).toEqual([expect.objectContaining({ check: "event-outcome", sequence: "2" })]);
    expect(exitCodeFor(report)).toBe(1);
  });
});
