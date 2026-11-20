/**
 * POST /api/factory/mix-batches against a real (rolled-back) company:
 * refusals first (no source, unknown/foreign container, missing raw stock,
 * container over-draw, unknown/closed/over-drawn source batch, manual supplier
 * without a rate or ADD backing, future-offload advance without a locked rate)
 * leave stock untouched; then the opening-batch carry-forward, batch sources,
 * container sources, manual ADD-backed suppliers and FIFO shortfalls split
 * into ADD-backed and advance rows.
 */
import { describe, expect, it } from "vitest";

import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/mix-batches";

async function supplier(w: FactoryWorld, rate: string | null) {
  return w.one(
    `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd) VALUES ($1, $2, $3) RETURNING id`,
    [w.companyId, `${w.tag} S${Math.random().toString(36).slice(2, 6)}`, rate]
  );
}

async function container(w: FactoryWorld, supplierId: number | null, receivedKg: string, usd = "0.4") {
  const containerId = await w.one(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id) VALUES ($1, $2, $3) RETURNING id`,
    [w.companyId, `${w.tag}${Math.random().toString(36).slice(2, 7)}`, supplierId]
  );
  const rawStockId = await w.one(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg_usd, offloaded_at)
     VALUES ($1, $2, $3, 0, $4, NOW()) RETURNING id`,
    [w.companyId, containerId, receivedKg, usd]
  );
  return { containerId, rawStockId };
}

async function batch(w: FactoryWorld, status: string, total: string, used: string, cost = "0.5") {
  return w.one(
    `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, status, total_weight_kg, used_kg, cost_per_kg, total_cost)
     VALUES ($1, $2::varchar, $2::varchar, $3, $4, $5, $6, 0) RETURNING id`,
    [w.companyId, `${w.tag}-${Math.random().toString(36).slice(2, 7)}`, status, total, used, cost]
  );
}

async function addAdjustment(w: FactoryWorld, supplierId: number, kg: string) {
  await w.q(
    `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, date) VALUES ($1, $2, 'ADD', $3, '2026-01-01')`,
    [w.companyId, supplierId, kg]
  );
}

const usedKg = async (w: FactoryWorld, rawStockId: number) =>
  Number((await w.q(`SELECT used_kg FROM factory_raw_stock WHERE id = $1`, [rawStockId]))[0].used_kg);
const mixCount = async (w: FactoryWorld) =>
  Number((await w.q(`SELECT COUNT(*)::int AS n FROM factory_mix_batches WHERE company_id = $1`, [w.companyId]))[0].n);
const sourcesOf = async (w: FactoryWorld, mixId: number) =>
  w.q(
    `SELECT source_type, weight_kg::numeric AS kg FROM factory_mix_batch_sources WHERE mix_batch_id = $1 ORDER BY id`,
    [mixId]
  );

describe("mix batch create refusals", () => {
  it("refuses a request without any source", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent.post(URL).send({ openingBatchId: "none" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("At least one source is required");
    });
  });

  it("refuses container sources that are missing, foreign or over-drawn", async () => {
    await withFactoryWorld(async (w) => {
      const before = await mixCount(w);
      let res = await w.agent.post(URL).send({ sources: [{ containerId: 999999999, weightKg: "1" }] });
      expect(res.body.message).toBe("Raw stock not found for container 999999999");
      const orphan = await container(w, null, "10");
      await w.q(`UPDATE factory_containers SET deleted_at = NOW() WHERE id = $1`, [orphan.containerId]);
      res = await w.agent.post(URL).send({ sources: [{ containerId: orphan.containerId, weightKg: "1" }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not found, deleted, or belongs to another company/);
      const small = await container(w, null, "5");
      res = await w.agent.post(URL).send({ sources: [{ containerId: small.containerId, weightKg: "6" }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("MIX_RAW_STOCK_SHORTAGE");
      expect(await usedKg(w, small.rawStockId)).toBe(0);
      expect(await mixCount(w)).toBe(before);
    });
  });

  it("refuses unknown, closed or over-drawn source batches", async () => {
    await withFactoryWorld(async (w) => {
      let res = await w.agent.post(URL).send({ batchSources: [{ sourceBatchId: 999999999, weightKg: "1" }] });
      expect(res.body.message).toBe("Source batch 999999999 not found");
      const closed = await batch(w, "COMPLETED", "10", "0");
      res = await w.agent.post(URL).send({ batchSources: [{ sourceBatchId: closed, weightKg: "1" }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot be consumed or topped up again/);
      const open = await batch(w, "OPEN", "10", "8");
      res = await w.agent.post(URL).send({ batchSources: [{ sourceBatchId: open, weightKg: "3" }] });
      expect(res.body.message).toMatch(/^Not enough in batch .* Available: 2\.000 kg$/);
      expect((await w.q(`SELECT used_kg FROM factory_mix_batches WHERE id = $1`, [open]))[0].used_kg).toMatch(/^8/);
    });
  });

  it("refuses an unknown or exhausted opening batch", async () => {
    await withFactoryWorld(async (w) => {
      let res = await w.agent.post(URL).send({ openingBatchId: 999999999 });
      expect(res.body.message).toBe("Opening batch not found");
      const empty = await batch(w, "OPEN", "10", "10");
      res = await w.agent.post(URL).send({ openingBatchId: empty });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Opening batch has no remaining stock");
    });
  });

  it("refuses a manual supplier without ADD backing or without a rate", async () => {
    await withFactoryWorld(async (w) => {
      const unbacked = await supplier(w, "0.3");
      let res = await w.agent.post(URL).send({ supplierSources: [{ supplierId: unbacked, weightKg: "5" }] });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/cannot cover 5\.000 kg/);
      const unrated = await supplier(w, null);
      await addAdjustment(w, unrated, "10");
      res = await w.agent.post(URL).send({ supplierSources: [{ supplierId: unrated, weightKg: "5" }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Supplier has no established raw-material rate yet/);
    });
  });

  it("refuses a future-offload advance when the supplier has no locked rate", async () => {
    await withFactoryWorld(async (w) => {
      const s = await supplier(w, null);
      const { rawStockId } = await container(w, s, "4");
      const res = await w.agent.post(URL).send({ supplierSources: [{ supplierId: s, weightKg: "6" }] });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/needs a known positive locked USD rate/);
      expect(await usedKg(w, rawStockId)).toBe(0);
    });
  });
});

describe("mix batch create", () => {
  it("carries forward an opening batch and draws batch and container sources", async () => {
    await withFactoryWorld(async (w) => {
      const opening = await batch(w, "OPEN", "10", "4", "0.5");
      const other = await batch(w, "ACTIVE", "8", "0", "0");
      const s = await supplier(w, null);
      const direct = await container(w, s, "20", "0.4");
      const res = await w.agent.post(URL).send({
        openingBatchId: opening,
        batchSources: [{ sourceBatchId: other, weightKg: "2" }],
        sources: [{ containerId: direct.containerId, weightKg: "5" }],
        name: "Blend",
        notes: "n",
        operatorUser: "op",
        batchDate: "2026-02-01",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: "Blend", status: "COMPLETED" });
      expect(Number(res.body.totalWeightKg)).toBe(13);
      expect((await sourcesOf(w, res.body.id)).map((r) => [r.source_type, Number(r.kg)])).toEqual([
        ["BATCH", 6],
        ["SUPPLIER_FIFO", 5],
        ["BATCH", 2],
      ]);
      const [openRow] = await w.q(`SELECT status, used_kg::numeric AS used FROM factory_mix_batches WHERE id = $1`, [
        opening,
      ]);
      expect([openRow.status, Number(openRow.used)]).toEqual(["CLOSED", 10]);
      expect(await usedKg(w, direct.rawStockId)).toBe(5);
    });
  });

  it("prices a manual supplier from its locked rate when ADD stock backs it", async () => {
    await withFactoryWorld(async (w) => {
      const s = await supplier(w, "0.3");
      await addAdjustment(w, s, "10");
      const res = await w.agent.post(URL).send({ supplierSources: [{ supplierId: s, weightKg: "4" }] });
      expect(res.status).toBe(200);
      expect(Number(res.body.totalCost)).toBeCloseTo(1.2, 6);
      expect((await sourcesOf(w, res.body.id)).map((r) => r.source_type)).toEqual(["SUPPLIER"]);
    });
  });

  it("splits a FIFO shortfall into ADD-backed and advance rows at the locked rate", async () => {
    await withFactoryWorld(async (w) => {
      const s = await supplier(w, "0.3");
      const { rawStockId } = await container(w, s, "4");
      await addAdjustment(w, s, "1");
      const res = await w.agent
        .post(URL)
        .send({ supplierSources: [{ supplierId: s, weightKg: "7" }], batchDate: "2026-02-01" });
      expect(res.status).toBe(200);
      expect((await sourcesOf(w, res.body.id)).map((r) => [r.source_type, Number(r.kg)])).toEqual([
        ["SUPPLIER_FIFO", 4],
        ["SUPPLIER_ADJUSTMENT_BACKED", 1],
        ["SUPPLIER_ADVANCE", 2],
      ]);
      expect(await usedKg(w, rawStockId)).toBe(7);
      const second = await w.agent.post(URL).send({ supplierSources: [{ supplierId: s, weightKg: "1" }] });
      expect(second.status).toBe(200);
      expect(String(second.body.batchCode)).not.toBe(String(res.body.batchCode));
    });
  });
});
