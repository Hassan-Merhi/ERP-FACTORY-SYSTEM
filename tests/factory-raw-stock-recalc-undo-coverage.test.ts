/**
 * Raw-stock recalculation undo: listing the undo log, refusals (role, bad id,
 * unknown or other-company entry, already undone, snapshot rows that vanished)
 * leave stored costs untouched, and a valid undo restores every snapshot row,
 * marks the entry undone and writes an audit row. One rolled-back
 * transaction per test.
 */
import { describe, expect, it } from "vitest";

import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/raw-stock/recalc/undo";
let seq = 0;

/** Destructive privileged write: step-up password plus reason and idempotency key. */
async function undo(w: FactoryWorld, undoLogId: unknown) {
  const confirm = await w.agent.post("/api/auth/confirm-password").send({ password: "rolledback-pass-123" });
  expect(confirm.status).toBe(200);
  return w.agent.post(URL).send({ undoLogId, reason: "coverage undo", idempotencyKey: `undo-${w.tag}-${++seq}` });
}

interface Rows {
  container: number;
  rawStock: number;
  batch: number;
  source: number;
  bale: number;
  supplier: number;
}

async function seed(w: FactoryWorld): Promise<Rows> {
  const container = await w.one(
    `INSERT INTO factory_containers (company_id, container_number, final_payable_amount, rate_per_kg_usd, final_payable_amount_usd)
     VALUES ($1, $2, 900, 0.9, 900) RETURNING id`,
    [w.companyId, `${w.tag}C`]
  );
  const rawStock = await w.one(
    `INSERT INTO factory_raw_stock (company_id, cost_per_kg, cost_per_kg_usd) VALUES ($1, 0.9, 0.9) RETURNING id`,
    [w.companyId]
  );
  const supplier = await w.one(
    `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd) VALUES ($1, $2, 0.9) RETURNING id`,
    [w.companyId, `${w.tag} Supplier`]
  );
  const batch = await w.one(
    `INSERT INTO factory_mix_batches (company_id, cost_per_kg, total_cost) VALUES ($1, 0.9, 90) RETURNING id`,
    [w.companyId]
  );
  const source = await w.one(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, supplier_id, cost_per_kg, total_cost)
     VALUES ($1, $2, 0.9, 90) RETURNING id`,
    [batch, supplier]
  );
  const bale = await w.one(
    `INSERT INTO factory_bales (company_id, reference_number, cost_per_kg, total_cost) VALUES ($1, $2, 0.9, 45) RETURNING id`,
    [w.companyId, `${w.tag}B`]
  );
  return { container, rawStock, batch, source, bale, supplier };
}

function snapshot(rows: Rows, over: Partial<Rows> = {}) {
  const r = { ...rows, ...over };
  return {
    containers: [{ id: r.container, finalPayableAmount: "500", ratePerKgUsd: "0.5", finalPayableAmountUsd: "500" }],
    rawStockRows: [{ id: r.rawStock, costPerKg: "0.5", costPerKgUsd: "0.5" }],
    mixBatchSources: [{ id: r.source, costPerKg: "0.5", totalCost: "50" }],
    mixBatches: [{ id: r.batch, costPerKg: "0.5", totalCost: "50" }],
    bales: [{ id: r.bale, costPerKg: "0.5", totalCost: "25" }],
    suppliers: [{ id: r.supplier, currentRawMaterialCostPerKgUsd: "0.5" }],
  };
}

async function logEntry(w: FactoryWorld, snap: unknown, companyId = w.companyId, undone = false) {
  return w.one(
    `INSERT INTO factory_recalc_undo_log (company_id, description, snapshot, container_count, undone_at)
     VALUES ($1, 'replay', $2::jsonb, 1, $3) RETURNING id`,
    [companyId, JSON.stringify(snap), undone ? new Date() : null]
  );
}

async function costs(w: FactoryWorld, rows: Rows) {
  const [row] = await w.q(
    `SELECT
       (SELECT final_payable_amount::text FROM factory_containers WHERE id = $1) AS container,
       (SELECT cost_per_kg::text FROM factory_raw_stock WHERE id = $2) AS raw_stock,
       (SELECT cost_per_kg::text FROM factory_mix_batch_sources WHERE id = $3) AS source,
       (SELECT total_cost::text FROM factory_mix_batches WHERE id = $4) AS batch,
       (SELECT total_cost::text FROM factory_bales WHERE id = $5) AS bale,
       (SELECT current_raw_material_cost_per_kg_usd::text FROM factory_suppliers WHERE id = $6) AS supplier`,
    [rows.container, rows.rawStock, rows.source, rows.batch, rows.bale, rows.supplier]
  );
  return Object.values(row).map(Number);
}

describe("raw-stock recalc undo log", () => {
  it("lists this company's entries newest first and refuses non-admins", async () => {
    await withFactoryWorld(async (w) => {
      const rows = await seed(w);
      const first = await logEntry(w, snapshot(rows));
      const second = await logEntry(w, snapshot(rows), w.companyId, true);
      const res = await w.agent.get(`${URL}-log`);
      expect(res.status).toBe(200);
      expect(res.body.map((row: { id: number }) => row.id)).toEqual(expect.arrayContaining([first, second]));
      expect(res.body.find((row: { id: number }) => row.id === second).undoneAt).toBeTruthy();
      const manager = await w.agentFor("Manager");
      expect((await manager.get(`${URL}-log`)).status).toBe(403);
    });
  });
});

describe("raw-stock recalc undo", () => {
  it("refuses a missing, non-numeric or unsigned undo before the handler runs", async () => {
    await withFactoryWorld(async (w) => {
      for (const id of [undefined, "abc", 0]) {
        const res = await undo(w, id);
        expect(res.status).toBe(400);
      }
      // Without reason / idempotency key the privileged-write guard refuses.
      expect((await w.agent.post(URL).send({ undoLogId: 1 })).status).toBe(403);
    });
  });

  it("refuses an unknown entry and another company's entry with 404", async () => {
    await withFactoryWorld(async (w) => {
      const rows = await seed(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreign = await logEntry(w, snapshot(rows), other);
      for (const id of [foreign, foreign + 100000]) {
        const res = await undo(w, id);
        expect(res.status).toBe(404);
        expect(res.body.message).toBe("Undo log entry not found");
      }
      expect(await costs(w, rows)).toEqual([900, 0.9, 0.9, 90, 45, 0.9]);
    });
  });

  it("refuses an entry that was already undone", async () => {
    await withFactoryWorld(async (w) => {
      const rows = await seed(w);
      const id = await logEntry(w, snapshot(rows), w.companyId, true);
      const res = await undo(w, id);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("This recalculation has already been undone.");
      expect(await costs(w, rows)).toEqual([900, 0.9, 0.9, 90, 45, 0.9]);
    });
  });

  it.each([
    ["container", "container"],
    ["rawStock", "raw_stock"],
    ["source", "source"],
    ["batch", "mix_batch"],
    ["bale", "bale"],
    ["supplier", "supplier"],
  ] as const)("rolls back the whole undo when snapshot %s row is gone", async (key, label) => {
    await withFactoryWorld(async (w) => {
      const rows = await seed(w);
      const id = await logEntry(w, snapshot(rows, { [key]: rows[key] + 1000000 }));
      const res = await undo(w, id);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(new RegExp(`^Undo: ${label} \\d+ not found`));
      expect(await costs(w, rows)).toEqual([900, 0.9, 0.9, 90, 45, 0.9]);
      const [log] = await w.q(`SELECT undone_at FROM factory_recalc_undo_log WHERE id = $1`, [id]);
      expect(log.undone_at).toBeNull();
    });
  });

  it("returns 500 when the snapshot is malformed", async () => {
    await withFactoryWorld(async (w) => {
      const id = await logEntry(w, { containers: [] });
      const res = await undo(w, id);
      expect(res.status).toBe(500);
    });
  });

  it("restores every snapshot row, marks the entry undone and audits it", async () => {
    await withFactoryWorld(async (w) => {
      const rows = await seed(w);
      const id = await logEntry(w, snapshot(rows));
      const res = await undo(w, id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        containersRestored: 1,
        rawStockRowsRestored: 1,
        mixBatchSourcesRestored: 1,
        mixBatchesRestored: 1,
        balesRestored: 1,
        suppliersRestored: 1,
      });
      expect(await costs(w, rows)).toEqual([500, 0.5, 0.5, 50, 25, 0.5]);
      const [log] = await w.q(`SELECT undone_at, undone_by_username FROM factory_recalc_undo_log WHERE id = $1`, [id]);
      expect(log.undone_at).not.toBeNull();
      expect(log.undone_by_username).toBe(w.username);
      const audit = await w.q(
        `SELECT changes FROM audit_log WHERE table_name = 'factory_recalc_undo_log' AND record_id = $1 AND company_id = $2`,
        [String(id), w.companyId]
      );
      expect(audit[0].changes).toMatchObject({ containersRestored: 1, suppliersRestored: 1 });
      const again = await undo(w, id);
      expect(again.status).toBe(400);
    });
  });
});
