import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { STALE_COSTS, readStaleReplayCosts, seedStaleReplaySupplier } from "./helpers/historicalReplayFixture";

const PREVIEW = "/api/factory/raw-stock/recalc/historical-replay";
const APPLY = `${PREVIEW}/apply`;
const classify = (id: number | string) => `${PREVIEW}/adjustments/${id}/valuation-basis`;
const EVIDENCE = "Signed transfer note TN-41 values the stock at 3 USD per kg.";

async function adjustment(
  world: FactoryWorld,
  values: { supplierId: number | null; type?: string; currency?: string; cost?: number; unclassified?: boolean }
) {
  // An insert trigger defaults supplier ADD rows to QUANTITY_ONLY; legacy rows
  // predating it carry NULL, which is what the replay safety gate looks for.
  const id = await world.one(
    `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, cost_per_kg, currency_code, date)
     VALUES ($1, $2, $3, 10, $4, $5, '2026-01-03') RETURNING id`,
    [world.companyId, values.supplierId, values.type ?? "ADD", values.cost ?? 3, values.currency ?? "USD"]
  );
  if (values.unclassified) {
    await world.q(`UPDATE factory_raw_material_adjustments SET valuation_basis = NULL WHERE id = $1`, [id]);
  }
  return id;
}

describe("historical replay Phase 6 preview", () => {
  it("returns the company-wide financial impact with a balance-on-table projection", async () => {
    await withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId);
      const res = await world.agent.get(PREVIEW);
      expect(res.status, res.text).toBe(200);
      expect(res.body.supplierRows).toEqual([
        expect.objectContaining({ supplierId: seeded.supplierId, safeToRepair: true, endingExpectedRate: 2 }),
      ]);
      const impact = res.body.financialImpact;
      expect(impact.allSafetyGatesPassed).toBe(true);
      expect(impact.supplierImpacts).toHaveLength(1);
      expect(impact.batchImpacts).toEqual([
        expect.objectContaining({
          batchId: seeded.batchId,
          currentTotalCost: 40,
          projectedTotalCost: 80,
          valueDifference: 40,
        }),
      ]);
      // 40 kg mixed, 20 kg baled: 20 kg on the table moves from 1 to 2 USD/kg.
      expect(impact.currentBalanceOnTableAsset).toBe(20);
      expect(impact.projectedBalanceOnTableAsset).toBe(40);
      expect(impact.balanceOnTableDifference).toBe(20);
      expect(impact.totalNetPositionEffect).toBe(impact.rawMaterialDifference + 20);
    });
  });

  it("projects zero balance-on-table rates for a company with no mix batches", async () => {
    await withFactoryWorld(async (world) => {
      const res = await world.agent.get(PREVIEW);
      expect(res.status).toBe(200);
      expect(res.body.supplierRows).toEqual([]);
      if (res.body.financialImpact) {
        expect(res.body.financialImpact.projectedBalanceOnTableAsset).toBe(0);
        expect(res.body.financialImpact.batchImpacts).toEqual([]);
      }
    });
  });

  it("is limited to Admin and Developer roles", async () => {
    await withFactoryWorld(async (world) => {
      const manager = await world.agentFor("Manager");
      expect((await manager.get(PREVIEW)).status).toBe(403);
      expect(
        (await manager.patch(classify(1)).send({ valuationBasis: "QUANTITY_ONLY", basisEvidence: EVIDENCE })).status
      ).toBe(403);
    });
  });
});

describe("historical replay Phase 6 prepare guards", () => {
  it("refuses an empty selection and a scope whose company-wide gates fail", async () => {
    await withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId);
      const empty = await world.agent.post(APPLY).send({ supplierIds: [] });
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe("HISTORICAL_REPLAY_EMPTY_SCOPE");

      await adjustment(world, { supplierId: seeded.supplierId, unclassified: true });
      const gated = await world.agent.post(APPLY).send({ supplierIds: [seeded.supplierId] });
      expect(gated.status).toBe(409);
      expect(gated.body.code).toBe("HISTORICAL_REPLAY_SAFETY_GATES_FAILED");
      expect(gated.body.unclassifiedAdjustmentRows).toHaveLength(1);
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
    });
  });
});

describe("historical replay adjustment valuation classification", () => {
  it("validates evidence, id and basis before touching the database", async () => {
    await withFactoryWorld(async (world) => {
      const short = await world.agent
        .patch(classify(1))
        .send({ valuationBasis: "QUANTITY_ONLY", basisEvidence: "short" });
      expect(short.status).toBe(400);
      expect(short.body.code).toBe("HISTORICAL_ADJUSTMENT_EVIDENCE_REQUIRED");
      const badId = await world.agent
        .patch(classify("abc"))
        .send({ valuationBasis: "QUANTITY_ONLY", basisEvidence: EVIDENCE });
      expect(badId.status).toBe(400);
      expect(badId.body.message).toBe("Invalid adjustment id");
      const badBasis = await world.agent.patch(classify(1)).send({ valuationBasis: "GUESS", basisEvidence: EVIDENCE });
      expect(badBasis.status).toBe(400);
      expect(badBasis.body.message).toMatch(/valuationBasis must be/);
      const missing = await world.agent
        .patch(classify(2_000_000_000))
        .send({ valuationBasis: "QUANTITY_ONLY", basisEvidence: EVIDENCE });
      expect(missing.status).toBe(404);
    });
  });

  it("refuses unsupported adjustments and leaves them unclassified", async () => {
    await withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId);
      const deduct = await adjustment(world, { supplierId: seeded.supplierId, type: "DEDUCT" });
      const manual = await adjustment(world, { supplierId: null });
      const euro = await adjustment(world, { supplierId: seeded.supplierId, currency: "EUR" });
      const free = await adjustment(world, { supplierId: seeded.supplierId, cost: 0 });
      const cases: Array<[number, string, RegExp]> = [
        [deduct, "QUANTITY_ONLY", /Only supplier-linked ADD/],
        [manual, "QUANTITY_ONLY", /Only supplier-linked ADD/],
        [euro, "VALUED_TRANSFER", /not denominated in USD/],
        [free, "OPENING_BALANCE", /positive USD cost/],
      ];
      for (const [id, valuationBasis, message] of cases) {
        const res = await world.agent.patch(classify(id)).send({ valuationBasis, basisEvidence: EVIDENCE });
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(message);
      }
      const rows = await world.q(
        `SELECT id, valuation_basis FROM factory_raw_material_adjustments WHERE company_id = $1 ORDER BY id`,
        [world.companyId]
      );
      expect(rows).toEqual([
        { id: deduct, valuation_basis: null },
        { id: manual, valuation_basis: null },
        { id: euro, valuation_basis: "QUANTITY_ONLY" },
        { id: free, valuation_basis: "QUANTITY_ONLY" },
      ]);
    });
  });

  it("classifies a valued USD transfer and audits the evidence, and only within the caller's company", async () => {
    await withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId);
      const id = await adjustment(world, { supplierId: seeded.supplierId, unclassified: true });
      const res = await world.agent
        .patch(classify(id))
        .send({ valuationBasis: "valued_transfer", basisEvidence: `  ${EVIDENCE}  ` });
      expect(res.status, res.text).toBe(200);
      expect(res.body).toEqual({ success: true, adjustmentId: id, valuationBasis: "VALUED_TRANSFER" });
      const [row] = await world.q(`SELECT valuation_basis FROM factory_raw_material_adjustments WHERE id = $1`, [id]);
      expect(row.valuation_basis).toBe("VALUED_TRANSFER");
      const [audit] = await world.q(
        `SELECT changes FROM audit_log WHERE company_id = $1 AND action = 'historical_replay_adjustment_classified'`,
        [world.companyId]
      );
      expect(audit.changes).toMatchObject({ before: null, after: "VALUED_TRANSFER", basisEvidence: EVIDENCE });

      const otherCompany = await world.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${world.tag}X`.slice(0, 18)]
      );
      const foreign = await world.one(
        `INSERT INTO factory_raw_material_adjustments (company_id, type, kg, cost_per_kg, date)
         VALUES ($1, 'ADD', 5, 3, '2026-01-03') RETURNING id`,
        [otherCompany]
      );
      const crossCompany = await world.agent
        .patch(classify(foreign))
        .send({ valuationBasis: "QUANTITY_ONLY", basisEvidence: EVIDENCE });
      expect(crossCompany.status).toBe(404);
    });
  });
});
