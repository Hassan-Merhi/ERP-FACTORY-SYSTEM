/**
 * Standalone browser offline mode (Phases 13–15): a laptop's browser delivers
 * the operations it recorded offline straight to the cloud
 * (/api/offline/browser-sync/*), on the full application schema.
 *
 * It must apply each operation exactly once, take the actor from the session,
 * report conflicts without writing, let only an Admin/Developer approve an
 * overridable conflict, and resolve records the browser itself created offline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { pool } from "../server/db";
import { ensurePhase9CloudEventSchema } from "../server/edge/phase9CloudEventStore.mjs";
import { ensurePhase9StockItemMapSchema } from "../server/edge/phase9StockItemMap.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "brwsync";
const DEVICE = randomUUID();
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let stockGroupId: number;
let location2: number;
let localRef = 1_000_000_000;

function op(kind: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  localRef += 1;
  return {
    deviceId: DEVICE,
    operationId: randomUUID(),
    kind,
    localRef,
    capturedAt: new Date().toISOString(),
    input,
    ...extra,
  };
}

async function quantity(stockItemId: number, locationId = ctx.locationId): Promise<number> {
  const row = await pool.query(
    "SELECT quantity::numeric AS q FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3",
    [ctx.companyId, locationId, stockItemId]
  );
  return Number(row.rows[0]?.q ?? 0);
}

beforeAll(async () => {
  process.env.OFFLINE_BROWSER_SYNC_ENABLED = "1";
  ctx = await seedTestData(PREFIX);
  await ensurePhase9CloudEventSchema(pool);
  await ensurePhase9StockItemMapSchema(pool);
  const group = await pool.query("SELECT id FROM stock_groups WHERE company_id = $1 ORDER BY id LIMIT 1", [
    ctx.companyId,
  ]);
  stockGroupId = Number(group.rows[0].id);
  const loc = await pool.query("INSERT INTO locations (company_id, code, name) VALUES ($1, $2, $3) RETURNING id", [
    ctx.companyId,
    `${PREFIX.toUpperCase()}-L2`,
    `${PREFIX} second`,
  ]);
  location2 = Number(loc.rows[0].id);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  for (const table of ["factory_edge_applied_events", "factory_edge_stock_item_map"]) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await pool.query(`DELETE FROM ${table} WHERE site_id = $1`, [DEVICE]);
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  delete process.env.OFFLINE_BROWSER_SYNC_ENABLED;
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Browser offline sync: switched off", () => {
  it("answers 404 and writes nothing unless OFFLINE_BROWSER_SYNC_ENABLED=1", async () => {
    process.env.OFFLINE_BROWSER_SYNC_ENABLED = "0";
    try {
      const res = await agent.post("/api/offline/browser-sync/operations").send(
        op("stock.quick-adjust.v1", {
          stockItemId: ctx.stockItemIds[0],
          locationId: ctx.locationId,
          quantity: "1",
          type: "add",
        })
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("OFFLINE_BROWSER_SYNC_DISABLED");
    } finally {
      process.env.OFFLINE_BROWSER_SYNC_ENABLED = "1";
    }
  });
});

describe("Browser offline sync: exactly once", () => {
  it("applies a quick adjust once, returns the same receipt for a lost acknowledgement, and refuses a changed replay", async () => {
    const before = await quantity(ctx.stockItemIds[0]);
    const body = op("stock.quick-adjust.v1", {
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: "4",
      type: "add",
    });
    const first = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ operationId: body.operationId, outcome: "cloud-applied", replayed: false });
    expect(await quantity(ctx.stockItemIds[0])).toBe(before + 4);

    const again = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ operationId: body.operationId, cloudRef: first.body.cloudRef, replayed: true });
    expect(await quantity(ctx.stockItemIds[0])).toBe(before + 4);

    const changed = await agent
      .post("/api/offline/browser-sync/operations")
      .send({ ...body, input: { ...body.input, quantity: "9" } });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("OFFLINE_BROWSER_DIVERGENT_REPLAY");

    const receipts = await agent
      .post("/api/offline/browser-sync/receipts")
      .send({ deviceId: DEVICE, operationIds: [body.operationId, randomUUID()] });
    expect(receipts.status).toBe(200);
    expect(receipts.body.receipts).toEqual([expect.objectContaining({ operationId: body.operationId })]);
  });

  it("takes the actor from the session, not the browser", async () => {
    const res = await agent.post("/api/offline/browser-sync/operations").send(
      op("stock.quick-adjust.v1", {
        stockItemId: ctx.stockItemIds[0],
        locationId: ctx.locationId,
        quantity: "1",
        type: "add",
        actorUserId: "someone-else",
      })
    );
    expect(res.status).toBe(200);
    const row = await pool.query(
      "SELECT actor_user_id, company_id FROM factory_edge_applied_events WHERE site_id = $1 AND operation_id = $2",
      [DEVICE, res.body.operationId]
    );
    expect(row.rows[0]).toMatchObject({ actor_user_id: ctx.userId, company_id: ctx.companyId });
  });

  it("refuses input it cannot accept, without writing", async () => {
    const res = await agent.post("/api/offline/browser-sync/operations").send(
      op("stock.quick-adjust.v1", {
        stockItemId: ctx.stockItemIds[0],
        locationId: ctx.locationId,
        quantity: "1",
        type: "wipe",
      })
    );
    expect(res.status).toBe(422);
    const unknown = await agent.post("/api/offline/browser-sync/operations").send(op("factory.payroll.v1", {}));
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe("OFFLINE_BROWSER_KIND_NOT_SUPPORTED");
  });
});

describe("Browser offline sync: conflicts", () => {
  it("reports a subtraction below zero as an overridable conflict, writes nothing, and applies it when an Admin approves", async () => {
    const item = ctx.stockItemIds[1] ?? ctx.stockItemIds[0];
    const before = await quantity(item);
    const body = op("stock.quick-adjust.v1", {
      stockItemId: item,
      locationId: ctx.locationId,
      quantity: String(before + 50),
      type: "subtract",
    });
    const held = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(held.status, JSON.stringify(held.body)).toBe(409);
    expect(held.body).toMatchObject({ code: "PHASE9_STOCK_WOULD_GO_NEGATIVE", overridable: true });
    expect(await quantity(item)).toBe(before);

    const wrong = await agent
      .post("/api/offline/browser-sync/operations")
      .send({ ...body, override: "PHASE9_STOCK_ITEM_MISSING" });
    expect(wrong.status).toBe(403);

    const approved = await agent
      .post("/api/offline/browser-sync/operations")
      .send({ ...body, override: "PHASE9_STOCK_WOULD_GO_NEGATIVE" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await quantity(item)).toBe(before - (before + 50));
  });

  it("records a discarded operation as rejected and leaves the cloud untouched", async () => {
    const body = op("stock.quick-adjust.v1", {
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: "2",
      type: "add",
    });
    const before = await quantity(ctx.stockItemIds[0]);
    const res = await agent.post("/api/offline/browser-sync/operations/discard").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "rejected-conflict", cloudRef: null });
    expect(await quantity(ctx.stockItemIds[0])).toBe(before);
    // Sending it afterwards returns the rejection, never applies it.
    const later = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(later.body).toMatchObject({ outcome: "rejected-conflict", replayed: true });
    expect(await quantity(ctx.stockItemIds[0])).toBe(before);
  });
});

describe("Browser offline sync: records the browser created offline", () => {
  it("creates a stock item offline; a stock change and a transfer naming it land on the cloud item, and the transfer waits until the item exists", async () => {
    const code = `${PREFIX.toUpperCase()}-${Date.now() % 100000}`;
    const create = op("stock.item-create.v1", { code, name: `Offline item ${code}`, uom: "PCS", stockGroupId });
    const transfer = op("stock.transfer.v1", {
      sourceLocationId: ctx.locationId,
      destinationLocationId: location2,
      effectiveDate: new Date().toISOString().slice(0, 10),
      notes: "offline transfer",
      allowNegativeInventory: true,
      items: [{ stockItemId: create.localRef, quantity: "1", rate: "2" }],
    });
    const early = await agent.post("/api/offline/browser-sync/operations").send(transfer);
    expect(early.status, JSON.stringify(early.body)).toBe(202);
    expect(early.body.code).toBe("PHASE9_STOCK_ITEM_NOT_YET_SYNCED");

    const created = await agent.post("/api/offline/browser-sync/operations").send(create);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const item = await pool.query("SELECT id FROM stock_items WHERE company_id = $1 AND code = $2", [
      ctx.companyId,
      code,
    ]);
    expect(Number(item.rows[0].id)).toBe(created.body.cloudRef);

    // Stock added offline to the new item, named by its local id too.
    const stocked = await agent.post("/api/offline/browser-sync/operations").send(
      op("stock.quick-adjust.v1", {
        stockItemId: create.localRef,
        locationId: ctx.locationId,
        quantity: "5",
        type: "add",
      })
    );
    expect(stocked.status, JSON.stringify(stocked.body)).toBe(200);
    expect(await quantity(created.body.cloudRef)).toBe(5);

    const moved = await agent.post("/api/offline/browser-sync/operations").send(transfer);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const line = await pool.query("SELECT stock_item_id FROM stock_transfer_items WHERE transfer_id = $1", [
      moved.body.cloudRef,
    ]);
    expect(line.rows.map((row) => Number(row.stock_item_id))).toEqual([created.body.cloudRef]);
  });
});

describe("Browser offline sync: money and sales", () => {
  it("posts a Payment saved offline once, through the normal posting code", async () => {
    const supplier = await pool.query(
      `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active, stock_group_id)
       VALUES ($1, $2, 'Offline Supplier', 'offline@brwsync.test', '0', true, $3) RETURNING id`,
      [ctx.companyId, `${PREFIX}-SUP-${ctx.companyId}`, ctx.stockGroupId]
    );
    const bank = await pool.query(
      `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side, active)
       VALUES ($1, $2, 'Laptop Bank', 'Laptop Bank', 'BRW-001', '0', 'Dr', true) RETURNING id`,
      [ctx.companyId, `${PREFIX}-BANK-${ctx.companyId}`]
    );
    const body = op("voucher.payment-receipt.v1", {
      voucherType: "Payment",
      voucherDate: new Date().toISOString().slice(0, 10),
      paymentAccountType: "supplier",
      paymentAccountId: Number(supplier.rows[0].id),
      entries: [{ accountType: "bank", accountId: Number(bank.rows[0].id), amount: "37.50" }],
      notes: "Paid while offline",
    });
    const first = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(again.body).toMatchObject({ cloudRef: first.body.cloudRef, replayed: true });
    const vouchers = await pool.query(
      "SELECT count(*)::int AS n, max(total_amount)::numeric AS total FROM vouchers WHERE company_id = $1 AND id = $2",
      [ctx.companyId, first.body.cloudRef]
    );
    expect(vouchers.rows[0]).toMatchObject({ n: 1 });
    expect(Number(vouchers.rows[0].total)).toBe(37.5);
  });

  it("records a POS cash sale saved offline once, and refuses one that names no payment account", async () => {
    const before = await quantity(ctx.stockItemIds[0]);
    const body = op("pos.sale.v1", {
      locationId: ctx.locationId,
      cashAccountId: ctx.cashAccountId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 2, rate: 12.5 }],
    });
    const first = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post("/api/offline/browser-sync/operations").send(body);
    expect(again.body).toMatchObject({ cloudRef: first.body.cloudRef, replayed: true });
    expect(await quantity(ctx.stockItemIds[0])).toBe(before - 2);

    const noAccount = await agent
      .post("/api/offline/browser-sync/operations")
      .send(
        op("pos.sale.v1", {
          locationId: ctx.locationId,
          items: [{ stockItemId: ctx.stockItemIds[0], quantity: 1, rate: 1 }],
        })
      );
    expect(noAccount.status).toBe(422);
    expect(noAccount.body.code).toBe("OFFLINE_POS_ACCOUNT_REQUIRED");
  });
});

describe("Browser offline sync: device binding", () => {
  it("refuses a device id that another user's operations already use", async () => {
    const foreignDevice = randomUUID();
    await pool.query(
      `INSERT INTO factory_edge_applied_events
         (site_id, stream, sequence, operation_id, company_id, actor_user_id, operation_kind,
          local_ref, cloud_ref, payload_sha256, business_date, outcome)
       VALUES ($1, 'stock', 1, $2, $3, 'another-user', 'stock.quick-adjust.v1', 1, NULL, $4, NULL, 'rejected-conflict')`,
      [foreignDevice, randomUUID(), ctx.companyId, "0".repeat(64)]
    );
    try {
      const res = await agent.post("/api/offline/browser-sync/operations").send({
        ...op("stock.quick-adjust.v1", {
          stockItemId: ctx.stockItemIds[0],
          locationId: ctx.locationId,
          quantity: "1",
          type: "add",
        }),
        deviceId: foreignDevice,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("OFFLINE_BROWSER_DEVICE_BOUND");
    } finally {
      await pool.query("ALTER TABLE factory_edge_applied_events DISABLE TRIGGER USER");
      await pool.query("DELETE FROM factory_edge_applied_events WHERE actor_user_id = 'another-user'");
      await pool.query("ALTER TABLE factory_edge_applied_events ENABLE TRIGGER USER");
    }
  });
});
