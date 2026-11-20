/**
 * POST /api/factory/mix-batches/:id/top-up through the real app against a
 * factory company that lives in one rolled-back transaction. Refusals first:
 * no sources, invalid kg, unknown / closed / cross-company batches, missing or
 * cross-company containers, raw-stock shortages, manual suppliers without ADD
 * backing or rate, short source batches. Then supplier FIFO (with ADD-backed
 * and advance shortfalls), container-direct and batch sources, and the stored
 * source provenance.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function supplier(w: FactoryWorld, rate: string | null) {
  return w.one(
    `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd)
     VALUES ($1, $2, $3) RETURNING id`,
    [w.companyId, `${w.tag}-S-${Math.random()}`, rate]
  );
}

async function container(w: FactoryWorld, supplierId: number | null, receivedKg: string, usedKg = "0") {
  const containerId = await w.one(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id, actual_received_kg, currency_code,
       fx_rate_to_usd, status)
     VALUES ($1, $2, $3, $4, 'USD', 1, 'OFFLOADED') RETURNING id`,
    [w.companyId, `${w.tag}-C-${Math.random()}`, supplierId, receivedKg]
  );
  await w.q(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, $3, $4, 0.5, 0.5)`,
    [w.companyId, containerId, receivedKg, usedKg]
  );
  return containerId;
}

let batchSeq = 0;
async function batch(w: FactoryWorld, opts: { status?: string; total?: string; used?: string; cost?: string } = {}) {
  const { status = "OPEN", total = "100", used = "0", cost = "0.4" } = opts;
  return w.one(
    `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, name, status, total_weight_kg, used_kg, total_cost,
       cost_per_kg, batch_date)
     VALUES ($1, $2, $7, 'Blend', $3, $4, $5, $4::numeric * $6::numeric, $6, '2026-03-01') RETURNING id`,
    [w.companyId, `MB${++batchSeq}-${w.tag}`, status, total, used, cost, batchSeq]
  );
}

const rowOf = async (w: FactoryWorld, id: number) =>
  (
    await w.q(
      `SELECT status, total_weight_kg::float8 AS total, used_kg::float8 AS used FROM factory_mix_batches WHERE id=$1`,
      [id]
    )
  )[0];
const sourcesOf = (w: FactoryWorld, id: number) =>
  w.q<{ source_type: string; weight_kg: string }>(
    `SELECT source_type, weight_kg::text AS weight_kg FROM factory_mix_batch_sources WHERE mix_batch_id=$1 ORDER BY id`,
    [id]
  );
const rawUsed = async (w: FactoryWorld, containerId: number) =>
  Number((await w.q(`SELECT used_kg FROM factory_raw_stock WHERE container_id=$1`, [containerId]))[0].used_kg);

describe("top-up refusals", () => {
  it("rejects invalid ids, empty sources and bad kilograms without writing", () =>
    withFactoryWorld(async (w) => {
      const id = await batch(w);
      expect((await w.agent.post(`/api/factory/mix-batches/abc/top-up`).send({})).status).toBe(400);
      const empty = await w.agent.post(`/api/factory/mix-batches/${id}/top-up`).send({});
      expect(empty.status).toBe(400);
      expect(empty.body.message).toMatch(/At least one source/);
      const bad = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ sources: [{ containerId: 1, weightKg: "1.2345" }] });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("MIX_BATCH_LIFECYCLE_REFUSED");
      expect(await sourcesOf(w, id)).toEqual([]);
    }));

  it("refuses an unknown batch, a batch in another company and a completed batch", () =>
    withFactoryWorld(async (w) => {
      const containerId = await container(w, null, "50");
      const send = (id: number) =>
        w.agent.post(`/api/factory/mix-batches/${id}/top-up`).send({ sources: [{ containerId, weightKg: "1" }] });
      const missing = await send(2147483000);
      expect(missing.status).toBe(400);
      expect(missing.body.message).toBe("Batch not found");

      const otherCompany = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}X`]
      );
      const foreign = await w.one(
        `INSERT INTO factory_mix_batches (company_id, batch_code, status, total_weight_kg) VALUES ($1, 'F', 'OPEN', 5) RETURNING id`,
        [otherCompany]
      );
      expect((await send(foreign)).body.message).toBe("Batch not found");

      const completed = await batch(w, { status: "COMPLETED" });
      const res = await send(completed);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("MIX_BATCH_LIFECYCLE_REFUSED");
      expect(await rawUsed(w, containerId)).toBe(0);
    }));

  it("refuses container sources with no raw stock, a deleted container or too little stock", () =>
    withFactoryWorld(async (w) => {
      const id = await batch(w);
      const noStock = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ sources: [{ containerId: 2147483000, weightKg: "1" }] });
      expect(noStock.status).toBe(400);
      expect(noStock.body.message).toMatch(/Raw stock not found/);

      const deleted = await container(w, null, "50");
      await w.q(`UPDATE factory_containers SET deleted_at = now() WHERE id = $1`, [deleted]);
      const gone = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ sources: [{ containerId: deleted, weightKg: "1" }] });
      expect(gone.body.message).toMatch(/not found, deleted, or belongs to another company/);

      const small = await container(w, null, "5");
      const short = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ sources: [{ containerId: small, weightKg: "6" }] });
      expect(short.status).toBe(409);
      expect(await rawUsed(w, small)).toBe(0);
      expect(await rowOf(w, id)).toMatchObject({ total: 100 });
    }));

  it("refuses a manual supplier without ADD backing, and one with ADD backing but no rate", () =>
    withFactoryWorld(async (w) => {
      const id = await batch(w);
      const manual = await supplier(w, "0.3");
      const unbacked = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ supplierSources: [{ supplierId: manual, weightKg: "5" }], txDate: "2026-03-05" });
      expect(unbacked.status).toBe(409);
      expect(unbacked.body.message).toMatch(/cannot cover 5.000 kg/);

      const unpriced = await supplier(w, null);
      await w.q(
        `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, date) VALUES ($1, $2, 'ADD', 20, '2026-03-01')`,
        [w.companyId, unpriced]
      );
      const noRate = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ supplierSources: [{ supplierId: unpriced, weightKg: "5" }], txDate: "2026-03-05" });
      expect(noRate.status).toBe(400);
      expect(noRate.body.message).toMatch(/no established raw-material rate/);

      const badDate = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ supplierSources: [{ supplierId: unpriced, weightKg: "5" }], txDate: "05/03/2026" });
      expect(badDate.status).toBe(409);
      expect(await sourcesOf(w, id)).toEqual([]);
    }));

  it("refuses a supplier advance without a positive locked rate", () =>
    withFactoryWorld(async (w) => {
      const id = await batch(w);
      const unpriced = await supplier(w, null);
      const containerId = await container(w, unpriced, "10");
      const res = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ supplierSources: [{ supplierId: unpriced, weightKg: "15" }], txDate: "2026-03-05" });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/known positive locked USD rate/);
      expect(await rawUsed(w, containerId)).toBe(0);
    }));

  it("refuses a missing source batch and one with too little remaining", () =>
    withFactoryWorld(async (w) => {
      const id = await batch(w);
      const missing = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ batchSources: [{ sourceBatchId: 2147483000, weightKg: "1" }] });
      expect(missing.body.message).toMatch(/Source batch 2147483000 not found/);
      const parent = await batch(w, { total: "10", used: "8" });
      const over = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ batchSources: [{ sourceBatchId: parent, weightKg: "3" }] });
      expect(over.status).toBe(400);
      expect(over.body.message).toMatch(/Not enough in batch .* Available: 2.000 kg/);
      expect(await rowOf(w, parent)).toMatchObject({ used: 8 });
    }));
});

describe("successful top-ups", () => {
  it("draws supplier FIFO stock, then ADD-backed and advance kilograms", () =>
    withFactoryWorld(async (w) => {
      const id = await batch(w);
      const s = await supplier(w, "0.3");
      const used = await container(w, s, "4", "4");
      const c1 = await container(w, s, "6");
      await w.q(
        `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, date) VALUES ($1, $2, 'ADD', 2, '2026-03-01')`,
        [w.companyId, s]
      );
      const res = await w.agent
        .post(`/api/factory/mix-batches/${id}/top-up`)
        .send({ supplierSources: [{ supplierId: s, weightKg: "10" }], txDate: "2026-03-05" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Number(res.body.totalWeightKg)).toBe(110);
      expect(res.body.status).toBe("ACTIVE");
      expect(await rawUsed(w, used)).toBe(4);
      expect(await rawUsed(w, c1)).toBe(10);
      expect((await sourcesOf(w, id)).map((r) => [r.source_type, Number(r.weight_kg)])).toEqual([
        ["SUPPLIER_FIFO", 6],
        ["SUPPLIER_ADJUSTMENT_BACKED", 2],
        ["SUPPLIER_ADVANCE", 2],
      ]);
      const daybook = await w.q(`SELECT tx_type FROM factory_daybook_entries WHERE company_id=$1 AND reference_id=$2`, [
        w.companyId,
        id,
      ]);
      expect(daybook.map((d) => d.tx_type)).toEqual(["MIX_BATCH_TOPUP"]);
    }));

  it("tops up from a manual ADD supplier, a direct container and a source batch together", () =>
    withFactoryWorld(async (w) => {
      const id = await batch(w);
      const manual = await supplier(w, "0.25");
      await w.q(
        `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, date) VALUES ($1, $2, 'ADD', 20, '2026-03-01')`,
        [w.companyId, manual]
      );
      const direct = await container(w, await supplier(w, null), "30");
      const parent = await batch(w, { total: "40", used: "0", cost: "0.5" });
      const res = await w.agent.post(`/api/factory/mix-batches/${id}/top-up`).send({
        supplierSources: [{ supplierId: manual, weightKg: "5" }],
        sources: [{ containerId: direct, weightKg: "10" }],
        batchSources: [{ sourceBatchId: parent, weightKg: "15" }],
        txDate: "2026-03-05",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Number(res.body.totalWeightKg)).toBe(130);
      expect(await rawUsed(w, direct)).toBe(10);
      expect(await rowOf(w, parent)).toMatchObject({ used: 15 });
      expect((await sourcesOf(w, id)).map((r) => r.source_type)).toEqual(["SUPPLIER", "SUPPLIER_FIFO", "BATCH"]);
      const audit = await w.q(
        `SELECT action FROM audit_log WHERE company_id=$1 AND table_name='factory_mix_batches' AND record_id=$2`,
        [w.companyId, String(id)]
      );
      expect(audit.map((a) => a.action)).toContain("update");
    }));
});
