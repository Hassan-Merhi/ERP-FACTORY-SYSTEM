/**
 * PATCH /api/factory/mix-batches/:id reviewed source edits
 * (handlePatchFactoryMixBatchesIdStep2) through the real app inside one
 * rolled-back transaction: stale review hashes, completed batches, upstream
 * batch sources (applied, then reversed), container-direct sources whose raw
 * stock can no longer be reversed, and the applied edit with its name, notes,
 * date, sources and daybook line. Refusals leave raw stock and sources as
 * they were.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { db } from "../server/db";
import * as schema from "../shared/schema";

const REASON = "Reviewed source correction in coverage test";
const BASE = "/api/factory/mix-batches";

async function supplierWithStock(w: FactoryWorld, receivedKg = "10000", rate = "0.20") {
  const { applyOffloadMovingAverage } = await import("../server/services/factory/rawStockLockedRate");
  const supplierId = await w.one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
    w.companyId,
    `${w.tag} Supplier ${Math.floor(Math.random() * 1e6)}`,
  ]);
  const containerId = await w.one(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id, actual_received_kg, currency_code,
       fx_rate_to_usd, status)
     VALUES ($1, $2, $3, $4, 'USD', 1, 'OFFLOADED') RETURNING id`,
    [w.companyId, `${w.tag}C${Math.floor(Math.random() * 1e6)}`, supplierId, receivedKg]
  );
  await db.transaction(async (tx) => {
    await applyOffloadMovingAverage(tx, {
      companyId: w.companyId,
      supplierId,
      newReceivedKg: Number(receivedKg),
      newContainerLandedCostPerKgUsd: Number(rate),
    });
    await tx.insert(schema.factoryRawStock).values({
      companyId: w.companyId,
      containerId,
      receivedKg,
      costPerKg: rate,
      costPerKgUsd: rate,
    });
  });
  return { supplierId, containerId };
}

async function openMix(w: FactoryWorld, supplierId: number, weightKg: string, name = "Mix") {
  const res = await w.agent.post(BASE).send({ supplierSources: [{ supplierId, weightKg }], name });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await w.q(`UPDATE factory_mix_batches SET status = 'OPEN', used_kg = 0 WHERE id = $1`, [res.body.id]);
  return Number(res.body.id);
}

async function reviewed(w: FactoryWorld, id: number, proposal: Record<string, unknown>) {
  const body = { batchSources: [], supplierSources: [], sourceEditReason: REASON, ...proposal };
  const preview = await w.agent.patch(`${BASE}/${id}`).send({ ...body, sourceEditPreview: true });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  return { body, preview: preview.body as { allowed: boolean; reviewHash: string; warnings: string[] } };
}

const footprint = async (w: FactoryWorld, id: number) => ({
  sources: await w.q(
    `SELECT supplier_id, container_id, source_batch_id, weight_kg::text AS kg FROM factory_mix_batch_sources
      WHERE mix_batch_id = $1 ORDER BY id`,
    [id]
  ),
  stock: await w.q(`SELECT id, used_kg::text AS used FROM factory_raw_stock WHERE company_id = $1 ORDER BY id`, [
    w.companyId,
  ]),
  batches: await w.q(
    `SELECT id, used_kg::text AS used, status FROM factory_mix_batches WHERE company_id = $1 ORDER BY id`,
    [w.companyId]
  ),
});

describe("mix batch reviewed source edit", () => {
  it("refuses a stale review and a batch completed after review", () =>
    withFactoryWorld(async (w) => {
      const { supplierId } = await supplierWithStock(w);
      const id = await openMix(w, supplierId, "100");
      const { body, preview } = await reviewed(w, id, { supplierSources: [{ supplierId, weightKg: "150" }] });
      expect(preview.allowed, JSON.stringify(preview.warnings)).toBe(true);
      const before = await footprint(w, id);

      const stale = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...body, confirmSourceEdit: true, sourceEditReviewHash: "not-the-hash" });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("MIX_EDIT_REVIEW_STALE");
      const unreviewed = await w.agent.patch(`${BASE}/${id}`).send({ ...body });
      expect(unreviewed.body.code).toBe("MIX_EDIT_REVIEW_REQUIRED");
      expect(await footprint(w, id)).toEqual(before);

      await w.q(`UPDATE factory_mix_batches SET status = 'COMPLETED' WHERE id = $1`, [id]);
      const completed = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...body, confirmSourceEdit: true, sourceEditReviewHash: preview.reviewHash });
      expect(completed.status).toBe(409);
      await w.q(`UPDATE factory_mix_batches SET status = 'OPEN' WHERE id = $1`, [id]);
      expect(await footprint(w, id)).toEqual(before);
    }));

  it("applies a reviewed supplier edit with name, notes, date and daybook", () =>
    withFactoryWorld(async (w) => {
      const { supplierId } = await supplierWithStock(w);
      const id = await openMix(w, supplierId, "100");
      const { body, preview } = await reviewed(w, id, {
        supplierSources: [{ supplierId, weightKg: "250" }],
        name: "  Renamed mix ",
        notes: " ",
        batchDate: "2026-06-03",
      });
      const res = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...body, confirmSourceEdit: true, sourceEditReviewHash: preview.reviewHash });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ name: "Renamed mix", notes: null, batchDate: "2026-06-03" });
      expect(Number(res.body.totalWeightKg)).toBeCloseTo(250, 3);
      expect(Number(res.body.costPerKg)).toBeCloseTo(0.2, 4);
      const [stock] = await w.q(`SELECT used_kg::text AS used FROM factory_raw_stock WHERE company_id = $1`, [
        w.companyId,
      ]);
      expect(Number(stock.used)).toBeCloseTo(250, 3);
      const daybook = await w.q(
        `SELECT description FROM factory_daybook_entries WHERE company_id = $1 AND tx_type = 'MIX_BATCH_CREATED'
           AND reference_id = $2`,
        [w.companyId, id]
      );
      expect(daybook).toHaveLength(1);
      expect(daybook[0].description).toMatch(/^Mix batch edited: .* – Renamed mix \(250\.0 kg\)$/);

      const again = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...body, confirmSourceEdit: true, sourceEditReviewHash: preview.reviewHash });
      expect([200, 409]).toContain(again.status);
    }));

  it("draws from an upstream batch and gives it back on the next edit", () =>
    withFactoryWorld(async (w) => {
      const { supplierId } = await supplierWithStock(w);
      const upstream = await openMix(w, supplierId, "300", "Upstream");
      const id = await openMix(w, supplierId, "100", "Downstream");
      const toBatch = await reviewed(w, id, { batchSources: [{ sourceBatchId: upstream, weightKg: "120" }] });
      expect(toBatch.preview.allowed, JSON.stringify(toBatch.preview.warnings)).toBe(true);
      const first = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...toBatch.body, confirmSourceEdit: true, sourceEditReviewHash: toBatch.preview.reviewHash });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const used = async () =>
        Number((await w.q(`SELECT used_kg::text AS u FROM factory_mix_batches WHERE id = $1`, [upstream]))[0].u);
      expect(await used()).toBeCloseTo(120, 3);
      const [source] = await w.q(`SELECT source_type FROM factory_mix_batch_sources WHERE mix_batch_id = $1`, [id]);
      expect(source.source_type).toBe("BATCH");

      const back = await reviewed(w, id, { supplierSources: [{ supplierId, weightKg: "90" }] });
      const second = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...back.body, confirmSourceEdit: true, sourceEditReviewHash: back.preview.reviewHash });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(await used()).toBeCloseTo(0, 3);
    }));

  it("refuses an edit whose original consumption was given back after review", () =>
    withFactoryWorld(async (w) => {
      const { supplierId, containerId } = await supplierWithStock(w);
      const id = await openMix(w, supplierId, "100");
      const [src] = await w.q(`SELECT container_id FROM factory_mix_batch_sources WHERE mix_batch_id = $1`, [id]);
      expect(Number(src.container_id)).toBe(containerId);
      const { body, preview } = await reviewed(w, id, { supplierSources: [{ supplierId, weightKg: "80" }] });
      await w.q(`UPDATE factory_raw_stock SET used_kg = 10 WHERE container_id = $1`, [containerId]);
      const before = await footprint(w, id);
      const res = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...body, confirmSourceEdit: true, sourceEditReviewHash: preview.reviewHash });
      // The in-transaction review sees the shortfall first and blocks the edit.
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("MIX_EDIT_REVIEW_BLOCKED");
      expect(await footprint(w, id)).toEqual(before);
    }));

  it("blocks a new supplier source that has no raw-stock rows", () =>
    withFactoryWorld(async (w) => {
      const { supplierId } = await supplierWithStock(w);
      const second = await supplierWithStock(w, "500", "0.40");
      const id = await openMix(w, supplierId, "100");
      await w.q(`UPDATE factory_raw_stock SET deleted_at = now() WHERE container_id = $1`, [second.containerId]);
      const { body, preview } = await reviewed(w, id, {
        supplierSources: [{ supplierId: second.supplierId, weightKg: "50" }],
      });
      expect(preview.allowed).toBe(false);
      const before = await footprint(w, id);
      const res = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ ...body, confirmSourceEdit: true, sourceEditReviewHash: preview.reviewHash });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("MIX_EDIT_REVIEW_BLOCKED");
      expect(res.body.message).toMatch(/no raw-stock allocation rows/);
      expect(await footprint(w, id)).toEqual(before);
    }));
});
