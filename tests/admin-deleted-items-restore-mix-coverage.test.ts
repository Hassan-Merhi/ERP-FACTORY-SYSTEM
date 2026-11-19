/**
 * Evidence-backed factory mix restore through
 * POST /api/deleted-items/factoryMixBatch/:id/restore (rolled-back world):
 * every MixLifecycleRefusal leaves the mix deleted and its sources untouched,
 * and the two restorable source kinds re-consume exactly the recorded kg.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let mixSeq = 0;

/** A live mix; sources must be attached before `softDelete`, as the source trigger refuses deleted mixes. */
async function mix(w: FactoryWorld, totalKg = "100", usedKg = "0") {
  const code = `${w.tag}M${++mixSeq}`;
  return w.one(
    `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, status, total_weight_kg, used_kg)
     VALUES ($1, $2::text, $2::text, 'OPEN', $3, $4) RETURNING id`,
    [w.companyId, code, totalKg, usedKg]
  );
}

async function softDelete(w: FactoryWorld, id: number) {
  await w.q(`UPDATE factory_mix_batches SET deleted_at = now() WHERE id = $1`, [id]);
  return id;
}

async function deletedMix(w: FactoryWorld, extra: { usedKg?: string } = {}) {
  return softDelete(w, await mix(w, "100", extra.usedKg ?? "0"));
}

async function supplier(w: FactoryWorld) {
  return w.one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
    w.companyId,
    `${w.tag} Mill ${++mixSeq}`,
  ]);
}

async function source(
  w: FactoryWorld,
  mixId: number,
  opts: { containerId?: number; sourceBatchId?: number; weight?: string; type?: string }
) {
  const supplierId = opts.containerId == null && opts.sourceBatchId == null ? await supplier(w) : null;
  await w.q(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, source_batch_id, weight_kg, source_type, supplier_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      mixId,
      opts.containerId ?? null,
      opts.sourceBatchId ?? null,
      opts.weight ?? "10",
      opts.type ?? "SUPPLIER",
      supplierId,
    ]
  );
}

async function container(w: FactoryWorld, receivedKg?: string, usedKg = "0") {
  const id = await w.one(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id) VALUES ($1, $2, $3) RETURNING id`,
    [w.companyId, `${w.tag}C${++mixSeq}`, await supplier(w)]
  );
  if (receivedKg !== undefined) {
    await w.q(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg) VALUES ($1, $2, $3, $4)`,
      [w.companyId, id, receivedKg, usedKg]
    );
  }
  return id;
}

const restore = (w: FactoryWorld, id: number) =>
  w.agent.post(`/api/deleted-items/factoryMixBatch/${id}/restore`).send({});

async function expectRefused(w: FactoryWorld, mixId: number, message: RegExp) {
  const res = await restore(w, mixId);
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ code: "MIX_BATCH_LIFECYCLE_REFUSED", message: expect.stringMatching(message) });
  const [row] = await w.q(`SELECT deleted_at IS NOT NULL AS deleted FROM factory_mix_batches WHERE id = $1`, [mixId]);
  expect(row.deleted).toBe(true);
}

describe("factory mix restore", () => {
  it("refuses a mix that is not deleted or belongs elsewhere", () =>
    withFactoryWorld(async (w) => {
      const res = await restore(w, await mix(w));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/not in Deleted Items/);
    }));

  it("refuses mixes with consumption, no sources, or bad source kg", () =>
    withFactoryWorld(async (w) => {
      await expectRefused(w, await deletedMix(w, { usedKg: "5" }), /recorded consumption/);
      await expectRefused(w, await deletedMix(w), /lacks the source rows/);
      const zero = await mix(w);
      await source(w, zero, { containerId: await container(w, "100"), weight: "0" });
      await expectRefused(w, await softDelete(w, zero), /Invalid source kg/);
    }));

  it("refuses supplier-only, ADD-backed and unavailable container sources", () =>
    withFactoryWorld(async (w) => {
      const supplierOnly = await mix(w);
      await source(w, supplierOnly, {});
      await expectRefused(w, await softDelete(w, supplierOnly), /Supplier-only mix sources/);

      const addBacked = await mix(w);
      await source(w, addBacked, { containerId: await container(w, "100"), type: "SUPPLIER_ADJUSTMENT_BACKED" });
      await expectRefused(w, await softDelete(w, addBacked), /ADD-backed supplier stock/);

      const noStock = await mix(w);
      await source(w, noStock, { containerId: await container(w) });
      await expectRefused(w, await softDelete(w, noStock), /unavailable or ambiguously attributed/);

      const short = await mix(w);
      const shortContainer = await container(w, "20", "15");
      await source(w, short, { containerId: shortContainer, weight: "10" });
      await expectRefused(w, await softDelete(w, short), /unavailable or ambiguously attributed/);
      const [stock] = await w.q(`SELECT used_kg::text FROM factory_raw_stock WHERE container_id = $1`, [
        shortContainer,
      ]);
      expect(Number(stock.used_kg)).toBe(15);
    }));

  it("refuses missing or short upstream mixes", () =>
    withFactoryWorld(async (w) => {
      const gone = await mix(w);
      const orphan = await mix(w);
      await source(w, orphan, { sourceBatchId: gone });
      await softDelete(w, gone);
      await expectRefused(w, await softDelete(w, orphan), /Upstream mix source for restore is missing/);

      const parent = await mix(w, "100", "95");
      const short = await mix(w);
      await source(w, short, { sourceBatchId: parent });
      await expectRefused(w, await softDelete(w, short), /Upstream mix lacks the quantity/);
    }));

  it("re-consumes container stock and upstream mix kg on restore", () =>
    withFactoryWorld(async (w) => {
      const stockContainer = await container(w, "100", "20");
      const parent = await mix(w, "100", "90");
      const child = await mix(w);
      await source(w, child, { containerId: stockContainer, weight: "12.5" });
      await source(w, child, { sourceBatchId: parent, weight: "10" });
      const res = await restore(w, await softDelete(w, child));
      expect(res.status).toBe(200);
      const [stock] = await w.q(`SELECT used_kg::text FROM factory_raw_stock WHERE container_id = $1`, [
        stockContainer,
      ]);
      expect(Number(stock.used_kg)).toBe(32.5);
      const [upstream] = await w.q(`SELECT used_kg::text, status FROM factory_mix_batches WHERE id = $1`, [parent]);
      expect({ used: Number(upstream.used_kg), status: upstream.status }).toEqual({ used: 100, status: "CLOSED" });
      const [restored] = await w.q(`SELECT deleted_at FROM factory_mix_batches WHERE id = $1`, [child]);
      expect(restored.deleted_at).toBeNull();
    }));
});
