/**
 * Rental contract routes (start contract, modify rent, edit contract info) on
 * the factory rental prefix through the real app, one rolled-back transaction
 * per test: validation, units and contracts of another company or another
 * rental module, a second active contract on one unit (and a new one after the
 * first ended), create-only refusals, rent changes from this or next month and
 * the monthly-ledger clean-up when the start date moves.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/rental";
const now = new Date();
const thisYear = now.getUTCFullYear();
const thisMonth = now.getUTCMonth() + 1;
const monthStart = `${thisYear}-${String(thisMonth).padStart(2, "0")}-01`;

let seq = 0;
async function unit(w: FactoryWorld, companyId = w.companyId, module = "FACTORY") {
  return w.one(
    `INSERT INTO property_units (company_id, unit_number, unit_type, location_group, module)
     VALUES ($1, $2, 'SHOP', 'Main', $3) RETURNING id`,
    [companyId, `${w.tag}-U${++seq}`, module]
  );
}

async function contract(w: FactoryWorld, unitId: number, companyId = w.companyId, start = "2026-01-01") {
  return w.one(
    `INSERT INTO property_contracts (company_id, unit_id, tenant_name, start_date, rental_amount, module)
     VALUES ($1, $2, 'Tenant', $3, 100, 'FACTORY') RETURNING id`,
    [companyId, unitId, start]
  );
}

async function ledgerRow(
  w: FactoryWorld,
  contractId: number,
  unitId: number,
  year: number,
  month: number,
  expected: string,
  paid: string
) {
  return w.one(
    `INSERT INTO property_monthly_ledger (company_id, contract_id, unit_id, year, month, expected_amount, paid_amount, module)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'FACTORY') RETURNING id`,
    [w.companyId, contractId, unitId, year, month, expected, paid]
  );
}

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`, [
    `${w.tag}O${++seq}`,
  ]);

const start = (w: FactoryWorld, body: Record<string, unknown>) => w.agent.post(`${BASE}/contracts`).send(body);

describe("start a rental contract", () => {
  it("refuses invalid bodies, foreign or other-module units and create-only fields", () =>
    withFactoryWorld(async (w) => {
      const own = await unit(w);
      const missing = await start(w, { unitId: own, startDate: monthStart, rentalAmount: "50" });
      expect(missing.status).toBe(400);
      const foreignUnit = await unit(w, await otherCompany(w));
      const foreign = await start(w, {
        unitId: foreignUnit,
        tenantName: "T",
        startDate: monthStart,
        rentalAmount: "50",
      });
      expect([foreign.status, foreign.body.message]).toEqual([404, "Unit not found"]);
      const propertiesUnit = await unit(w, w.companyId, "PROPERTIES");
      const otherModule = await start(w, {
        unitId: propertiesUnit,
        tenantName: "T",
        startDate: monthStart,
        rentalAmount: "50",
      });
      expect(otherModule.status).toBe(404);
      const rows = await w.q(`SELECT 1 FROM property_contracts WHERE company_id = $1`, [w.companyId]);
      expect(rows).toHaveLength(0);
    }));

  // FINDING pinned: linkedCompanyId is taken from the body with no check that
  // the user belongs to that company. A linked company may later settle the
  // contract's rent (rentalDueScheduledPaymentService.ts:124), so an Admin of
  // one company can tie a contract to any other company id.
  it("accepts a linkedCompanyId of a company the user has no role in", () =>
    withFactoryWorld(async (w) => {
      const own = await unit(w);
      const stranger = await otherCompany(w);
      const res = await start(w, {
        unitId: own,
        tenantName: "Linked",
        startDate: monthStart,
        rentalAmount: "50",
        linkedCompanyId: stranger,
      });
      expect(res.status).toBe(200);
      expect(res.body.linkedCompanyId).toBe(stranger);
      const other = await otherCompany(w);
      const edit = await w.agent
        .patch(`${BASE}/contracts/${res.body.id}/info`)
        .send({ tenantName: "Linked", startDate: monthStart, linkedCompanyId: other });
      expect(edit.status).toBe(200);
      const [row] = await w.q(`SELECT linked_company_id FROM property_contracts WHERE id = $1`, [res.body.id]);
      expect(row.linked_company_id).toBe(other);
    }));

  it("creates the contract with its audit and ledger rows, refuses a second active one, allows one after it ended", () =>
    withFactoryWorld(async (w) => {
      const own = await unit(w);
      const res = await start(w, { unitId: own, tenantName: "Amina", startDate: monthStart, rentalAmount: "75" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ unitId: own, tenantName: "Amina", module: "FACTORY", status: "ACTIVE" });
      const audit = await w.q(
        `SELECT action FROM audit_log WHERE table_name = 'property_contracts' AND record_id = $1`,
        [res.body.id]
      );
      expect(audit.map((a) => a.action)).toEqual(["create"]);
      const months = await w.q(
        `SELECT year, month, expected_amount::text AS e FROM property_monthly_ledger WHERE contract_id = $1`,
        [res.body.id]
      );
      expect(months).toContainEqual({ year: thisYear, month: thisMonth, e: "75.00" });

      const again = await start(w, { unitId: own, tenantName: "Bilal", startDate: monthStart, rentalAmount: "80" });
      expect([again.status, again.body.message]).toEqual([400, "Unit already has an active contract"]);
      await w.q(`UPDATE property_contracts SET status = 'ENDED', end_date = $2 WHERE id = $1`, [
        res.body.id,
        monthStart,
      ]);
      const after = await start(w, { unitId: own, tenantName: "Bilal", startDate: monthStart, rentalAmount: "80" });
      expect(after.status).toBe(200);
    }));
});

describe("modify rent", () => {
  it("refuses bad ids, bodies and another company's contract", () =>
    withFactoryWorld(async (w) => {
      const own = await contract(w, await unit(w));
      expect((await w.agent.patch(`${BASE}/contracts/abc/rent`).send({ newAmount: 1 })).status).toBe(400);
      const bad = await w.agent.patch(`${BASE}/contracts/${own}/rent`).send({ newAmount: 1, effectiveFrom: "later" });
      expect(bad.status).toBe(400);
      const other = await otherCompany(w);
      const foreign = await contract(w, await unit(w, other), other);
      const cross = await w.agent.patch(`${BASE}/contracts/${foreign}/rent`).send({ newAmount: 1 });
      expect([cross.status, cross.body.message]).toEqual([404, "Contract not found"]);
      const [row] = await w.q(`SELECT rental_amount::text AS r FROM property_contracts WHERE id = $1`, [foreign]);
      expect(row.r).toBe("100.00");
    }));

  it("changes unpaid months from this month or only from next month", () =>
    withFactoryWorld(async (w) => {
      const unitId = await unit(w);
      const id = await contract(w, unitId);
      const current = await ledgerRow(w, id, unitId, thisYear, thisMonth, "100", "0");
      const future = await ledgerRow(w, id, unitId, thisYear + 1, 1, "100", "0");
      const paidFuture = await ledgerRow(w, id, unitId, thisYear + 1, 2, "100", "100");
      const amount = async (rowId: number) =>
        (await w.q(`SELECT expected_amount::text AS e FROM property_monthly_ledger WHERE id = $1`, [rowId]))[0].e;

      const next = await w.agent.patch(`${BASE}/contracts/${id}/rent`).send({ newAmount: 120, effectiveFrom: "next" });
      expect(next.body).toEqual({ ok: true });
      expect([await amount(current), await amount(future), await amount(paidFuture)]).toEqual([
        "100.00",
        "120.00",
        "100.00",
      ]);
      await w.agent.patch(`${BASE}/contracts/${id}/rent`).send({ newAmount: "130" });
      expect([await amount(current), await amount(future)]).toEqual(["130.00", "130.00"]);
      const [c] = await w.q(`SELECT rental_amount::text AS r FROM property_contracts WHERE id = $1`, [id]);
      expect(c.r).toBe("130.00");
    }));
});

describe("edit contract info", () => {
  it("refuses bad ids, bodies and another company's contract", () =>
    withFactoryWorld(async (w) => {
      const own = await contract(w, await unit(w));
      const info = (id: number | string, body: Record<string, unknown>) =>
        w.agent.patch(`${BASE}/contracts/${id}/info`).send(body);
      expect((await info("abc", { tenantName: "T", startDate: "2026-01-01" })).status).toBe(400);
      const bad = await info(own, { tenantName: "", startDate: "2026-01-01" });
      expect([bad.status, bad.body.message]).toEqual([400, "Tenant name required"]);
      const other = await otherCompany(w);
      const foreign = await contract(w, await unit(w, other), other);
      expect((await info(foreign, { tenantName: "Hijack", startDate: "2026-01-01" })).status).toBe(404);
      const [row] = await w.q(`SELECT tenant_name FROM property_contracts WHERE id = $1`, [foreign]);
      expect(row.tenant_name).toBe("Tenant");
    }));

  it("moves the start date, cleans earlier months and restores zeroed paid months", () =>
    withFactoryWorld(async (w) => {
      const unitId = await unit(w);
      const id = await contract(w, unitId);
      const unpaidEarly = await ledgerRow(w, id, unitId, 2026, 1, "100", "0");
      const paidEarly = await ledgerRow(w, id, unitId, 2026, 2, "100", "60");
      const zeroedLater = await ledgerRow(w, id, unitId, 2026, 4, "0", "100");
      const res = await w.agent.patch(`${BASE}/contracts/${id}/info`).send({
        tenantName: "Renamed",
        startDate: "2026-03-01",
        guaranteeAmount: "200",
        guaranteePeriod: "3 months",
        isInternal: true,
        linkedCompanyId: null,
      });
      expect(res.body).toEqual({ ok: true });
      const rows = await w.q<{ id: number; e: string }>(
        `SELECT id, expected_amount::text AS e FROM property_monthly_ledger WHERE contract_id = $1 ORDER BY id`,
        [id]
      );
      expect(rows.find((r) => r.id === unpaidEarly)).toBeUndefined();
      expect(rows.find((r) => r.id === paidEarly)?.e).toBe("0.00");
      expect(rows.find((r) => r.id === zeroedLater)?.e).toBe("100.00");
      const [c] = await w.q(
        `SELECT tenant_name, start_date::text AS s, guarantee_amount::text AS g, guarantee_period, is_internal
           FROM property_contracts WHERE id = $1`,
        [id]
      );
      expect(c).toEqual({
        tenant_name: "Renamed",
        s: "2026-03-01",
        g: "200.00",
        guarantee_period: "3 months",
        is_internal: true,
      });
      // Same name and date again: the audit records no field changes.
      expect(
        (await w.agent.patch(`${BASE}/contracts/${id}/info`).send({ tenantName: "Renamed", startDate: "2026-03-01" }))
          .status
      ).toBe(200);
    }));
});
