/**
 * Wave 11 follow-up 10: factory value changes that are not production are
 * tagged factory stock value events, so the daily factory stock journal posts
 * them to their own account instead of Production Variance:
 *
 *   - deducting kg from received raw stock is a write-off (WASTE), and
 *     restoring the deduction reverses it;
 *   - finalizing a mix writes its remaining kg off (WASTE);
 *   - deleting a mix undoes its creation (MATERIAL_PRICE, as the create);
 *   - a carry-forward moves the leftover kg at exactly the closed mix's cost
 *     per kg, so it adds no valuation drift (only the consumed kg leave).
 *
 * Before the cut-over nothing is recorded.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, requireAuth: pass, requireNonPOS: pass };
});

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { factoryStockValuation } from "../server/services/accounting/perpetualInventory/factoryValuation";
import { ensureFactoryCostBasisSchema } from "../server/services/factory/factoryCostBasisSchema";
import { registerRawStockReceiptRoutes } from "../server/routes/factory/raw-stock/rawStockReceiptRoutes";
import { registerRawStockAdjRoutes } from "../server/routes/factory/raw-stock/rawStockAdjRoutes";
import { registerFactoryMixBatchFinalizeDeleteRoutes } from "../server/routes/factory/mix-batches/finalize-delete";
import { registerFactoryMixBatchConsumeRoutes } from "../server/routes/factory/mix-batches/consume";

const PREFIX = "w11fuf";
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
let supplierId: number;
let containerId: number;

async function call(route: string, req: Record<string, unknown> = {}) {
  const handlers = routes.get(route);
  if (!handlers) throw new Error(`route not registered: ${route}`);
  let statusCode = 200;
  let body: unknown;
  const res: Record<string, unknown> = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
  };
  const headers: Record<string, string> = { "x-client-date": today };
  const request = {
    params: {},
    query: {},
    body: {},
    get: (name: string) => headers[name.toLowerCase()],
    header: (name: string) => headers[name.toLowerCase()],
    headers,
    ...req,
    session: { factoryCompanyId: companyId, currentCompanyId: companyId, userId: "1", username: "owner" },
  };
  for (const [index, handler] of handlers.entries()) {
    let next = false;
    await handler(request, res, () => {
      next = true;
    });
    if (index < handlers.length - 1 && !next) break;
  }
  return { statusCode, body: body as Record<string, unknown> };
}

const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await pool.query(text, values)).rows[0] as T;

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

async function events() {
  return (
    await pool.query<{ kind: string; amount: string; source_type: string }>(
      `SELECT kind, amount::numeric(20,2)::text AS amount, source_type FROM factory_stock_value_events
        WHERE company_id = $1 ORDER BY id`,
      [companyId]
    )
  ).rows.map((row) => [row.kind, row.amount, row.source_type]);
}

const valuationTotal = async () => {
  const valuation = await factoryStockValuation(db, companyId);
  return valuation.raw.plus(valuation.wip).plus(valuation.finished).toFixed(2);
};

let mixSeq = 0;
async function mix(totalKg: string, usedKg: string, costPerKg: string, sourceKg?: string) {
  mixSeq += 1;
  const { id } = await one<{ id: number }>(
    `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, total_weight_kg, used_kg, cost_per_kg, total_cost, status)
     VALUES ($1, $2::varchar, $2::text, $3, $4, $5, $3::numeric * $5::numeric, 'ACTIVE') RETURNING id`,
    [companyId, `${PREFIX}-M${mixSeq}`, totalKg, usedKg, costPerKg]
  );
  if (sourceKg) {
    await pool.query(
      `INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, supplier_id, weight_kg, cost_per_kg, total_cost)
       VALUES ($1, $2, $3, $4, $5, $4::numeric * $5::numeric)`,
      [id, containerId, supplierId, sourceKg, costPerKg]
    );
    await pool.query(`UPDATE factory_raw_stock SET used_kg = used_kg + $2::numeric WHERE container_id = $1`, [
      containerId,
      sourceKg,
    ]);
  }
  return id;
}

async function cleanup(id: number) {
  // audit_log is append-only (wave 12): its rows go through the test-only helper.
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query("SET LOCAL app.ledger_integrity_bypass = 'on'");
    const q = (text: string) => client.query(text, [id]);
    await q(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`);
    for (const table of [
      "factory_stock_value_events",
      "factory_daily_usages",
      "factory_daybook_entries",
      "factory_raw_material_adjustments",
    ]) {
      await q(`DELETE FROM ${table} WHERE company_id = $1`);
    }
    await q(
      `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`
    );
    await q(`DELETE FROM factory_mix_batches WHERE company_id = $1`);
    await q(`DELETE FROM factory_raw_stock WHERE company_id = $1`);
    await q(`DELETE FROM factory_containers WHERE company_id = $1`);
    await q(`DELETE FROM factory_suppliers WHERE company_id = $1`);
    await q(`DELETE FROM companies WHERE id = $1`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await ensureFactoryCostBasisSchema(pool);
  for (const leftover of (
    await pool.query<{ id: number }>(`SELECT id FROM companies WHERE code = $1`, [PREFIX.toUpperCase()])
  ).rows) {
    await cleanup(leftover.id);
  }
  for (const register of [
    registerRawStockReceiptRoutes,
    registerRawStockAdjRoutes,
    registerFactoryMixBatchFinalizeDeleteRoutes,
    registerFactoryMixBatchConsumeRoutes,
  ]) {
    register(fakeApp);
  }
  companyId = (
    await one<{ id: number }>(
      `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
      [PREFIX.toUpperCase()]
    )
  ).id;
  supplierId = (
    await one<{ id: number }>(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
      companyId,
      `${PREFIX} supplier`,
    ])
  ).id;
  containerId = (
    await one<{ id: number }>(
      `INSERT INTO factory_containers (company_id, container_number, currency_code, fx_rate_to_usd, supplier_id)
       VALUES ($1, $2, 'USD', '1', $3) RETURNING id`,
      [companyId, `${PREFIX}-C1`, supplierId]
    )
  ).id;
  await pool.query(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, 1000, 0, 1.0, 1.0)`,
    [companyId, containerId]
  );
}, 60_000);

afterAll(async () => {
  await cleanup(companyId);
}, 60_000);

describe("before the cut-over", () => {
  it("records no event for a raw-stock deduction", async () => {
    await setCutover(false);
    const deducted = await call("POST /api/factory/raw-stock/deduct-received", { body: { supplierId, kg: "10" } });
    expect(deducted.statusCode, JSON.stringify(deducted.body)).toBe(200);
    expect(await events()).toEqual([]);
  });
});

describe("after the cut-over", () => {
  beforeAll(async () => {
    await setCutover(true);
  });

  it("tags a raw-stock deduction and its restore as WASTE", async () => {
    const before = await valuationTotal();
    const deducted = await call("POST /api/factory/raw-stock/deduct-received", { body: { supplierId, kg: "100" } });
    expect(deducted.statusCode, JSON.stringify(deducted.body)).toBe(200);
    expect(Number(await valuationTotal()) - Number(before)).toBe(-100);
    expect(await events()).toEqual([["WASTE", "-100.00", "factory-raw-deduct-received"]]);

    const { id } = await one<{ id: number }>(
      `SELECT id FROM factory_raw_material_adjustments WHERE company_id = $1 AND type = 'DEDUCT' AND kg = 100`,
      [companyId]
    );
    const restored = await call("DELETE /api/factory/raw-stock/adjustments/:id", { params: { id: String(id) } });
    expect(restored.statusCode, JSON.stringify(restored.body)).toBe(200);
    expect((await events()).at(-1)).toEqual(["WASTE", "100.00", "factory-raw-deduct-restore"]);
    expect(await valuationTotal()).toBe(before);
  });

  it("tags finalizing a mix as WASTE for its remaining kg", async () => {
    const id = await mix("100", "40", "2");
    const finalized = await call("POST /api/factory/mix-batches/:id/finalize", { params: { id: String(id) } });
    expect(finalized.statusCode, JSON.stringify(finalized.body)).toBe(200);
    expect((await events()).at(-1)).toEqual(["WASTE", "-120.00", "factory-mix-batch-finalize"]);
  });

  it("tags deleting a mix as MATERIAL_PRICE (the reverse of its create)", async () => {
    // 200 kg of raw at 1.00 went into a mix costed at 1.50.
    const id = await mix("200", "0", "1.5", "200");
    const deleted = await call("DELETE /api/factory/mix-batches/:id", { params: { id: String(id) } });
    expect(deleted.statusCode, JSON.stringify(deleted.body)).toBe(200);
    // Raw comes back +200.00, the mix's 300.00 of work in progress goes.
    expect((await events()).at(-1)).toEqual(["MATERIAL_PRICE", "-100.00", "factory-mix-batch-delete"]);
  });

  it("carries a mix forward at exactly its cost per kg (no drift, no event)", async () => {
    const id = await mix("10", "0", "0.3333333");
    const eventsBefore = (await events()).length;
    const before = toCents(await valuationTotal());
    const consumed = await call("POST /api/factory/mix-batches/consume", {
      body: { usages: [{ batchId: id, kgUsed: 3.3 }], usedDate: today },
    });
    expect(consumed.statusCode, JSON.stringify(consumed.body)).toBe(200);
    const carried = await one<{ total_weight_kg: string; cost_per_kg: string }>(
      `SELECT total_weight_kg::text, cost_per_kg::text FROM factory_mix_batches WHERE carry_forward_from_id = $1`,
      [id]
    );
    expect(carried).toEqual({ total_weight_kg: "6.700", cost_per_kg: "0.3333333" });
    // Only the consumed 3.3 kg leave the valuation (production, untagged).
    expect(before - toCents(await valuationTotal())).toBe(Math.round(3.3 * 0.3333333 * 100));
    expect((await events()).length).toBe(eventsBefore);
  });
});

function toCents(value: string): number {
  return Math.round(Number(value) * 100);
}
