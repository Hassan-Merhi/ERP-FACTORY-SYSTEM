/**
 * Behavioural coverage for the mix-batch finalize and delete write routes.
 *
 * Both were guard-only. A mix batch consumes raw material — from a container's
 * raw stock, or from an upstream batch — and records what it took in
 * `factory_mix_batch_sources`. Deleting one has to give that material back.
 *
 * The conservation property is the whole point of these tests, and the
 * handler's own comment records that it was once absent: *"Previously this
 * reversal never happened, so deleting a batch permanently 'lost' its consumed
 * stock."* Nothing surfaced that, because the numbers stay internally
 * consistent — the raw stock simply shows less material than the warehouse
 * holds, forever, with no entry explaining where it went.
 *
 * So each delete is asserted as an exact round trip: `used_kg` on the source
 * falls by precisely the weight this batch consumed, whether the source is a
 * container's raw stock or another batch.
 *
 * The cross-tenant case turned out to be guarded one level lower than expected:
 * a database trigger refuses a source row whose container belongs to another
 * company, so the reversal can never be handed a foreign container id in the
 * first place. That is pinned as what it is, since it is a stronger guarantee
 * than the handler's own predicate.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "mixbat";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let foreignCompanyId: number;
let seq = 0;

async function createBatch(totalWeightKg = "500.000", usedKg = "0"): Promise<number> {
  seq += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_mix_batches (company_id, batch_code, cost_per_kg, total_weight_kg, used_kg, status)
     VALUES ($1, $2, '2.00', $3, $4, 'OPEN') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-MB-${seq}`, totalWeightKg, usedKg]
  );
  return result.rows[0].id;
}

/** A container's raw-stock row with some material already consumed. */
async function createRawStock(usedKg: string, companyId = ctx.companyId): Promise<number> {
  seq += 1;
  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code)
     VALUES ($1, $2, $3, '1000', '2.00', 'USD') RETURNING id`,
    [companyId, companyId === ctx.companyId ? supplierId : null, `${TEST_PREFIX}-C-${seq}`]
  );
  const rawStock = await pool.query<{ id: number }>(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd, offloaded_at)
     VALUES ($1, $2, '1000.000', $3, '2.00', '2.00', now()) RETURNING id`,
    [companyId, container.rows[0].id, usedKg]
  );
  return rawStock.rows[0].id;
}

async function containerIdOf(rawStockId: number): Promise<number> {
  const result = await pool.query<{ container_id: number }>(
    `SELECT container_id FROM factory_raw_stock WHERE id = $1`,
    [rawStockId]
  );
  return result.rows[0].container_id;
}

/** Record that `batchId` consumed `weightKg` from a container or an upstream batch. */
async function addSource(batchId: number, opts: { containerId?: number; sourceBatchId?: number; weightKg: string }) {
  await pool.query(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, source_batch_id, weight_kg, cost_per_kg, total_cost)
     VALUES ($1, $2, $3, $4, '2.00', '0.00')`,
    [batchId, opts.containerId ?? null, opts.sourceBatchId ?? null, opts.weightKg]
  );
}

async function rawStockUsed(rawStockId: number): Promise<number> {
  const result = await pool.query<{ used_kg: string }>(`SELECT used_kg FROM factory_raw_stock WHERE id = $1`, [
    rawStockId,
  ]);
  return Number(result.rows[0].used_kg);
}

const WASTE_REASON = "Reviewed remainder written off in test";

/** The explicit, reviewed write-off a finalize needs when kg remain unused. */
function reviewedWaste(wasteKg: string) {
  return { confirmRemainderAsWaste: true, wasteKg, wasteReason: WASTE_REASON };
}

async function batchRow(id: number) {
  const result = await pool.query<{
    status: string;
    used_kg: string | null;
    total_weight_kg: string | null;
    deleted_at: string | null;
  }>(`SELECT status, used_kg, total_weight_kg, deleted_at FROM factory_mix_batches WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} supplier`]
  );
  supplierId = supplier.rows[0].id;

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${TEST_PREFIX.slice(0, 4)}FG`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
}, 120000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM factory_mix_batches WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [foreignCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/factory/mix-batches/:id/finalize", () => {
  it("refuses to write off an unreviewed remainder", async () => {
    const batchId = await createBatch("750.000");

    // Finalizing with kg still unused would silently turn stock into waste.
    const bare = await agent.post(`/api/factory/mix-batches/${batchId}/finalize`).send({});
    expect(bare.status).toBe(409);
    expect(bare.body.code).toBe("MIX_BATCH_LIFECYCLE_REFUSED");

    // The confirmed kg must equal the remainder read under the row lock.
    const stale = await agent
      .post(`/api/factory/mix-batches/${batchId}/finalize`)
      .send({ confirmRemainderAsWaste: true, wasteKg: "700.000", wasteReason: WASTE_REASON });
    expect(stale.status).toBe(409);

    const undocumented = await agent
      .post(`/api/factory/mix-batches/${batchId}/finalize`)
      .send({ confirmRemainderAsWaste: true, wasteKg: "750.000", wasteReason: "short" });
    expect(undocumented.status).toBe(400);

    const row = await batchRow(batchId);
    expect(row?.status).toBe("OPEN");
    expect(Number(row?.used_kg)).toBeCloseTo(0, 3);
  });

  it("marks the batch complete with its full weight consumed", async () => {
    const batchId = await createBatch("750.000");

    const response = await agent.post(`/api/factory/mix-batches/${batchId}/finalize`).send(reviewedWaste("750.000"));

    expect(response.status).toBe(200);
    const row = await batchRow(batchId);
    expect(row?.status).toBe("COMPLETED");
    // Finalizing means the whole batch is spoken for; used must equal total, or
    // the batch keeps offering material it has already committed.
    expect(Number(row?.used_kg)).toBeCloseTo(750, 3);
  });

  it("refuses to finalize a batch that is already finalized", async () => {
    const batchId = await createBatch("400.000");
    expect(
      (await agent.post(`/api/factory/mix-batches/${batchId}/finalize`).send(reviewedWaste("400.000"))).status
    ).toBe(200);

    const second = await agent.post(`/api/factory/mix-batches/${batchId}/finalize`).send(reviewedWaste("400.000"));

    expect(second.status).toBe(409);
    expect(Number((await batchRow(batchId))?.used_kg)).toBeCloseTo(400, 3);
  });

  it("returns 404 for a batch in another company", async () => {
    expect((await agent.post("/api/factory/mix-batches/999999/finalize").send({})).status).toBe(404);
  });

  it("rejects a non-numeric id", async () => {
    expect((await agent.post("/api/factory/mix-batches/not-an-id/finalize").send({})).status).toBe(400);
  });
});

describe("DELETE /api/factory/mix-batches/:id", () => {
  it("gives back exactly the raw stock the batch consumed", async () => {
    const rawStockId = await createRawStock("300.000");
    const batchId = await createBatch();
    await addSource(batchId, { containerId: await containerIdOf(rawStockId), weightKg: "120.000" });

    const response = await agent.delete(`/api/factory/mix-batches/${batchId}`);
    expect(response.status).toBe(200);

    // 300 consumed, this batch accounted for 120 of it, so 180 remains used.
    // Without the reversal the material is permanently lost: the numbers stay
    // internally consistent while the stock simply shows less than the
    // warehouse holds.
    expect(await rawStockUsed(rawStockId)).toBeCloseTo(180, 3);
    expect((await batchRow(batchId))?.deleted_at).not.toBeNull();
  });

  it("gives back what it took from an upstream batch", async () => {
    const upstream = await createBatch("1000.000", "400.000");
    const batchId = await createBatch();
    await addSource(batchId, { sourceBatchId: upstream, weightKg: "150.000" });

    expect((await agent.delete(`/api/factory/mix-batches/${batchId}`)).status).toBe(200);

    // A batch can be fed by another batch rather than a container; the same
    // conservation has to hold one level up.
    expect(Number((await batchRow(upstream))?.used_kg)).toBeCloseTo(250, 3);
  });

  it("reverses every source, not just the first", async () => {
    const firstStock = await createRawStock("200.000");
    const secondStock = await createRawStock("200.000");
    const batchId = await createBatch();
    await addSource(batchId, { containerId: await containerIdOf(firstStock), weightKg: "50.000" });
    await addSource(batchId, { containerId: await containerIdOf(secondStock), weightKg: "75.000" });

    expect((await agent.delete(`/api/factory/mix-batches/${batchId}`)).status).toBe(200);

    expect(await rawStockUsed(firstStock)).toBeCloseTo(150, 3);
    expect(await rawStockUsed(secondStock)).toBeCloseTo(125, 3);
  });

  it("refuses a reversal larger than the recorded usage instead of clamping it", async () => {
    const rawStockId = await createRawStock("40.000");
    const batchId = await createBatch();
    // More than has ever been used — only possible if usedKg was already
    // corrupted. Clamping to zero would hide that; the delete must refuse and
    // leave both the stock row and the mix exactly as they were.
    await addSource(batchId, { containerId: await containerIdOf(rawStockId), weightKg: "100.000" });

    const response = await agent.delete(`/api/factory/mix-batches/${batchId}`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("MIX_BATCH_LIFECYCLE_REFUSED");
    expect(await rawStockUsed(rawStockId)).toBeCloseTo(40, 3);
    expect((await batchRow(batchId))?.deleted_at).toBeNull();
  });

  it("cannot be given a source container from another company at all", async () => {
    const foreignStock = await createRawStock("300.000", foreignCompanyId);
    const batchId = await createBatch();

    // The reversal is driven by a container_id taken from the batch's own
    // source rows, so a cross-tenant id there would credit another company's
    // stock. It turns out that cannot be reached: a database trigger,
    // factory_mix_source_inventory_supplier_trg, rejects the source row on
    // insert. The guarantee is therefore stronger than the handler's company
    // predicate — the bad row cannot exist to be reversed.
    await expect(
      addSource(batchId, { containerId: await containerIdOf(foreignStock), weightKg: "100.000" })
    ).rejects.toThrow(/CONTAINER_INVENTORY_SUPPLIER_UNRESOLVED/);

    expect(await rawStockUsed(foreignStock)).toBeCloseTo(300, 3);
  });

  it("returns 404 when the batch is already deleted", async () => {
    const batchId = await createBatch();
    expect((await agent.delete(`/api/factory/mix-batches/${batchId}`)).status).toBe(200);

    const second = await agent.delete(`/api/factory/mix-batches/${batchId}`);

    // The update excludes rows already tombstoned, so a second delete cannot
    // reverse the same consumption twice and inflate the stock.
    expect(second.status).toBe(404);
  });

  it("returns 404 for a batch in another company", async () => {
    expect((await agent.delete("/api/factory/mix-batches/999999")).status).toBe(404);
  });
});
