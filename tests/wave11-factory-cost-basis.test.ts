/**
 * Accounting audit wave 11, agent C: the factory bale cost basis.
 *
 *   - a mix from an AUD container is costed at the container's USD landed cost
 *     (never its AUD cost); a source with no USD rate leaves the mix unvalued
 *     before the cut-over and is refused (409) after it;
 *   - pressing gives each bale weight × the mix's USD cost per kg, so the work
 *     in progress it relieves equals the finished goods it adds; the ERP bale
 *     mirror receives the bales at rate 0 (quantity only);
 *   - a stock-entry bale with no mix costs its product's production price per
 *     bale (cost per kg = price ÷ weight);
 *   - after the cut-over a cost cascade leaves SOLD bales alone (before it, it
 *     re-costs them as it always did) and records a revaluation event;
 *   - the daily factory stock journal posts waste to Factory Waste and
 *     Write-off, revaluations to Factory Stock Revaluation, and only the rest
 *     to Production Variance;
 *   - a factory POS sale records the bales it took; its void restores exactly
 *     those bales, and FPOS-COGS is their cost;
 *   - the reviewed re-cost: preview, Owner-only apply of the reviewed hash,
 *     audited; it posts FACTORY-RECOST to Factory Stock Revaluation after the
 *     cut-over and nothing before; SOLD bales are never re-costed;
 *   - the factory net position values bales at cost, counts the bales reserved
 *     for unfinalized orders once, and lists those orders for information only.
 */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass };
});

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { factoryStockValuation } from "../server/services/accounting/perpetualInventory/factoryValuation";
import { syncFactoryStockJournalTx } from "../server/services/accounting/perpetualInventory/factoryStockJournal";
import { cascadeContainerCostChange } from "../server/services/factory/rawStockCostCascade";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { stockEntryBaleCost } from "../server/services/factory/baleCostBasis";
import { registerFactoryMixBatchCreateRoutes } from "../server/routes/factory/mix-batches/create";
import { registerBalesFinalizeRoutes } from "../server/routes/factory/bales/balesFinalizeRoutes";
import { registerBaleRecostRoutes } from "../server/routes/factory/bales/baleRecostRoutes";
import { registerFactoryStockEntryRoutes } from "../server/routes/factory/stock/stockEntryRoutes";
import { registerPosSaleWriteRoutes } from "../server/routes/factory/employee-pos/pos-financial/sale-write";
import { registerPosSaleDeleteRoutes } from "../server/routes/factory/employee-pos/pos-financial/sale-delete";
import { registerFactoryStockRemovalRoutes } from "../server/routes/factory/stock/stockRemovalRoutes";
import { registerEmployeeNetPositionRoutes } from "../server/routes/factory/employee-pos/employeeNetPositionRoutes";

const PREFIX = "w11fcb";
const today = new Date().toISOString().slice(0, 10);

type Handler = (req: unknown, res: unknown, next?: () => unknown) => Promise<unknown> | unknown;
const routes = new Map<string, Handler[]>();
const fakeApp = new Proxy(
  {},
  {
    get:
      (_target, method: string) =>
      (path: unknown, ...handlers: Handler[]) => {
        if (typeof path === "string") routes.set(`${method.toUpperCase()} ${path}`, handlers);
      },
  }
) as never;

let companyId: number;
let locationId: number;
let productId: number;
let audContainer: number;
let audNoRateContainer: number;
let usdContainer: number;
let customerId: number;
let supervisorId: string;

async function call(route: string, req: Record<string, any>) {
  const handlers = routes.get(route);
  if (!handlers) throw new Error(`route not registered: ${route}`);
  const [method, path] = route.split(" ");
  let statusCode = 200;
  let body: any;
  const res: Record<string, any> = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    set: () => res,
    setHeader: () => res,
  };
  const headers: Record<string, string> = { "x-client-date": today, ...(req.headers ?? {}) };
  const request = {
    method,
    path,
    params: {},
    query: {},
    body: {},
    get: (name: string) => headers[name.toLowerCase()],
    header: (name: string) => headers[name.toLowerCase()],
    ...req,
    headers,
    session: {
      factoryCompanyId: companyId,
      currentCompanyId: companyId,
      userId: "1",
      username: "owner",
      ...req.session,
    },
  };
  // Middleware (requireRole) then the handler.
  for (const [index, handler] of handlers.entries()) {
    let next = false;
    await handler(request, res, () => {
      next = true;
    });
    if (index < handlers.length - 1 && !next) break;
  }
  return { statusCode, body };
}

const one = async <T = any>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0] as T;
const all = async <T = any>(text: string, values: unknown[] = []) => (await pool.query(text, values)).rows as T[];

async function setCutover(active: boolean) {
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [companyId]);
  if (active) {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by)
       VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [companyId, today]
    );
  }
}

let baleSeq = 0;
async function bale(values: {
  status: string;
  weight: string;
  costPerKg: string;
  totalCost: string;
  mixBatchId?: number | null;
  product?: boolean;
}) {
  baleSeq += 1;
  return (
    await one<{ id: number }>(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status,
                                  mix_batch_id, product_id, erp_location_id, article_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        companyId,
        `${PREFIX}-B`,
        `${PREFIX}-R${baleSeq}`,
        values.weight,
        values.costPerKg,
        values.totalCost,
        values.status,
        values.mixBatchId ?? null,
        values.product === false ? null : productId,
        locationId,
        `${PREFIX}ART`,
      ]
    )
  ).id;
}

const baleCost = async (id: number) =>
  one<{ cost_per_kg: string; total_cost: string; status: string }>(
    `SELECT cost_per_kg::text, total_cost::text, status FROM factory_bales WHERE id = $1`,
    [id]
  );

beforeAll(async () => {
  await ensureFactoryCostBasisSchema(pool);
  // A run that failed half-way leaves its company behind.
  for (const leftover of await all<{ id: number }>(`SELECT id FROM companies WHERE code = $1`, [
    PREFIX.toUpperCase(),
  ])) {
    await cleanup(leftover.id);
  }
  for (const register of [
    registerFactoryMixBatchCreateRoutes,
    registerBalesFinalizeRoutes,
    registerBaleRecostRoutes,
    registerFactoryStockEntryRoutes,
    registerPosSaleWriteRoutes,
    registerPosSaleDeleteRoutes,
    registerFactoryStockRemovalRoutes,
    registerEmployeeNetPositionRoutes,
  ]) {
    register(fakeApp);
  }

  companyId = (
    await one(
      `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
      [PREFIX.toUpperCase()]
    )
  ).id;
  locationId = (
    await one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2::varchar, $2::text) RETURNING id`, [
      companyId,
      `${PREFIX}-LOC`,
    ])
  ).id;
  customerId = (
    await one(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`, [
      companyId,
      `${PREFIX}-CUST`,
    ])
  ).id;
  productId = (
    await one(
      `INSERT INTO factory_bale_products (company_id, code, name, article_code, production_price, selling_price)
       VALUES ($1, $2::varchar, $2::text, $3, '40.00', '60.00') RETURNING id`,
      [companyId, `${PREFIX}P`.toUpperCase(), `${PREFIX}ART`]
    )
  ).id;
  // A supplier with no locked rate yet: its containers' sources are priced at
  // the container's landed USD cost.
  const supplierId = (
    await one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      companyId,
      `${PREFIX} supplier`,
    ])
  ).id;
  const container = async (number: string, currency: string, fx: string) =>
    (
      await one(
        `INSERT INTO factory_containers (company_id, container_number, currency_code, fx_rate_to_usd, supplier_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, `${PREFIX}-${number}`, currency, fx, supplierId]
      )
    ).id;
  audContainer = await container("AUD", "AUD", "0.65");
  audNoRateContainer = await container("AUD-NR", "AUD", "1");
  usdContainer = await container("USD", "USD", "1");
  supervisorId = (
    await one(`INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`, [
      `${PREFIX}_supervisor`,
      await bcrypt.hash("supervisor-pass", 4),
    ])
  ).id;
  await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Owner')`, [
    supervisorId,
    companyId,
  ]);
  await pool.query(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, 1000, 0, 2.0, 1.3), ($1, $3, 1000, 0, 2.0, NULL), ($1, $4, 1000, 900, 1.0, 1.0)`,
    [companyId, audContainer, audNoRateContainer, usdContainer]
  );
}, 60000);

async function cleanup(companyId: number, supervisorId?: string) {
  // audit_log is append-only (wave 12): its rows go through the test-only helper.
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [companyId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query("SET LOCAL app.ledger_integrity_bypass = 'on'");
    const q = (text: string) => client.query(text, [companyId]);
    await q(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`);
    await q(`DELETE FROM accounting_posting_requests WHERE company_id = $1`);
    await q(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`);
    await q(`DELETE FROM vouchers WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sale_bales WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sale_items WHERE company_id = $1`);
    await q(`DELETE FROM factory_pos_sales WHERE company_id = $1`);
    await q(
      `DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`
    );
    await q(`DELETE FROM customer_orders WHERE company_id = $1`);
    for (const table of [
      "canonical_stock_movement_audit",
      "canonical_stock_movement_requests",
      "canonical_stock_movements",
      "factory_stock_value_events",
      "factory_bale_recost_runs",
      "factory_bale_production_attributions",
      "factory_daybook_entries",
    ]) {
      await q(`DELETE FROM ${table} WHERE company_id = $1`);
    }
    await q(`DELETE FROM user_company_roles WHERE company_id = $1`);
    await q(`DELETE FROM factory_bales WHERE company_id = $1`);
    await q(`DELETE FROM factory_pressing_batches WHERE company_id = $1`);
    await q(
      `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`
    );
    await q(`DELETE FROM factory_mix_batches WHERE company_id = $1`);
    await q(`DELETE FROM factory_raw_stock WHERE company_id = $1`);
    await q(`DELETE FROM factory_containers WHERE company_id = $1`);
    await q(`DELETE FROM factory_suppliers WHERE company_id = $1`);
    await q(`DELETE FROM financial_operation_requests WHERE company_id = $1`);
    await q(`DELETE FROM factory_bale_sequences WHERE company_id = $1`);
    await q(`DELETE FROM factory_bale_products WHERE company_id = $1`);
    await q(
      `DELETE FROM inventory_negative_layers WHERE location_id IN (SELECT id FROM locations WHERE company_id = $1)`
    ).catch(() => undefined);
    await q(`DELETE FROM inventory WHERE company_id = $1`);
    await q(`DELETE FROM stock_items WHERE company_id = $1`);
    await q(`DELETE FROM stock_groups WHERE company_id = $1`);
    await q(`DELETE FROM customer_balances WHERE company_id = $1`);
    await q(`UPDATE customers SET ledger_account_id = NULL WHERE company_id = $1`);
    await q(`DELETE FROM customers WHERE company_id = $1`);
    await q(`DELETE FROM ledger_accounts WHERE company_id = $1`);
    await q(`DELETE FROM locations WHERE company_id = $1`);
    await q(`DELETE FROM companies WHERE id = $1`);
    await client.query(`DELETE FROM users WHERE id = $1 OR username = $2`, [
      supervisorId ?? "",
      `${PREFIX}_supervisor`,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  await cleanup(companyId, supervisorId);
}, 60000);

describe("mix sources at their USD rate", () => {
  it("costs a mix from an AUD container at its USD landed cost, never the AUD cost", async () => {
    const { statusCode, body } = await call("POST /api/factory/mix-batches", {
      body: { sources: [{ containerId: audContainer, weightKg: "100" }] },
    });
    expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
    expect(body.unvalued).toBe(false);
    const mix = await one(`SELECT cost_per_kg::text, total_cost::text FROM factory_mix_batches WHERE id = $1`, [
      body.id,
    ]);
    expect(mix).toEqual({ cost_per_kg: "1.3000000", total_cost: "130.0000000" });
    const [source] = await all(`SELECT cost_per_kg::text FROM factory_mix_batch_sources WHERE mix_batch_id = $1`, [
      body.id,
    ]);
    expect(source.cost_per_kg).toBe("1.3000000");
  });

  it("records a mix unvalued before the cut-over and refuses it after when a source has no USD rate", async () => {
    const before = await call("POST /api/factory/mix-batches", {
      body: { sources: [{ containerId: audNoRateContainer, weightKg: "10" }] },
    });
    expect(before.statusCode).toBe(200);
    expect(before.body.unvalued).toBe(true);
    const mix = await one(`SELECT cost_per_kg::text, total_cost::text FROM factory_mix_batches WHERE id = $1`, [
      before.body.id,
    ]);
    expect(mix).toEqual({ cost_per_kg: "0.0000000", total_cost: "0.0000000" });

    await setCutover(true);
    try {
      const after = await call("POST /api/factory/mix-batches", {
        body: { sources: [{ containerId: audNoRateContainer, weightKg: "10" }] },
      });
      expect(after.statusCode).toBe(409);
      expect(after.body.code).toBe("FACTORY_SOURCE_NO_USD_RATE");
    } finally {
      await setCutover(false);
    }
  });
});

describe("bale cost from pressing and stock entry", () => {
  it("prices pressed bales at the mix's USD cost: WIP relieved = finished goods added; the ERP mirror at rate 0", async () => {
    const mixId = (
      await one(
        `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, used_kg, cost_per_kg, total_cost, status)
         VALUES ($1, $2, 100, 0, 1.3, 130, 'ACTIVE') RETURNING id`,
        [companyId, `${PREFIX}-PRESS`]
      )
    ).id;
    const pressingId = (
      await one(
        `INSERT INTO factory_pressing_batches (company_id, product_id, expected_count) VALUES ($1, $2, 2) RETURNING id`,
        [companyId, productId]
      )
    ).id;
    const bales: number[] = [];
    for (const index of [1, 2]) {
      bales.push(
        (
          await one(
            `INSERT INTO factory_bales (company_id, pressing_batch_id, product_id, bale_code, reference_number,
                                        article_code, weight_kg, status)
             VALUES ($1, $2, $3, $4, $5, $6, 25, 'PENDING_PRESSING') RETURNING id`,
            [companyId, pressingId, productId, `${PREFIX}-PB`, `${PREFIX}-P${index}`, `${PREFIX}ART`]
          )
        ).id
      );
    }
    const valuationBefore = await factoryStockValuation(db, companyId);
    const { statusCode, body } = await call("POST /api/factory/finalize", {
      session: { currentRole: "Admin" },
      body: { pressingBatchId: pressingId, scannedBaleIds: bales, erpLocationId: locationId, mixBatchId: mixId },
    });
    expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
    for (const id of bales) {
      expect(await baleCost(id)).toEqual({ cost_per_kg: "1.3000000", total_cost: "32.5000000", status: "IN_STOCK" });
    }
    const valuationAfter = await factoryStockValuation(db, companyId);
    const wipRelieved = valuationBefore.wip.minus(valuationAfter.wip);
    const finishedAdded = valuationAfter.finished.minus(valuationBefore.finished);
    expect(wipRelieved.toFixed(2)).toBe("65.00");
    expect(finishedAdded.toFixed(2)).toBe("65.00");

    const mirror = await one(
      `SELECT i.quantity::text AS quantity, i.total_value::text AS value
         FROM inventory i JOIN stock_items si ON si.id = i.stock_item_id
        WHERE i.location_id = $1 AND si.code = $2`,
      [locationId, `${PREFIX}ART`]
    );
    expect(Number(mirror.quantity)).toBe(2);
    expect(Number(mirror.value)).toBe(0);
  });

  it("costs a stock-entry bale with no mix at its production price per bale", async () => {
    const { statusCode, body } = await call("POST /api/factory/stock-entry", {
      body: { items: [{ productId, qty: 2, weightPerBaleKg: "25" }], erpLocationId: locationId, entryDate: today },
    });
    expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
    expect(body.bales).toHaveLength(2);
    for (const created of body.bales) {
      expect(await baleCost(created.id)).toEqual({
        cost_per_kg: "1.6000000",
        total_cost: "40.0000000",
        status: "IN_STOCK",
      });
    }
    // The old rule was production price × kg: 25 × 40 = 1,000 per bale.
    expect(stockEntryBaleCost("40", "25").totalCost.toFixed(2)).toBe("40.00");
    expect(stockEntryBaleCost("40", "25", "HMD16-X").totalCost.toFixed(2)).toBe("0.00");
  });
});

describe("factory POS sale bales", () => {
  it("records the bales a sale took and its void restores exactly those", async () => {
    // A SOLD bale of the same product at the location with a higher id: the old
    // void re-opened "the most recent SOLD bale", which would be this one.
    const sale = await call("POST /api/factory/pos/sale", {
      body: {
        locationId,
        // Wave 8.4 continuation: an unpaid credit sale needs a customer (its
        // receivable is posted to the customer's ledger).
        customerId,
        paymentType: "CREDIT",
        depositAmount: "0",
        items: [{ productId, productName: "P", quantity: 1, unitPrice: "60" }],
        txDate: today,
        clientRequestId: `${PREFIX}-sale-1`,
      },
    });
    expect({ statusCode: sale.statusCode, message: sale.body?.message }).toEqual({
      statusCode: 200,
      message: undefined,
    });
    const recorded = await all<{ bale_id: number }>(`SELECT bale_id FROM factory_pos_sale_bales WHERE sale_id = $1`, [
      sale.body.id,
    ]);
    expect(recorded).toHaveLength(1);
    const taken = recorded[0].bale_id;
    expect((await baleCost(taken)).status).toBe("SOLD");
    const otherSold = await bale({ status: "SOLD", weight: "25", costPerKg: "1.3", totalCost: "32.5" });

    const voided = await call("DELETE /api/factory/pos/sales/:id", { params: { id: String(sale.body.id) } });
    expect(voided.statusCode).toBe(200);
    expect((await baleCost(taken)).status).toBe("IN_STOCK");
    expect((await baleCost(otherSold)).status).toBe("SOLD");
    expect(await all(`SELECT 1 FROM factory_pos_sale_bales WHERE sale_id = $1`, [sale.body.id])).toEqual([]);
    await pool.query(`UPDATE factory_bales SET status = 'REMOVED' WHERE id = $1`, [otherSold]);
  });
});

describe("after the cut-over", () => {
  let cascadeMix: number;
  let inStock: number;
  let sold: number;

  beforeAll(async () => {
    cascadeMix = (
      await one(
        `INSERT INTO factory_mix_batches (company_id, batch_code, total_weight_kg, used_kg, cost_per_kg, total_cost, status)
         VALUES ($1, $2, 20, 20, 1.0, 20, 'CLOSED') RETURNING id`,
        [companyId, `${PREFIX}-CASC`]
      )
    ).id;
    await pool.query(
      `INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, source_type, weight_kg, cost_per_kg, total_cost)
       VALUES ($1, $2, 'CONTAINER_DIRECT', 20, 1.0, 20)`,
      [cascadeMix, usdContainer]
    );
    inStock = await bale({ status: "IN_STOCK", weight: "10", costPerKg: "1", totalCost: "10", mixBatchId: cascadeMix });
    sold = await bale({ status: "SOLD", weight: "10", costPerKg: "1", totalCost: "10", mixBatchId: cascadeMix });
  });

  it("re-costs SOLD bales before the cut-over, as it always did", async () => {
    await db.transaction((tx) =>
      cascadeContainerCostChange(
        tx,
        { companyId, containerId: usdContainer, newCostPerKg: 1.5, newCostPerKgUsd: 1.5 },
        { includeCompletedBatches: true }
      )
    );
    expect((await baleCost(inStock)).total_cost).toBe("15.0000000");
    expect((await baleCost(sold)).total_cost).toBe("15.0000000");
    expect(await all(`SELECT 1 FROM factory_stock_value_events WHERE company_id = $1`, [companyId])).toEqual([]);
  });

  it("leaves SOLD bales alone after it, and tags the revaluation", async () => {
    await setCutover(true);
    await db.transaction((tx) =>
      cascadeContainerCostChange(
        tx,
        { companyId, containerId: usdContainer, newCostPerKg: 2, newCostPerKgUsd: 2 },
        { includeCompletedBatches: true }
      )
    );
    expect((await baleCost(inStock)).total_cost).toBe("20.0000000");
    expect((await baleCost(sold)).total_cost).toBe("15.0000000");
    // Raw: 100 kg left × (2 − 1.5) = 50; the in-stock bale: 20 − 15 = 5.
    const events = await all(
      `SELECT kind, amount::text AS amount FROM factory_stock_value_events WHERE company_id = $1 ORDER BY id`,
      [companyId]
    );
    expect(events).toEqual([{ kind: "REVALUATION", amount: "55.0000000" }]);
  });

  it("splits the daily factory stock journal by source", async () => {
    const wasted = await bale({ status: "IN_STOCK", weight: "10", costPerKg: "3", totalCost: "30" });
    const removal = await call("POST /api/factory/stock-entry/remove", {
      body: {
        baleIds: [wasted],
        supervisorUsername: `${PREFIX}_supervisor`,
        supervisorPassword: "supervisor-pass",
        reason: "damaged",
      },
    });
    expect({ statusCode: removal.statusCode, message: removal.body?.message }).toEqual({
      statusCode: 200,
      message: undefined,
    });
    expect((await baleCost(wasted)).status).toBe("DELETED");
    const result = await db.transaction((tx) => syncFactoryStockJournalTx(tx, companyId, today));
    expect(result.voucherId).not.toBeNull();
    expect(result.explained).toEqual({
      FACTORY_WASTE_WRITE_OFF: "30.00",
      FACTORY_REVALUATION: "-55.00",
      FACTORY_MATERIAL_PRICE_VARIANCE: "0.00",
    });
    const lines = await all(
      `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [result.voucherId]
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        { code: "FACTORY_WASTE_WRITE_OFF", d: "30.00", c: "0.00" },
        { code: "FACTORY_REVALUATION", d: "0.00", c: "55.00" },
      ])
    );
    // Production Variance takes only what no tagged change explains.
    const moved = result.accounts.reduce((sum, account) => sum + Number(account.amount), 0);
    const remainder = Number(result.received) - moved - 30 + 55;
    expect(Number(result.variance)).toBeCloseTo(remainder, 2);
    // The events now belong to today's journal; a second run the same day replaces it with the same split.
    const again = await db.transaction((tx) => syncFactoryStockJournalTx(tx, companyId, today));
    expect(again.explained).toEqual(result.explained);
  });

  it("posts FPOS-COGS for exactly the bales the sale took", async () => {
    const sale = await call("POST /api/factory/pos/sale", {
      body: {
        locationId,
        // Wave 8.4 continuation: an unpaid credit sale needs a customer (its
        // receivable is posted to the customer's ledger).
        customerId,
        paymentType: "CREDIT",
        depositAmount: "0",
        items: [{ productId, productName: "P", quantity: 1, unitPrice: "60" }],
        txDate: today,
        clientRequestId: `${PREFIX}-sale-2`,
      },
    });
    expect(sale.statusCode).toBe(200);
    const [recorded] = await all<{ bale_id: number }>(`SELECT bale_id FROM factory_pos_sale_bales WHERE sale_id = $1`, [
      sale.body.id,
    ]);
    const cost = (await baleCost(recorded.bale_id)).total_cost;
    const cogs = await all(
      `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = $1 AND v.voucher_number = $2 ORDER BY ve.id`,
      [companyId, `FPOS-COGS-${sale.body.id}`]
    );
    const amount = Number(cost).toFixed(2);
    expect(cogs).toEqual([
      { code: "COGS", d: amount, c: "0.00" },
      { code: "FACTORY_FINISHED_GOODS", d: "0.00", c: amount },
    ]);
    const voided = await call("DELETE /api/factory/pos/sales/:id", { params: { id: String(sale.body.id) } });
    expect(voided.statusCode).toBe(200);
    expect((await baleCost(recorded.bale_id)).status).toBe("IN_STOCK");
    expect(
      await all(`SELECT 1 FROM vouchers WHERE company_id = $1 AND voucher_number = $2`, [
        companyId,
        `FPOS-COGS-${sale.body.id}`,
      ])
    ).toEqual([]);
  });

  afterAll(async () => {
    await setCutover(false);
  });
});

describe("the reviewed bale re-cost", () => {
  it("is Owner-only, applies only the reviewed plan, never re-costs SOLD bales, and posts nothing before the cut-over", async () => {
    // A stock-entry bale costed by the old rule (production price × kg = 1,000).
    const stale = await bale({ status: "IN_STOCK", weight: "25", costPerKg: "40", totalCost: "1000" });
    const staleSold = await bale({ status: "SOLD", weight: "25", costPerKg: "40", totalCost: "1000" });

    const preview = await call("GET /api/factory/bale-cost/recost-preview", { user: { role: "Owner" } });
    expect(preview.statusCode).toBe(200);
    expect(preview.body.perpetual).toBe(false);
    const line = preview.body.bales.find((row: { id: number }) => row.id === stale);
    expect(line).toMatchObject({
      basis: "production-price",
      oldTotalCost: "1000.0000000",
      newTotalCost: "40.0000000",
      newCostPerKg: "1.6000000",
      change: "-960.00",
    });
    expect(preview.body.bales.some((row: { id: number }) => row.id === staleSold)).toBe(false);

    const asAdmin = await call("POST /api/factory/bale-cost/recost-apply", {
      user: { role: "Admin" },
      body: { confirm: true, planHash: preview.body.planHash },
    });
    expect(asAdmin.statusCode).toBe(403);
    const wrongHash = await call("POST /api/factory/bale-cost/recost-apply", {
      user: { role: "Owner" },
      body: { confirm: true, planHash: "0".repeat(64) },
    });
    expect(wrongHash).toMatchObject({ statusCode: 409, body: { code: "PLAN_CHANGED" } });

    const applied = await call("POST /api/factory/bale-cost/recost-apply", {
      user: { role: "Owner" },
      body: { confirm: true, planHash: preview.body.planHash },
    });
    expect({ statusCode: applied.statusCode, message: applied.body?.message }).toEqual({
      statusCode: 200,
      message: undefined,
    });
    expect(applied.body.voucherId).toBeNull();
    expect((await baleCost(stale)).total_cost).toBe("40.0000000");
    expect((await baleCost(staleSold)).total_cost).toBe("1000.0000000");
    const run = await one(`SELECT plan_hash, voucher_id FROM factory_bale_recost_runs WHERE id = $1`, [
      applied.body.runId,
    ]);
    expect(run).toEqual({ plan_hash: preview.body.planHash, voucher_id: null });
    const audit = await all(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = 'factory_bales' AND record_id = $2`,
      [companyId, applied.body.runId]
    );
    expect(audit).toHaveLength(1);
  });

  it("posts the value change to Factory Stock Revaluation after the cut-over", async () => {
    const stale = await bale({ status: "IN_STOCK", weight: "25", costPerKg: "4", totalCost: "100" });
    await setCutover(true);
    try {
      const preview = await call("GET /api/factory/bale-cost/recost-preview", { user: { role: "Owner" } });
      expect(preview.body.perpetual).toBe(true);
      const applied = await call("POST /api/factory/bale-cost/recost-apply", {
        user: { role: "Owner" },
        body: { confirm: true, planHash: preview.body.planHash },
      });
      expect(applied.statusCode).toBe(200);
      expect((await baleCost(stale)).total_cost).toBe("40.0000000");
      const lines = await all(
        `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
           FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          WHERE v.company_id = $1 AND v.voucher_number = $2 ORDER BY ve.id`,
        [companyId, `FACTORY-RECOST-${companyId}-${applied.body.runId}`]
      );
      const total = Number(preview.body.totals.total);
      expect(total).toBeLessThan(0);
      expect(lines).toEqual(
        expect.arrayContaining([
          { code: "FACTORY_FINISHED_GOODS", d: "0.00", c: (-Number(preview.body.totals.finishedChange)).toFixed(2) },
          { code: "FACTORY_REVALUATION", d: (-total).toFixed(2), c: "0.00" },
        ])
      );
    } finally {
      await setCutover(false);
    }
  });
});

describe("factory net position", () => {
  it("values bales at cost, counts bales reserved for unfinalized orders once, and lists the orders for information", async () => {
    const reserved = await bale({ status: "RESERVED_FOR_ORDER", weight: "25", costPerKg: "3.08", totalCost: "77" });
    const orderId = (
      await one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status, grand_total)
         VALUES ($1, $2, $3, 'PENDING_VERIFICATION', 500) RETURNING id`,
        [companyId, customerId, today]
      )
    ).id;
    await pool.query(
      `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
       VALUES ($1, $2, 'R', $3, 25, 500)`,
      [orderId, reserved, locationId]
    );

    const expected = await one<{ cost: string }>(
      `SELECT COALESCE(SUM(total_cost), 0)::text AS cost FROM factory_bales
        WHERE company_id = $1 AND status IN ('IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')`,
      [companyId]
    );
    const { statusCode, body } = await call("GET /api/factory/net-position", { query: { asOf: today } });
    expect({ statusCode, message: body?.message }).toEqual({ statusCode: 200, message: undefined });
    expect(body.inventoryValue).toBeCloseTo(Number(expected.cost), 2);
    expect(body.reservedBales).toEqual({ count: 1, cost: 77 });
    expect(body.inventoryValueBasis).toBe("bale-cost");

    const orderLine = body.notInLedger.lines.find((line: { code: string }) => line.code === "PENDING_ORDERS");
    expect(orderLine).toMatchObject({ value: 500, informational: true, count: 1 });
    const counted = body.notInLedger.lines
      .filter((line: { informational?: boolean }) => !line.informational)
      .reduce((sum: number, line: { value: number }) => sum + line.value, 0);
    expect(body.notInLedger.total).toBeCloseTo(counted, 2);
    const accountsTotal = body.forUs.accounts.reduce((sum: number, a: { value: number }) => sum + a.value, 0);
    expect(body.forUsTotal).toBeCloseTo(accountsTotal, 2);
  });
});
