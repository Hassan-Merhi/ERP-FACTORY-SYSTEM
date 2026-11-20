/**
 * Opening-balance raw stock: bale assignment (V5) and the bulk used-kg
 * recalculation, driven over real HTTP against PostgreSQL inside one
 * rolled-back transaction per test.
 *
 * Pinned: every refusal leaves bales, raw stock and mix batches untouched;
 * supplier-linked assignment uses the persisted supplier rate without
 * changing it; the recalculation is a dry run unless { confirm: true }.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let containerSeq = 0;

interface ObOptions {
  supplierRate?: string | null;
  withSupplier?: boolean;
  directUsd?: string | null;
  status?: string;
}

async function openingBalance(w: FactoryWorld, opts: ObOptions = {}) {
  let supplierId: number | null = null;
  if (opts.withSupplier) {
    supplierId = await w.one(
      `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd)
       VALUES ($1, $2, $3) RETURNING id`,
      [w.companyId, `${w.tag} supplier ${++containerSeq}`, opts.supplierRate ?? null]
    );
  }
  const containerId = await w.one(
    `INSERT INTO factory_containers (company_id, container_number, status, supplier_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [w.companyId, `${w.tag}-OB${++containerSeq}`, opts.status ?? "OPENING_BALANCE", supplierId]
  );
  const rawStockId = await w.one(
    `INSERT INTO factory_raw_stock (company_id, container_id, quantity_kg, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, 1000, 1000, 0, 1, $3) RETURNING id`,
    [w.companyId, containerId, opts.directUsd === undefined ? "0.500000" : opts.directUsd]
  );
  return { supplierId, containerId, rawStockId };
}

async function bale(w: FactoryWorld, weight: string, status = "IN_STOCK") {
  return w.one(
    `INSERT INTO factory_bales (company_id, reference_number, status, weight_kg)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [w.companyId, `${w.tag}-B${Math.floor(Math.random() * 1e9)}`, status, weight]
  );
}

const assign = (w: FactoryWorld, rawStockId: number | string, baleIds: unknown) =>
  w.agent.post(`/api/factory/raw-stock/${rawStockId}/assign-to-bales`).send({ baleIds });

async function untouched(w: FactoryWorld, rawStockId: number, baleIds: number[]) {
  const [rs] = await w.q(`SELECT used_kg::text AS used FROM factory_raw_stock WHERE id = $1`, [rawStockId]);
  expect(Number(rs.used)).toBe(0);
  const linked = await w.q(`SELECT id FROM factory_bales WHERE id = ANY($1) AND mix_batch_id IS NOT NULL`, [baleIds]);
  expect(linked).toEqual([]);
  const batches = await w.q(`SELECT id FROM factory_mix_batches WHERE company_id = $1`, [w.companyId]);
  expect(batches).toEqual([]);
}

describe("POST /api/factory/raw-stock/:id/assign-to-bales refusals", () => {
  it("rejects a bad id and malformed bale lists before touching the database", async () => {
    await withFactoryWorld(async (w) => {
      expect((await assign(w, "abc", [1])).status).toBe(400);
      for (const bad of [undefined, [], [0], [1.5], [3, 3], "1"]) {
        const res = await assign(w, 1, bad);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/unique positive integers/);
      }
    });
  });

  it("404s for raw stock that is not opening balance or belongs to another company", async () => {
    await withFactoryWorld(async (w) => {
      const { rawStockId } = await openingBalance(w, { status: "RECEIVED" });
      const b = await bale(w, "10");
      const res = await assign(w, rawStockId, [b]);
      expect(res.status).toBe(404);
      await untouched(w, rawStockId, [b]);
      expect((await assign(w, 999999999, [b])).status).toBe(404);
    });
  });

  it("409s when a bale is missing or already linked / not IN_STOCK", async () => {
    await withFactoryWorld(async (w) => {
      const { rawStockId } = await openingBalance(w);
      const b = await bale(w, "10");
      const missing = await assign(w, rawStockId, [b, 999999999]);
      expect(missing.status).toBe(409);
      expect(missing.body.message).toMatch(/no longer exist/);
      const sold = await bale(w, "10", "SOLD");
      const res = await assign(w, rawStockId, [b, sold]);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(`Bale ${sold} is no longer an unlinked IN_STOCK bale`);
      await untouched(w, rawStockId, [b, sold]);
    });
  });

  it("409s when the supplier has no valid persisted rate", async () => {
    await withFactoryWorld(async (w) => {
      for (const supplierRate of [null, "-1"]) {
        const { rawStockId } = await openingBalance(w, { withSupplier: true, supplierRate });
        const b = await bale(w, "10");
        const res = await assign(w, rawStockId, [b]);
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/no valid persisted authoritative USD/);
        await untouched(w, rawStockId, [b]);
        await w.q(`UPDATE factory_containers SET status = 'CLOSED' WHERE company_id = $1`, [w.companyId]);
      }
    });
  });

  it("409s when a direct source has no or a negative USD cost, 400 for zero-weight bales", async () => {
    await withFactoryWorld(async (w) => {
      const noUsd = await openingBalance(w, { directUsd: null });
      const b1 = await bale(w, "10");
      const r1 = await assign(w, noUsd.rawStockId, [b1]);
      expect(r1.status).toBe(409);
      expect(r1.body.message).toMatch(/Resolve its FX\/cost/);
      await untouched(w, noUsd.rawStockId, [b1]);

      const negative = await openingBalance(w, { directUsd: "-0.1" });
      const r2 = await assign(w, negative.rawStockId, [b1]);
      expect(r2.status).toBe(409);
      expect(r2.body.message).toMatch(/invalid direct USD cost/);

      const zeroOk = await openingBalance(w);
      const empty = await bale(w, "0");
      const r3 = await assign(w, zeroOk.rawStockId, [empty]);
      expect(r3.status).toBe(400);
      expect(r3.body.message).toMatch(/no positive weight/);
      await untouched(w, zeroOk.rawStockId, [empty]);
    });
  });
});

describe("POST /api/factory/raw-stock/:id/assign-to-bales valid request", () => {
  // Known bug (pinned): the batch INSERT binds $2 to both batch_code
  // (varchar) and batch_number (text), which PostgreSQL rejects with
  // "inconsistent types deduced for parameter $2". Every otherwise valid
  // assignment therefore rolls back with 500 and writes nothing.
  it("rolls back with 500 and leaves bales, raw stock and supplier rate unchanged", async () => {
    await withFactoryWorld(async (w) => {
      const direct = await openingBalance(w);
      const b1 = await bale(w, "10");
      const b2 = await bale(w, "30");
      const res = await assign(w, direct.rawStockId, [b2, b1]);
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/inconsistent types deduced for parameter \$2/);
      await untouched(w, direct.rawStockId, [b1, b2]);

      const supplied = await openingBalance(w, { withSupplier: true, supplierRate: "0.250000" });
      const b3 = await bale(w, "8");
      expect((await assign(w, supplied.rawStockId, [b3])).status).toBe(500);
      await untouched(w, supplied.rawStockId, [b3]);
      const [s] = await w.q(
        `SELECT current_raw_material_cost_per_kg_usd::text AS r FROM factory_suppliers WHERE id = $1`,
        [supplied.supplierId]
      );
      expect(Number(s.r)).toBe(0.25);
      const audit = await w.q(
        `SELECT id FROM audit_log WHERE company_id = $1 AND action = 'opening_balance_assign_to_bales'`,
        [w.companyId]
      );
      expect(audit).toEqual([]);
    });
  });
});

const recalc = (w: FactoryWorld, body: Record<string, unknown> = {}) =>
  w.agent.post("/api/factory/raw-stock/recalculate-used").send(body);

describe("POST /api/factory/raw-stock/recalculate-used", () => {
  it("refuses non-Admin roles at the maintenance gate and answers empty when there is no raw stock", async () => {
    await withFactoryWorld(async (w) => {
      expect(await recalc(w).then((r) => r.body)).toEqual({ updated: 0, dryRun: true, changes: [] });
      await w.setRole("Manager");
      const res = await recalc(w, { confirm: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PRIVILEGED_MAINTENANCE_ROLE_REQUIRED");
    });
  });

  it("previews by default, then applies only on confirm and excludes deleted batches", async () => {
    await withFactoryWorld(async (w) => {
      const { rawStockId, containerId } = await openingBalance(w, { withSupplier: true, supplierRate: "0.3" });
      await openingBalance(w); // a second, already-consistent row (used 0, no sources)
      const live = await w.one(
        `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, status) VALUES ($1, $2, $3, 'COMPLETED') RETURNING id`,
        [w.companyId, `${w.tag}-LIVE`, `${w.tag}-LIVE`]
      );
      const dead = await w.one(
        `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, status) VALUES ($1, $2, $3, 'DELETED') RETURNING id`,
        [w.companyId, `${w.tag}-DEAD`, `${w.tag}-DEAD`]
      );
      for (const [batch, kg] of [
        [live, "120.5"],
        [dead, "70"],
      ] as const) {
        await w.q(`INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, weight_kg) VALUES ($1, $2, $3)`, [
          batch,
          containerId,
          kg,
        ]);
      }

      const preview = await recalc(w);
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ dryRun: true, wouldUpdate: 1 });
      expect(preview.body.changes[0]).toMatchObject({
        rawStockId,
        oldUsedKg: "0.000",
        correctedUsedKg: "120.500",
        validSourceCount: 1,
        excludedDeletedSourceCount: 1,
        excludedDeletedSourceWeightKg: "70.000",
      });
      expect(preview.body.summary.excludedDeletedSourceWeightKg).toBe("70.000");
      const [before] = await w.q(`SELECT used_kg::text AS used FROM factory_raw_stock WHERE id = $1`, [rawStockId]);
      expect(Number(before.used)).toBe(0);

      const applied = await recalc(w, { confirm: true });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ dryRun: false, updated: 1 });
      const [after] = await w.q(`SELECT used_kg::text AS used FROM factory_raw_stock WHERE id = $1`, [rawStockId]);
      expect(Number(after.used)).toBe(120.5);
      const audit = await w.q(
        `SELECT id FROM audit_log WHERE company_id = $1 AND record_identifier = 'bulk recalculate-used'`,
        [w.companyId]
      );
      expect(audit).toHaveLength(1);

      const again = await recalc(w, { confirm: true });
      expect(again.body).toMatchObject({ updated: 0, changes: [] });
    });
  });
});

describe("POST /api/factory/raw-stock/recalculate-bale-costs", () => {
  it("refuses confirm with 410, refuses non-Admin roles and previews without writing", async () => {
    await withFactoryWorld(async (w) => {
      const gone = await w.agent.post("/api/factory/raw-stock/recalculate-bale-costs").send({ confirm: true });
      expect(gone.status).toBe(410);
      expect(gone.body.code).toBe("FACTORY_BALE_RECOST_MOVED");
      const empty = await w.agent.post("/api/factory/raw-stock/recalculate-bale-costs").send({});
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ dryRun: true, wouldUpdate: 0, changes: [] });

      const productId = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, production_price)
         VALUES ($1, $2, 'Shirts', 2) RETURNING id`,
        [w.companyId, `${w.tag}-P`]
      );
      const baleId = await w.one(
        `INSERT INTO factory_bales (company_id, reference_number, status, weight_kg, product_id, total_cost)
         VALUES ($1, $2, 'IN_STOCK', 10, $3, 0) RETURNING id`,
        [w.companyId, `${w.tag}-PB`, productId]
      );
      const preview = await w.agent.post("/api/factory/raw-stock/recalculate-bale-costs").send({});
      expect(preview.status).toBe(200);
      expect(preview.body.wouldUpdate).toBe(1);
      expect(preview.body.changes[0]).toMatchObject({ baleId, mixBatchId: null });
      const [row] = await w.q(`SELECT total_cost::text AS t FROM factory_bales WHERE id = $1`, [baleId]);
      expect(Number(row.t)).toBe(0);

      await w.setRole("Manager");
      expect((await w.agent.post("/api/factory/raw-stock/recalculate-bale-costs").send({})).status).toBe(403);
    });
  });
});
