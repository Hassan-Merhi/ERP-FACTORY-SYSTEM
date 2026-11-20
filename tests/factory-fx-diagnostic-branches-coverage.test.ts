/**
 * Branches of server/routes/factory/suppliers/fxDiagnosticRoutes.ts that
 * factory-fx-diagnostic-repair.test.ts does not reach, over HTTP against
 * PostgreSQL in one rolled-back factory company per test.
 *
 * Pinned: the diagnostic reports unresolved containers without supplier,
 * rate or (blank) status as "none"/"UNKNOWN", unresolved charges and
 * commissions whose container belongs to another company with null container
 * details, and groups several rows under one container. The repair refuses an
 * unknown source, a non-numeric id, a non-positive rate and an unknown row;
 * an unreadable token, and a token bound to another company, source, row,
 * rate or user, are INVALID_TOKEN; a token whose captured state no longer
 * matches is STALE_TOKEN; charges and commissions are repaired with an audit
 * row on their own table.
 */
import { describe, expect, it } from "vitest";

import { signRepairToken, REPAIR_TOKEN_TTL_MS } from "../server/services/factory/repairToken";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

const GET = "/api/factory/suppliers/fx-diagnostic";
const REPAIR = "/api/factory/suppliers/fx-diagnostic/repair";

async function supplier(w: FactoryWorld, companyId = w.companyId) {
  return w.one(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
    companyId,
    `${w.tag}SUP${nextSeq()}`,
  ]);
}

async function container(
  w: FactoryWorld,
  opts: { currency?: string | null; supplierId?: number | null; status?: string | null; companyId?: number } = {}
) {
  return w.one(
    `INSERT INTO factory_containers (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd,
       fx_rate_confirmed, status)
     VALUES ($1, $2, $3, $4, '1', false, $5) RETURNING id`,
    [
      opts.companyId ?? w.companyId,
      `${w.tag}C${nextSeq()}`,
      opts.supplierId ?? null,
      opts.currency === undefined ? "EUR" : opts.currency,
      opts.status === undefined ? "PENDING" : opts.status,
    ]
  );
}

const charge = (w: FactoryWorld, containerId: number, supplierId: number | null = null) =>
  w.one(
    `INSERT INTO factory_offload_additional_charges (company_id, container_id, description, amount, currency_code,
       fx_rate_to_usd, fx_rate_confirmed, supplier_id)
     VALUES ($1, $2, 'Handling', 50, 'ZMW', '1', false, $3) RETURNING id`,
    [w.companyId, containerId, supplierId]
  );

const commission = (w: FactoryWorld, containerId: number, confirmed = false) =>
  w.one(
    `INSERT INTO factory_container_commissions (company_id, container_id, person_name, commission_rate,
       commission_total, currency_code, fx_rate_to_usd, fx_rate_confirmed)
     VALUES ($1, $2, 'Broker', 1, 20, 'CDF', $3, $4) RETURNING id`,
    [w.companyId, containerId, confirmed ? "0.0004" : "1", confirmed]
  );

describe("FX diagnostic grouping", () => {
  it("reports missing supplier, currency, status and foreign containers", () =>
    withFactoryWorld(async (w) => {
      const sup = await supplier(w);
      const foreignSupplier = await supplier(w, await otherCompany(w));
      const bare = await container(w, { currency: "GBP", status: "" });
      const foreignSupplied = await container(w, { supplierId: foreignSupplier });
      const usd = await container(w, { currency: "USD", supplierId: sup, status: "OFFLOADED" });
      const foreignContainer = await container(w, { companyId: await otherCompany(w) });
      await charge(w, usd);
      await charge(w, usd, sup);
      await charge(w, foreignContainer);
      await commission(w, usd);
      await commission(w, foreignContainer);
      await commission(w, usd, true);

      const res = await w.agent.get(GET);
      expect(res.status).toBe(200);
      expect(res.body.totals).toMatchObject({
        containersScanned: 2,
        chargesScanned: 3,
        commissionsScanned: 3,
        unresolvedCount: 7,
        manualReviewRequiredCount: 3,
      });
      const row = (source: string, containerId: number) =>
        res.body.rows.filter(
          (r: { source: string; containerId: number }) => r.source === source && r.containerId === containerId
        );
      expect(row("container", bare)[0]).toMatchObject({ supplierId: null, supplierName: null, amountNative: null });
      expect(row("container", foreignSupplied)[0]).toMatchObject({ supplierId: foreignSupplier, supplierName: null });
      expect(row("offload_additional_charge", foreignContainer)[0]).toMatchObject({
        containerNumber: null,
        supplierId: null,
        status: null,
      });
      expect(row("commission", foreignContainer)[0]).toMatchObject({ containerNumber: null, supplierName: null });
      expect(row("commission", usd)[0]).toMatchObject({ supplierId: sup, status: "OFFLOADED" });
      expect(res.body.byCurrency).toEqual({ GBP: 1, EUR: 1, ZMW: 3, CDF: 2 });
      expect(res.body.byStatus.UNKNOWN).toBe(3);
      const usdGroup = res.body.byContainer.find((g: { containerId: number }) => g.containerId === usd);
      expect(usdGroup.rows).toHaveLength(3);
      expect(res.body.bySupplier.find((s: { supplierId: number | null }) => s.supplierId === null).count).toBe(3);
    }));
});

describe("FX repair validation and tokens", () => {
  it("refuses a bad source, id, rate and an unknown row", () =>
    withFactoryWorld(async (w) => {
      const id = await container(w);
      const cases: Array<[Record<string, unknown>, number, RegExp]> = [
        [{ source: "invoice", id, fxRateToUsd: 1.1 }, 400, /source must be one of/],
        [{ source: "container", id: "abc", fxRateToUsd: 1.1 }, 400, /id must be a number/],
        [{ source: "container", id, fxRateToUsd: 0 }, 400, /positive number/],
        [{ source: "container", id: 999999999, fxRateToUsd: 1.1 }, 404, /not found/],
      ];
      for (const [body, status, message] of cases) {
        const res = await w.agent.post(REPAIR).send(body);
        expect(res.status).toBe(status);
        expect(res.body.message).toMatch(message);
      }
      expect((await w.agent.post(REPAIR).send(undefined)).status).toBe(400);
    }));

  it("refuses tokens bound to another request or captured from an older row state", () =>
    withFactoryWorld(async (w) => {
      const id = await container(w);
      const preview = await w.agent.post(REPAIR).send({ source: "container", id, fxRateToUsd: 1.08 });
      expect(preview.status).toBe(200);
      const base = {
        companyId: w.companyId,
        source: "container",
        id,
        newFxRateToUsd: 1.08,
        oldFxRateToUsd: preview.body.plan.oldFxRateToUsd,
        oldFxRateConfirmed: preview.body.plan.oldFxRateConfirmed,
        versionTag: preview.body.plan.versionTag,
        userId: w.userId,
        expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS,
      };
      const apply = (token: unknown) =>
        w.agent
          .post(REPAIR)
          .send({ source: "container", id, fxRateToUsd: 1.08, confirm: true, confirmationToken: token });
      expect((await apply(12345)).body.code).toBe("INVALID_TOKEN");
      for (const change of [
        { companyId: w.companyId + 1 },
        { source: "commission" },
        { id: id + 1 },
        { newFxRateToUsd: 1.09 },
        { userId: "someone-else" },
      ]) {
        const res = await apply(signRepairToken({ ...base, ...change }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("INVALID_TOKEN");
      }
      for (const change of [{ oldFxRateToUsd: "2" }, { oldFxRateConfirmed: true }, { versionTag: "2020-01-01" }]) {
        const stale = await apply(signRepairToken({ ...base, ...change }));
        expect(stale.status).toBe(400);
        expect(stale.body.code).toBe("STALE_TOKEN");
      }
      const [row] = await w.q(`SELECT fx_rate_confirmed FROM factory_containers WHERE id = $1`, [id]);
      expect(row.fx_rate_confirmed).toBe(false);
    }));
});

describe("FX repair of charges and commissions", () => {
  it("repairs a charge and a commission and audits each on its own table", () =>
    withFactoryWorld(async (w) => {
      const host = await container(w, { currency: "USD" });
      const chargeId = await charge(w, host);
      const commissionId = await commission(w, host);
      for (const [source, id, table] of [
        ["offload_additional_charge", chargeId, "factory_offload_additional_charges"],
        ["commission", commissionId, "factory_container_commissions"],
      ] as const) {
        const preview = await w.agent.post(REPAIR).send({ source, id, fxRateToUsd: "0.05" });
        expect(preview.status, preview.text).toBe(200);
        const applied = await w.agent.post(REPAIR).send({
          source,
          id,
          fxRateToUsd: "0.05",
          confirm: true,
          confirmationToken: preview.body.confirmationToken,
        });
        expect(applied.status, applied.text).toBe(200);
        expect(applied.body.result.applied).toBe(true);
        const audit = await w.q(
          `SELECT 1 FROM audit_log WHERE company_id = $1 AND table_name = $2 AND record_id::text = $3`,
          [w.companyId, table, String(id)]
        );
        expect(audit).toHaveLength(1);
      }
    }));
});
