/**
 * Wave 15 (A) — perpetual inventory readiness tooling (accounting audit 2026-10):
 *
 *   M1  the as-of stock valuation replays movements that leave no document
 *       line (quick adjustments, archive/restore) from their dated evidence,
 *       so the reconciliation of a past date equals the ledger;
 *   1-2 the readiness resolution previews orphaned-location stock and
 *       anomalous values, and an Owner's apply restores (archived placeholder
 *       location, stock counted again) or writes off (rows zeroed with
 *       canonical evidence and audit), refusing a changed plan;
 *   2/M3 the cut-over apply is refused while orphaned stock or anomalies remain,
 *       or while a factory receipt (or offload, or evidenced movement) is dated
 *       on or after the cut-over, and is applied once they are resolved;
 *   5   the read-only readiness report lists the blockers;
 *   C1  a container offloaded before the cut-over posts INV-MOVE journals when
 *       it is reversed after it; carriedByOpening follows the opening plan's
 *       goods-in-transit list (the offload-date test), not the PO date alone.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import {
  OpeningJournalRefusal,
  applyOpeningInventoryJournal,
} from "../server/services/accounting/perpetualInventory/openingJournal";
import { reconcilePerpetualInventory } from "../server/services/accounting/perpetualInventory/reconciliation";
import { executeContainerOffloadLifecycle } from "../server/services/containers/offload-lifecycle";
import { OFFLOAD_BEFORE_CUTOVER_CODE } from "../server/services/containers/offload-lifecycle/execute";
import {
  applyReadinessResolution,
  planReadinessResolution,
} from "../server/services/inventory/inventoryReadinessResolution";
import { companyStockValuation, companyStockValuationAsOf } from "../server/services/inventory/stockValuation";
import { calculateHistoricalLocationInventory } from "../server/routes/helpers/inventoryHistoryHelpers";
import { createPurchaseOrder } from "../server/storage/containers-store/purchase-orders";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w15a";
const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = day(0);
const yesterday = day(-1);
const tomorrow = day(1);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let sequence = 0;

async function newItem(): Promise<number> {
  sequence += 1;
  const code = `${TEST_PREFIX}-I${sequence}`;
  const [item] = await db
    .insert(schema.stockItems)
    .values({ companyId: ctx.companyId, code, name: code, uom: "PCS", stockGroupId: ctx.stockGroupId, active: true })
    .returning();
  return item.id;
}

async function setStock(locationId: number, stockItemId: number, quantity: string, rate: string, value: string) {
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (location_id, stock_item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, average_rate = EXCLUDED.average_rate, total_value = EXCLUDED.total_value`,
    [ctx.companyId, locationId, stockItemId, quantity, rate, value]
  );
}

async function row(locationId: number, stockItemId: number) {
  const { rows } = await pool.query(
    `SELECT quantity::text AS quantity, total_value::text AS value FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
    [locationId, stockItemId]
  );
  return rows[0] as { quantity: string; value: string } | undefined;
}

/** A location holding the given stock, whose row is then deleted (production has no foreign key). */
async function orphanedLocation(stock: Array<[number, string, string, string]>): Promise<number> {
  sequence += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-L${sequence}`, `${TEST_PREFIX} L${sequence}`]
  );
  const locationId = rows[0].id;
  for (const [itemId, quantity, rate, value] of stock) await setStock(locationId, itemId, quantity, rate, value);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`DELETE FROM locations WHERE id = $1`, [locationId]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  return locationId;
}

async function setCutover(effectiveFrom: string | null, plan: Record<string, unknown> = {}) {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
  if (effectiveFrom) {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, $3::jsonb, 'test')`,
      [ctx.companyId, effectiveFrom, JSON.stringify(plan)]
    );
  }
}

async function journals(pattern: string) {
  const { rows } = await pool.query(
    `SELECT v.voucher_number, la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL
      ORDER BY v.id, la.code`,
    [ctx.companyId, pattern]
  );
  return rows.map((entry) => [entry.code, entry.d, entry.c]);
}

async function inventoryLine(asOf: string) {
  const reconciliation = await reconcilePerpetualInventory(db, ctx.companyId, asOf);
  return reconciliation.lines.find((line) => line.accountCode === "INVENTORY")!;
}

/** A container with one PO (10 × 5.00 + 20 × 4.00 = 130.00) whose voucher is dated `poDate`. */
async function containerWithPurchaseOrder(poDate: string) {
  sequence += 1;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, charges_total)
     VALUES ($1, $2, $3, 'OTW', $4, '0') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C${sequence}`, supplierId, poDate]
  );
  const containerId = container.rows[0].id;
  const po = await createPurchaseOrder(
    {
      companyId: ctx.companyId,
      poNumber: `${TEST_PREFIX}-PO${sequence}`,
      containerId,
      supplierId,
      currency: "USD",
      status: "Open",
      itemsTotal: "130.00",
    },
    poDate
  );
  const [itemA, itemB] = ctx.stockItemIds;
  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'line', '10', '5.00', '50.00'), ($1, $3, 'line', '20', '4.00', '80.00')`,
    [po.id, itemA, itemB]
  );
  return { containerId, poId: po.id };
}

/** Duties 30 over 30 bales: landed value 130 + 30 = 160. */
const offloadBody = (offloadDate: string) => ({
  locationId: ctx.locationId,
  offloadDate,
  duties: "30.00",
  dutiesAccountId: ctx.cashAccountId,
  officeCharges: "0",
  transferCharges: "0",
  transportFees: "0",
});

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}SUP`, `${TEST_PREFIX} Supplier`, "w15a@example.test"]
  );
  supplierId = supplier.rows[0].id;
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  // The fixture's seeded stock carries no movement evidence; the tests start from none.
  await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM inventory_value_movements WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM factory_container_receipts WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM inventory_negative_layers WHERE company_id = $1`, [id]);
  await pool.query(
    `DELETE FROM stock_group_location_archive_items WHERE archive_id IN (
    SELECT id FROM stock_group_location_archives WHERE company_id = $1)`,
    [id]
  );
  await pool.query(`DELETE FROM stock_group_location_archives WHERE company_id = $1`, [id]);
  // Inventory rows left on a deleted location (a failed run) would block the item deletes.
  await pool.query(
    `DELETE FROM inventory WHERE company_id = $1 AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = inventory.location_id)`,
    [id]
  );
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("as-of replay of movements without a document line (M1)", () => {
  it("reconciles a past date with the ledger across a quick adjustment, an archive and its restore", async () => {
    await setCutover("2026-01-01");
    const item = await newItem();
    // An empty row that remembers its cost (5.00): the quick add receives at it.
    await setStock(ctx.location2Id, item, "0", "5", "0");
    expect((await inventoryLine(yesterday)).subLedger).toBe("0.00");

    const added = await agent
      .post("/api/inventory/quick-adjust")
      .send({ stockItemId: item, locationId: ctx.location2Id, quantity: 10, type: "add" });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(await row(ctx.location2Id, item)).toEqual({ quantity: "10.000", value: "50.00" });

    const todayLine = await inventoryLine(today);
    expect(todayLine.subLedger).toBe("50.00");
    expect(todayLine.difference).toBe("0.00");
    // Yesterday the stock was not there yet, in the ledger and (replayed from evidence) in the sub-ledger.
    const pastLine = await inventoryLine(yesterday);
    expect(pastLine.subLedger).toBe("0.00");
    expect(pastLine.difference).toBe("0.00");

    const archived = await agent
      .post("/api/stock-group-archives")
      .send({ locationId: ctx.location2Id, stockGroupId: ctx.stockGroupId, notes: "w15a" });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect((await inventoryLine(today)).subLedger).toBe("0.00");
    expect((await inventoryLine(today)).difference).toBe("0.00");
    expect((await inventoryLine(yesterday)).difference).toBe("0.00");

    const restored = await agent.post(`/api/stock-group-archives/${archived.body.id}/restore`).send({});
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((await inventoryLine(today)).difference).toBe("0.00");
    const past = await companyStockValuationAsOf(db, ctx.companyId, yesterday);
    expect(past.subLedgerTotal).toBe("0.00");
    const historical = await calculateHistoricalLocationInventory(ctx.location2Id, ctx.companyId, yesterday);
    const replayed = historical.find((entry) => entry.stockItemId === item);
    expect(replayed?.quantity).toBe("0");
    expect(replayed?.totalValue).toBe("0");

    // Leave the company without stock or ledger inventory for the next tests.
    const removed = await agent
      .post("/api/inventory/quick-adjust")
      .send({ stockItemId: item, locationId: ctx.location2Id, quantity: 10, type: "subtract" });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await inventoryLine(today)).ledger).toBe("0.00");
    await setCutover(null);
  }, 120_000);
});

describe("readiness resolution (decisions 1 and 2)", () => {
  it("previews orphaned stock and anomalies, refuses a changed plan, restores and writes off on apply", async () => {
    const [i1, i2, i3, i4, i5, i6] = [
      await newItem(),
      await newItem(),
      await newItem(),
      await newItem(),
      await newItem(),
      await newItem(),
    ];
    const restoreId = await orphanedLocation([
      [i1, "10", "10", "100.00"],
      [i2, "0", "1", "5.00"],
    ]);
    const writeOffId = await orphanedLocation([[i3, "4", "10", "40.00"]]);
    await setStock(ctx.locationId, i4, "0", "7", "7.00");
    await setStock(ctx.locationId, i5, "-2", "1.5", "3.00");
    await setStock(ctx.locationId, i6, "5", "1", "-2.00");

    const preview = await agent.get("/api/accounting/perpetual-inventory/readiness-resolution");
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const orphaned = preview.body.orphanedLocations as Array<{
      locationId: number;
      items: number;
      value: string;
      rows: Array<{ stockItemId: number; anomaly: string | null }>;
    }>;
    expect(orphaned.map((entry) => [entry.locationId, entry.items, entry.value])).toEqual([
      [restoreId, 2, "105.00"],
      [writeOffId, 1, "40.00"],
    ]);
    expect(orphaned[0].rows.find((entry) => entry.stockItemId === i2)?.anomaly).toBe("VALUE_AT_ZERO_QUANTITY");
    const anomalies = preview.body.anomalies as Array<{ stockItemId: number; anomaly: string }>;
    expect(anomalies.map((entry) => [entry.stockItemId, entry.anomaly])).toEqual([
      [i4, "VALUE_AT_ZERO_QUANTITY"],
      [i5, "POSITIVE_VALUE_ON_SHORT_ROW"],
      [i6, "NEGATIVE_VALUE_ON_STOCK"],
    ]);
    expect(preview.body.totals).toMatchObject({ orphanedLocations: 2, orphanedRows: 3, anomalousRows: 3 });

    const before = toCents((await companyStockValuation(db, ctx.companyId)).total);
    const body = {
      confirm: true,
      planHash: preview.body.planHash,
      actions: [
        { locationId: restoreId, action: "restore" },
        { locationId: writeOffId, action: "writeOff" },
      ],
      writeOffAnomalies: true,
    };
    const stale = await agent
      .post("/api/accounting/perpetual-inventory/readiness-resolution/apply")
      .send({ ...body, planHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_CHANGED");
    const unconfirmed = await agent
      .post("/api/accounting/perpetual-inventory/readiness-resolution/apply")
      .send({ ...body, confirm: false });
    expect(unconfirmed.status).toBe(400);

    const applied = await agent.post("/api/accounting/perpetual-inventory/readiness-resolution/apply").send(body);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    // Before the cut-over nothing is journalled.
    expect(applied.body.journals).toEqual([]);
    expect(applied.body.anomaliesWrittenOff).toBe(4);

    // Restored: the stock is counted again, at an inactive archived location.
    const after = toCents((await companyStockValuation(db, ctx.companyId)).total);
    expect(after - before).toBe(10_000);
    const { rows: recreated } = await pool.query(
      `SELECT id, company_id, code, name, active FROM locations WHERE id = ANY($1::int[]) ORDER BY id`,
      [[restoreId, writeOffId]]
    );
    expect(recreated).toEqual([
      {
        id: restoreId,
        company_id: ctx.companyId,
        code: `ARCHIVED-LOC-${restoreId}`,
        name: `Archived location #${restoreId}`,
        active: false,
      },
      {
        id: writeOffId,
        company_id: ctx.companyId,
        code: `ARCHIVED-LOC-${writeOffId}`,
        name: `Archived location #${writeOffId}`,
        active: false,
      },
    ]);
    expect(await row(restoreId, i1)).toEqual({ quantity: "10.000", value: "100.00" });

    // Written off: zero quantity and value, with canonical evidence.
    expect(await row(writeOffId, i3)).toEqual({ quantity: "0.000", value: "0.00" });
    const { rows: canonical } = await pool.query(
      `SELECT quantity_delta::text AS q FROM canonical_stock_movements
        WHERE company_id = $1 AND source_type = 'inventory_readiness_write_off' AND stock_item_id = $2`,
      [ctx.companyId, i3]
    );
    expect(canonical).toEqual([{ q: "-4.000000" }]);

    // Anomalies: the values go, the quantities stay; their evidence is dated today.
    expect(await row(ctx.locationId, i4)).toEqual({ quantity: "0.000", value: "0.00" });
    expect(await row(ctx.locationId, i5)).toEqual({ quantity: "-2.000", value: "0.00" });
    expect(await row(ctx.locationId, i6)).toEqual({ quantity: "5.000", value: "0.00" });
    expect(await row(restoreId, i2)).toEqual({ quantity: "0.000", value: "0.00" });
    const { rows: evidence } = await pool.query(
      `SELECT COUNT(*)::int AS lines, SUM(value_delta)::text AS total FROM inventory_value_movements
        WHERE company_id = $1 AND source_type = 'readiness-anomaly' AND movement_date = $2`,
      [ctx.companyId, today]
    );
    expect(evidence).toEqual([{ lines: 4, total: "-13.00" }]);

    const { rows: audit } = await pool.query(
      `SELECT changes FROM audit_log WHERE company_id = $1 AND record_identifier LIKE 'inventory-readiness-resolution:%'`,
      [ctx.companyId]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.writtenOffRows.old).toEqual([
      expect.objectContaining({ locationId: writeOffId, stockItemId: i3, quantity: "4.000", totalValue: "40.00" }),
    ]);
    expect(audit[0].changes.writtenOffRows.new).toEqual([
      expect.objectContaining({ locationId: writeOffId, stockItemId: i3, quantity: "0.000", totalValue: "0.00" }),
    ]);
    expect(audit[0].changes.anomalies.old).toHaveLength(4);

    const again = await agent.get("/api/accounting/perpetual-inventory/readiness-resolution");
    expect(again.body.totals).toMatchObject({ orphanedRows: 0, anomalousRows: 0 });
  }, 120_000);
});

function toCents(value: string): number {
  return Math.round(Number(value) * 100);
}

describe("cut-over apply guards (decision 2, M3)", () => {
  it("refuses while orphaned stock or a receipt on or after the cut-over remains, and applies after", async () => {
    const item = await newItem();
    const orphanId = await orphanedLocation([[item, "2", "5", "10.00"]]);
    const apply = () =>
      applyOpeningInventoryJournal(ctx.companyId, tomorrow, "w15a", { postingReady: true, today: tomorrow });

    const blocked = await apply().catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(OpeningJournalRefusal);
    expect((blocked as OpeningJournalRefusal).code).toBe("READINESS_BLOCKERS");
    expect((blocked as OpeningJournalRefusal).message).toContain("1 rows (value 10.00) on 1 locations");

    const plan = await planReadinessResolution(ctx.companyId);
    await applyReadinessResolution(ctx.companyId, {
      planHash: plan.planHash,
      actions: [{ locationId: orphanId, action: "writeOff" }],
      writeOffAnomalies: false,
      actor: { userId: ctx.userId, username: "w15a" },
    });

    sequence += 1;
    // factory_container_receipts.container_id references factory_containers.
    const factorySupplier = await pool.query<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-FS${sequence}`]
    );
    const container = await pool.query<{ id: number }>(
      `INSERT INTO factory_containers (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code, status)
       VALUES ($1, $2, $3, '10.000', '1.00', 'USD', 'PENDING') RETURNING id`,
      [ctx.companyId, factorySupplier.rows[0].id, `${TEST_PREFIX}-R${sequence}`]
    );
    await pool.query(
      `INSERT INTO factory_container_receipts (company_id, container_id, receipt_date, received_kg, cumulative_received_kg)
       VALUES ($1, $2, $3, 10, 10)`,
      [ctx.companyId, container.rows[0].id, tomorrow]
    );
    const dated = await apply().catch((error: unknown) => error);
    expect((dated as OpeningJournalRefusal).code).toBe("DOCUMENTS_ON_OR_AFTER_CUTOVER");
    expect((dated as OpeningJournalRefusal).message).toContain("1 factory container receipts");
    await pool.query(`DELETE FROM factory_container_receipts WHERE company_id = $1`, [ctx.companyId]);

    const applied = await apply();
    expect(applied.plan.goodsInTransitPurchaseOrderIds).toEqual([]);
    // Undo the cut-over for the next tests (the opening journal leaves the ledger with it).
    await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [ctx.companyId]);
    if (applied.voucherId) {
      await pool.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [applied.voucherId]);
    }
  }, 120_000);
});

describe("readiness report (item 5)", () => {
  it("lists the blockers, read-only", async () => {
    const item = await newItem();
    const orphanId = await orphanedLocation([[item, "3", "2", "6.00"]]);
    const res = await agent.get("/api/accounting/perpetual-inventory/readiness").query({ effectiveFrom: "2026-01-01" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ready).toBe(false);
    const codes = (res.body.blockers as Array<{ code: string }>).map((blocker) => blocker.code);
    expect(codes).toContain("POSTING_NOT_READY");
    expect(codes).toContain("ORPHANED_LOCATION_STOCK");
    // The earlier tests' vouchers and movements are dated after 2026-01-01.
    expect(codes).toContain("DOCUMENTS_ON_OR_AFTER_CUTOVER");
    expect(res.body.orphanedStock).toEqual({ locations: 1, rows: 1, value: "6.00" });
    expect(res.body.openingPlan).not.toBeNull();
    expect(await row(orphanId, item)).toEqual({ quantity: "3.000", value: "6.00" });

    const plan = await planReadinessResolution(ctx.companyId);
    await applyReadinessResolution(ctx.companyId, {
      planHash: plan.planHash,
      actions: [{ locationId: orphanId, action: "writeOff" }],
      writeOffAnomalies: false,
      actor: { userId: ctx.userId, username: "w15a" },
    });
    const cleared = await agent.get("/api/accounting/perpetual-inventory/readiness");
    const clearedCodes = (cleared.body.blockers as Array<{ code: string }>).map((blocker) => blocker.code);
    expect(clearedCodes).not.toContain("ORPHANED_LOCATION_STOCK");
  }, 120_000);
});

describe("containers offloaded before the cut-over (C1)", () => {
  it("journals a reversal after the cut-over and follows the opening's transit list", async () => {
    const before = "2026-01-10";
    await pool.query(`DELETE FROM inventory WHERE location_id = $1 AND stock_item_id = ANY($2::int[])`, [
      ctx.locationId,
      ctx.stockItemIds,
    ]);
    // Two containers offloaded before the cut-over, a third still on the way at it.
    const reversed = await containerWithPurchaseOrder("2026-01-05");
    const edited = await containerWithPurchaseOrder("2026-01-05");
    const inTransit = await containerWithPurchaseOrder("2026-01-05");
    for (const containerId of [reversed.containerId, edited.containerId]) {
      const res = await agent.post(`/api/containers/${containerId}/offload`).send(offloadBody(before));
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    }
    await setCutover("2026-02-01", { goodsInTransitPurchaseOrderIds: [inTransit.poId] });

    // An offload dated before the applied cut-over is refused.
    const late = await agent.post(`/api/containers/${inTransit.containerId}/offload`).send(offloadBody(before));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe(OFFLOAD_BEFORE_CUTOVER_CODE);

    // Reversed after the cut-over: the PO cost goes back to transit, the rest to Purchases.
    const reverse = await agent.post(`/api/containers/${reversed.containerId}/reverse-offload`).send({});
    expect(reverse.status, JSON.stringify(reverse.body)).toBeLessThan(300);
    expect(await journals(`INV-MOVE-${ctx.companyId}-offload-to-transit-${reversed.containerId}:%`)).toEqual([
      ["GOODS_IN_TRANSIT", "130.00", "0.00"],
      ["INVENTORY", "0.00", "130.00"],
    ]);
    expect(await journals(`INV-MOVE-${ctx.companyId}-offload-precutover-${reversed.containerId}:%`)).toEqual([
      ["INVENTORY", "0.00", "30.00"],
      ["PURCHASES", "30.00", "0.00"],
    ]);
    // Offloaded again on or after the cut-over: STOCK-IN takes it out of transit once.
    const again = await agent.post(`/api/containers/${reversed.containerId}/offload`).send(offloadBody(today));
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    const stockIn = await journals(`STOCK-IN-${reversed.containerId}-%`);
    expect(stockIn).toContainEqual(["GOODS_IN_TRANSIT", "0.00", "130.00"]);
    expect(stockIn).toContainEqual(["INVENTORY", "160.00", "0.00"]);

    // Edited onto a date after the cut-over: the opening did not carry its PO in
    // transit (it was offloaded), so STOCK-IN credits Purchases, not Goods in Transit.
    await executeContainerOffloadLifecycle({
      companyId: ctx.companyId,
      containerId: edited.containerId,
      mode: "replace-only",
      ...offloadBody(today),
      additionalCharges: [],
      inventoryCostCorrections: [],
      agentChargeLines: [],
    });
    expect(await journals(`INV-MOVE-${ctx.companyId}-offload-precutover-${edited.containerId}:%`)).toEqual([
      ["INVENTORY", "0.00", "160.00"],
      ["PURCHASES", "160.00", "0.00"],
    ]);
    const editedStockIn = await journals(`STOCK-IN-${edited.containerId}-%`);
    expect(editedStockIn.find((line) => line[0] === "GOODS_IN_TRANSIT")).toBeUndefined();
    expect(editedStockIn).toContainEqual(["PURCHASES", "0.00", "130.00"]);

    // Listed by the opening as in transit: STOCK-IN credits Goods in Transit.
    const arrived = await agent.post(`/api/containers/${inTransit.containerId}/offload`).send(offloadBody(today));
    expect(arrived.status, JSON.stringify(arrived.body)).toBeLessThan(300);
    expect(await journals(`STOCK-IN-${inTransit.containerId}-%`)).toContainEqual([
      "GOODS_IN_TRANSIT",
      "0.00",
      "130.00",
    ]);
  }, 180_000);
});
