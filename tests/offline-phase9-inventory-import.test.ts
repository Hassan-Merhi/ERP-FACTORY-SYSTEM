/**
 * Plan batch 3 (owner-approved 2026-11-05): the Excel inventory import on the
 * factory LAN server, on the full application schema. Each row is recorded
 * as a quantity change (an ordinary stock.quick-adjust.v1), never as an
 * overwritten balance. A code that is not a stock item yet is reported, not
 * created. A row that would take the location below zero is refused on the
 * LAN. The cloud replay adds each change once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";

const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { ensurePhase9StockOutboxSchema } from "../server/edge/phase9StockOutbox";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { phase9StockApplyHandler } from "../server/edge/phase9StockApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = "p9invimp";
const SITE = randomUUID();
const LAN = { mode: "lan", primary: true, siteId: SITE, writeMode: "lan-primary" };
const CLOUD = { mode: "cloud", primary: false, siteId: null, writeMode: "cloud" };
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

async function quantity(stockItemId: number): Promise<number> {
  const found = await pool.query(
    "SELECT COALESCE(sum(quantity), 0)::numeric AS q FROM inventory WHERE location_id = $1 AND stock_item_id = $2",
    [ctx.locationId, stockItemId]
  );
  return Number(found.rows[0].q);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(await setupTestApp());
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  edge.config = LAN;
  await ensurePhase9StockOutboxSchema(pool);
  edge.config = CLOUD;
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  await pool.query("ALTER TABLE factory_edge_stock_outbox DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_stock_outbox WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_stock_outbox ENABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_stock_counter WHERE site_id = $1", [SITE]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Excel inventory import on the factory LAN server", () => {
  it("records each row as a quantity change, reports unknown codes and refuses a row below zero", async () => {
    const itemId = ctx.stockItemIds[0];
    const code = (await pool.query("SELECT code FROM stock_items WHERE id = $1", [itemId])).rows[0].code;
    const start = await quantity(itemId);
    const itemsBefore = Number(
      (await pool.query("SELECT count(*)::int AS n FROM stock_items WHERE company_id = $1", [ctx.companyId])).rows[0].n
    );
    edge.config = LAN;
    let recorded: Array<Record<string, unknown>>;
    try {
      const imported = await agent.post(`/api/locations/${ctx.locationId}/import-inventory`).send({
        items: [
          { Item_barcode: code, quantity: "7", rate: "2" },
          { Item_barcode: `${PREFIX}-NOT-AN-ITEM`, quantity: "1", rate: "1" },
          { Item_barcode: code, quantity: String(-(start + 1000)), rate: "2" },
        ],
      });
      expect(imported.status).toBe(200);
      expect(imported.body.results.updated).toHaveLength(1);
      expect(imported.body.results.updated[0]).toMatchObject({ addedQuantity: 7, newQuantity: start + 7 });
      expect(imported.body.results.errors).toHaveLength(2);
      const outbox = await pool.query(
        "SELECT payload FROM factory_edge_stock_outbox WHERE site_id = $1 AND operation_kind = 'stock.quick-adjust.v1'",
        [SITE]
      );
      recorded = outbox.rows.map((row) => row.payload);
    } finally {
      edge.config = CLOUD;
    }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ stockItemId: itemId, locationId: ctx.locationId, direction: "add" });
    expect(await quantity(itemId)).toBe(start + 7);
    // Nothing was created for the unknown code.
    expect(
      Number(
        (await pool.query("SELECT count(*)::int AS n FROM stock_items WHERE company_id = $1", [ctx.companyId])).rows[0]
          .n
      )
    ).toBe(itemsBefore);

    // The cloud replay (same database standing in for the cloud) recognises the change and adds nothing twice.
    await runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), async () => {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        const payload = recorded[0] as { kind: string; requestId: string; localMovementId: number };
        const event = {
          sequence: "1",
          operationId: payload.requestId,
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          kind: payload.kind,
          localRef: payload.localMovementId,
          payload,
          payloadSha256: hashEvidence(payload),
        };
        validatePhase9Event("stock", event);
        await phase9StockApplyHandler.authorize(client, event as never);
        const result = await phase9StockApplyHandler.apply(client, event as never, { overrideConflicts: [] } as never);
        expect(result.outcome).toBe("already-present");
        expect(await quantity(itemId)).toBe(start + 7);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });
  });
});
