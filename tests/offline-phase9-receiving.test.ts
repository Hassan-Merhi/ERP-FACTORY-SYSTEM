/**
 * Phase 9 offline receiving (receiving.container-offload.v1) on the full
 * schema: the factory LAN capture of a quantity-only first offload against
 * existing purchase orders, and its cloud replay through the same offload
 * lifecycle on the receipt's transaction, with changed order quantities held.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { executeContainerOffloadLifecycle } from "../server/services/containers/offload-lifecycle/execute";
import {
  offlineReceivingCapture,
  offlineReceivingInputs,
} from "../server/routes/containers/containerOffloadOfflinePolicy";
import { ensurePhase9ReceivingOutboxSchema } from "../server/edge/phase9ReceivingOutbox";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import { phase9ReceivingLineDigest } from "../server/edge/phase9ReceivingEnvelope.mjs";
import { phase9ReceivingApplyHandler, type Phase9ReceivingEvent } from "../server/edge/phase9ReceivingApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p9recv";
const SITE = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const LAN = { mode: "lan", primary: true, siteId: SITE, writeMode: "lan-primary" };
const CLOUD = { mode: "cloud", primary: false, siteId: null, writeMode: "cloud" };
let ctx: TestContext;
let supplierId: number;

async function container(quantity = "10.000"): Promise<number> {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const c = await pool.query(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OTW', CURRENT_DATE) RETURNING id`,
    [ctx.companyId, `RC-${suffix}`.slice(0, 30), supplierId]
  );
  const po = await pool.query(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `RPO-${suffix}`.slice(0, 30), c.rows[0].id, supplierId]
  );
  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'receiving line', $3, '7.00', $4)`,
    [po.rows[0].id, ctx.stockItemIds[0], quantity, (Number(quantity) * 7).toFixed(2)]
  );
  return Number(c.rows[0].id);
}

const NO_CHARGES = {
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

function receivingEvent(
  containerId: number,
  lineDigest: string,
  mode: "create" | "edit" = "create",
  offload: Record<string, unknown> = NO_CHARGES
): Phase9ReceivingEvent {
  const requestId = randomUUID();
  const payload = {
    kind: "receiving.container-offload.v1",
    requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    localOffloadId: 4242,
    containerId,
    locationId: ctx.locationId,
    offloadDate: "2026-11-02",
    lineDigest,
    mode,
    offload,
  };
  const event = {
    sequence: "1",
    operationId: requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef: payload.localOffloadId,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("receiving", event);
  return event as Phase9ReceivingEvent;
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

async function replay(client: PoolClient, event: Phase9ReceivingEvent, overrideConflicts: string[] = []) {
  await phase9ReceivingApplyHandler.authorize(client, event);
  const result = await phase9ReceivingApplyHandler.apply(client, event, { overrideConflicts });
  expect(await phase9ReceivingApplyHandler.verify(client, event, result)).toBe(true);
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

const qty = async (client: { query: PoolClient["query"] }) =>
  Number(
    (
      await client.query(
        "SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3",
        [ctx.companyId, ctx.locationId, ctx.stockItemIds[0]]
      )
    ).rows[0]?.quantity ?? 0
  );

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const supplier = await pool.query(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `${PREFIX}SUP`.toUpperCase(), `${PREFIX}_supplier`, `${PREFIX}@example.test`]
  );
  supplierId = Number(supplier.rows[0].id);
  edge.config = LAN;
  await ensurePhase9ReceivingOutboxSchema(pool);
  edge.config = CLOUD;
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  await pool.query(
    "ALTER TABLE factory_edge_receiving_outbox DISABLE TRIGGER factory_edge_receiving_outbox_no_mutation"
  );
  await pool.query("DELETE FROM factory_edge_receiving_outbox WHERE site_id = $1", [SITE]);
  await pool.query(
    "ALTER TABLE factory_edge_receiving_outbox ENABLE TRIGGER factory_edge_receiving_outbox_no_mutation"
  );
  await pool.query("DELETE FROM factory_edge_receiving_counter WHERE site_id = $1", [SITE]);
  for (const table of [
    "canonical_stock_movement_audit",
    "canonical_stock_movement_requests",
    "canonical_stock_movements",
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = $1`, [ctx.companyId]);
  }
  await pool.query(
    "DELETE FROM container_offload_items WHERE offload_id IN (SELECT o.id FROM container_offloads o JOIN containers c ON c.id = o.container_id WHERE c.company_id = $1)",
    [ctx.companyId]
  );
  await pool.query(
    "DELETE FROM container_offloads WHERE container_id IN (SELECT id FROM containers WHERE company_id = $1)",
    [ctx.companyId]
  );
  await pool.query("DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)", [
    ctx.companyId,
  ]);
  await pool.query("DELETE FROM purchase_orders WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 9 offline receiving on the factory LAN server (POST /api/containers/:id/offload)", () => {
  it("captures charges and accounts in canonical form", () => {
    expect(
      offlineReceivingInputs({
        companyId: 1,
        containerId: 1,
        mode: "create-or-replace",
        locationId: 1,
        offloadDate: "2026-11-02",
        duties: "12.50",
        dutiesAccountId: 7,
        officeCharges: "0.00",
        transferCharges: "3",
        transportFees: "0",
        additionalCharges: [{ description: "Forklift", amount: 20, ledgerAccountId: 9 }],
        inventoryCostCorrections: [{ stockItemId: 4, correctRate: 6.75 }],
      })
    ).toEqual({
      ...NO_CHARGES,
      duties: "12.5",
      dutiesAccountId: 7,
      transferCharges: "3",
      additionalCharges: [{ description: "Forklift", amount: "20", ledgerAccountId: 9 }],
      inventoryCostCorrections: [{ stockItemId: 4, correctRate: "6.75" }],
    });
  });

  it("records the committed first offload in the same transaction, with the order's quantity digest", async () => {
    const containerId = await container();
    edge.config = LAN;
    try {
      const result = await runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), () =>
        executeContainerOffloadLifecycle(
          {
            companyId: ctx.companyId,
            containerId,
            mode: "create-or-replace",
            locationId: ctx.locationId,
            offloadDate: "2026-11-02",
            duties: "0",
            officeCharges: "0",
            transferCharges: "0",
            transportFees: "0",
          },
          offlineReceivingCapture(
            { userId: ctx.userId, username: `${PREFIX}_testuser` },
            {
              companyId: ctx.companyId,
              containerId,
              mode: "create-or-replace",
              locationId: ctx.locationId,
              offloadDate: "2026-11-02",
              duties: "0",
              officeCharges: "0",
              transferCharges: "0",
              transportFees: "0",
            }
          )
        )
      );
      const outbox = await pool.query(
        "SELECT local_offload_id, payload FROM factory_edge_receiving_outbox WHERE site_id = $1",
        [SITE]
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].local_offload_id).toBe(result.offload.id);
      expect(outbox.rows[0].payload).toMatchObject({
        containerId,
        offloadDate: "2026-11-02",
        mode: "create",
        offload: NO_CHARGES,
        lineDigest: phase9ReceivingLineDigest([{ stockItemId: ctx.stockItemIds[0], quantity: "10" }]),
      });
    } finally {
      edge.config = CLOUD;
    }
  });
});

describe("Phase 9 offline receiving cloud replay", () => {
  it("receives the container through the offload lifecycle on the receipt's transaction", async () => {
    const containerId = await container();
    const digest = phase9ReceivingLineDigest([{ stockItemId: ctx.stockItemIds[0], quantity: "10.000" }]);
    await inRolledBackTx(async (client) => {
      const before = await qty(client);
      const result = await replay(client, receivingEvent(containerId, digest));
      expect(result).toMatchObject({ outcome: "cloud-applied", businessDate: "2026-11-02" });
      expect(await qty(client)).toBe(before + 10);
      const status = await client.query("SELECT status FROM containers WHERE id = $1", [containerId]);
      expect(status.rows[0].status).toBe("OFFLOADED");
      // The same container can never be received twice.
      expect(await conflictCode(replay(client, receivingEvent(containerId, digest)))).toBe(
        "PHASE9_RECEIVING_ALREADY_OFFLOADED"
      );
    });
  });

  it("holds a receipt whose order quantities changed in the cloud until it is approved", async () => {
    const containerId = await container("12.000");
    const lanDigest = phase9ReceivingLineDigest([{ stockItemId: ctx.stockItemIds[0], quantity: "10" }]);
    await inRolledBackTx(async (client) => {
      const before = await qty(client);
      const event = receivingEvent(containerId, lanDigest);
      expect(await conflictCode(replay(client, event))).toBe("PHASE9_RECEIVING_ORDER_CHANGED");
      await replay(client, event, ["PHASE9_RECEIVING_ORDER_CHANGED"]);
      // Approved: the cloud's current order quantity is received.
      expect(await qty(client)).toBe(before + 12);
    });
  });

  it("replays an offloaded container's edit with its duties as entered", async () => {
    const containerId = await container();
    const digest = phase9ReceivingLineDigest([{ stockItemId: ctx.stockItemIds[0], quantity: "10" }]);
    await inRolledBackTx(async (client) => {
      const editBeforeOffload = receivingEvent(containerId, digest, "edit");
      expect(await conflictCode(replay(client, editBeforeOffload))).toBe("PHASE9_RECEIVING_NOT_OFFLOADED");
      await replay(client, receivingEvent(containerId, digest));
      const edited = await replay(client, receivingEvent(containerId, digest, "edit", { ...NO_CHARGES, duties: "25" }));
      const offload = await client.query("SELECT duties::numeric AS duties FROM container_offloads WHERE id = $1", [
        edited.cloudRef,
      ]);
      expect(Number(offload.rows[0].duties)).toBe(25);
    });
  });
});
