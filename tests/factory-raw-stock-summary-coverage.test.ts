/**
 * GET /api/factory/raw-stock
 * (server/routes/factory/raw-stock/registerRawStockReceiptRoutesPart1.ts) over
 * HTTP in one rolled-back factory company per test: per-supplier aggregation of
 * opening-balance and container receipts, unsupplied containers, deleted rows
 * left out, supplier and standalone manual adjustments (ADD / REMOVE / DEDUCT),
 * open-batch reservations, completed-batch consumption for manual-only
 * suppliers, used value at recorded source cost and locked-rate valuation
 * (persisted, or derived when the supplier has none yet).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

type Row = Record<string, any>;

async function supplier(w: FactoryWorld, name: string, rate: string | null, categoryId: number | null = null) {
  return w.one(
    `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd, supplier_category_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [w.companyId, name, rate, categoryId]
  );
}

let seq = 0;
async function receipt(
  w: FactoryWorld,
  supplierId: number | null,
  opts: { status?: string; received: string; used?: string; cost: string; usd?: string; deleted?: boolean; at?: string }
) {
  const containerId = await w.one(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id, status, currency_code)
     VALUES ($1, $2, $3, $4, 'CDF') RETURNING id`,
    [w.companyId, `${w.tag}-C${++seq}`, supplierId, opts.status ?? "OFFLOADED"]
  );
  await w.q(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd,
       offloaded_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, CASE WHEN $8 THEN now() END)`,
    [
      w.companyId,
      containerId,
      opts.received,
      opts.used ?? "0",
      opts.cost,
      opts.usd ?? null,
      opts.at ?? "2026-01-01",
      opts.deleted ?? false,
    ]
  );
  return containerId;
}

const adjust = (w: FactoryWorld, supplierId: number | null, type: string, kg: string, cost = "0", label?: string) =>
  w.q(
    `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, cost_per_kg, date, material_label)
     VALUES ($1, $2, $3, $4, $5, '2026-01-05', $6)`,
    [w.companyId, supplierId, type, kg, cost, label ?? null]
  );

async function batchWithSource(w: FactoryWorld, status: string, supplierId: number, kg: string, cost: string) {
  const batchId = await w.one(
    `INSERT INTO factory_mix_batches (company_id, batch_code, batch_number, status, total_weight_kg)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.companyId, `${w.tag}-MB${++seq}`, seq, status, kg]
  );
  await w.q(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, supplier_id, weight_kg, total_cost, cost_per_kg, source_type)
     VALUES ($1, $2, $3, $4, $4::numeric / $3::numeric, 'SUPPLIER')`,
    [batchId, supplierId, kg, cost]
  );
}

describe("raw stock summary", () => {
  it("aggregates receipts per supplier at the locked rate", () =>
    withFactoryWorld(async (w) => {
      const categoryId = await w.one(
        `INSERT INTO factory_supplier_categories (company_id, name) VALUES ($1, 'Mixed Rags') RETURNING id`,
        [w.companyId]
      );
      const a = await supplier(w, "Alpha", "0.5", categoryId);
      await receipt(w, a, { status: "OPENING_BALANCE", received: "100", used: "20", cost: "1000", usd: "0.4" });
      await receipt(w, a, { received: "300", used: "0", cost: "1200", usd: "0.6", at: "2026-02-01" });
      await receipt(w, a, { received: "999", cost: "1", deleted: true });
      await receipt(w, null, { received: "50", used: "10", cost: "2" });
      await adjust(w, a, "ADD", "40", "0.5");
      await adjust(w, a, "REMOVE", "10");
      await adjust(w, a, "DEDUCT", "500");
      await batchWithSource(w, "OPEN", a, "15", "7.5");
      await batchWithSource(w, "COMPLETED", a, "5", "2.5");

      const res = await w.agent.get("/api/factory/raw-stock");
      expect(res.status).toBe(200);
      const alpha = res.body.find((r: Row) => r.supplierId === a);
      expect(alpha).toMatchObject({
        supplierName: "Alpha",
        categoryId,
        categoryName: "Mixed Rags",
        sourceType: "CONTAINER",
        receivedKg: "440.000",
        usedKg: "30.000",
        remainingKg: "410.000",
        freeKg: "410.000",
        reservedKg: "15.000",
        costPerKgUsd: "0.500000",
        valueRemainingUsd: "205.00",
        usedValueUsd: "10.00",
      });
      expect(alpha.lastOffloaded).toMatch(/^2026-02-01/);
      const orphan = res.body.find((r: Row) => r.supplierId === null && r.sourceType === "CONTAINER");
      // No supplier and no stored USD cost: the local cost stands in for USD.
      expect(orphan).toMatchObject({ supplierName: "Unknown", remainingKg: "40.000", valueRemainingUsd: "80.00" });
    }));

  it("lists manual suppliers and standalone materials from adjustments", () =>
    withFactoryWorld(async (w) => {
      const manual = await supplier(w, "Manual Only", "0.25");
      await adjust(w, manual, "ADD", "100", "0.25");
      await batchWithSource(w, "COMPLETED", manual, "30", "7.5");
      await batchWithSource(w, "CLOSED", manual, "10", "2.5");
      await adjust(w, null, "ADD", "20", "1.5", "Offcuts");
      await adjust(w, null, "ADD", "20", "2.5", "Offcuts");
      await adjust(w, null, "REMOVE", "10", "0", "Offcuts");
      await adjust(w, null, "REMOVE", "5");

      const res = await w.agent.get("/api/factory/raw-stock");
      expect(res.status).toBe(200);
      const row = res.body.find((r: Row) => r.supplierId === manual);
      expect(row).toMatchObject({
        supplierName: "Manual Only",
        sourceType: "MANUAL",
        receivedKg: "100.000",
        usedKg: "40.000",
        freeKg: "60.000",
        valueRemainingUsd: "15.00",
        usedValueUsd: "10.00",
      });
      expect(row.adjustmentIds).toHaveLength(1);
      const offcuts = res.body.find((r: Row) => r.supplierName === "Offcuts");
      expect(offcuts).toMatchObject({
        supplierId: null,
        receivedKg: "40.000",
        usedKg: "10.000",
        costPerKg: "2.000000",
        valueRemainingUsd: "60.00",
      });
      expect(offcuts.adjustmentIds).toHaveLength(3);
      const unlabeled = res.body.find((r: Row) => r.supplierName === "Manual Stock");
      expect(unlabeled).toMatchObject({ receivedKg: "0.000", usedKg: "5.000" });
    }));

  it("derives a locked rate for a supplier without one", () =>
    withFactoryWorld(async (w) => {
      const fresh = await supplier(w, "Fresh", null);
      await receipt(w, fresh, { received: "200", cost: "0.8", usd: "0.8" });
      const res = await w.agent.get("/api/factory/raw-stock");
      expect(res.status).toBe(200);
      const row = res.body.find((r: Row) => r.supplierId === fresh);
      expect(row.freeKg).toBe("200.000");
      expect(Number(row.costPerKgUsd)).toBeGreaterThanOrEqual(0);
      expect(Number(row.valueRemainingUsd)).toBeCloseTo(200 * Number(row.costPerKgUsd), 2);
    }));
});
