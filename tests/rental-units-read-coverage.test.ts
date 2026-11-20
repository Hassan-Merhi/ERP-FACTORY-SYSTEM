/**
 * GET {prefix}/units (server/routes/rental/units-contracts/units-read.ts)
 * against real rental rows in one rolled-back transaction per test.
 *
 * Pinned: billing-day-aware expected rent, POSTED-only paid amounts (guarantee
 * movements excluded), scheduled totals, prepaid credit, guarantee remaining,
 * internal warehouse leases shown on the Shops tab, leases shared from
 * another company, and the Properties projection of internal ERP/Factory
 * leases (read-only references, inactive units hidden).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let seq = 0;

async function unit(w: FactoryWorld, module: string, unitType: string, companyId = w.companyId, active = true) {
  return w.one(
    `INSERT INTO property_units (company_id, module, unit_type, unit_number, location_group, active)
     VALUES ($1, $2, $3, $4, 'G', $5) RETURNING id`,
    [companyId, module, unitType, `${w.tag}-${++seq}`, active]
  );
}

async function contract(
  w: FactoryWorld,
  unitId: number,
  module: string,
  extra: { companyId?: number; internal?: boolean; linked?: number | null; guarantee?: string } = {}
) {
  return w.one(
    `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status,
       is_internal, linked_company_id, guarantee_amount)
     VALUES ($1, $2, $3, 'Tenant', '100.00', '2026-01-05', 'ACTIVE', $4, $5, $6) RETURNING id`,
    [
      extra.companyId ?? w.companyId,
      module,
      unitId,
      extra.internal ?? false,
      extra.linked ?? null,
      extra.guarantee ?? "0",
    ]
  );
}

async function month(
  w: FactoryWorld,
  contractId: number,
  unitId: number,
  module: string,
  m: number,
  companyId = w.companyId
) {
  return w.one(
    `INSERT INTO property_monthly_ledger (company_id, module, contract_id, unit_id, year, month, expected_amount)
     VALUES ($1, $2, $3, $4, 2026, $5, 100) RETURNING id`,
    [companyId, module, contractId, unitId, m]
  );
}

async function payment(
  w: FactoryWorld,
  c: { contractId: number; unitId: number; module: string; companyId?: number },
  amount: string,
  fields: { ledgerRowId?: number | null; status?: string; notes?: string; date?: string } = {}
) {
  await w.q(
    `INSERT INTO property_payments (company_id, module, contract_id, unit_id, ledger_row_id, amount, payment_date,
       for_year, for_month, posting_status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 2026, 1, $8, $9)`,
    [
      c.companyId ?? w.companyId,
      c.module,
      c.contractId,
      c.unitId,
      fields.ledgerRowId ?? null,
      amount,
      fields.date ?? "2026-01-10",
      fields.status ?? "POSTED",
      fields.notes ?? null,
    ]
  );
}

const units = (w: FactoryWorld, prefix: string, unitType: string, asOf = "2026-03-10") =>
  w.agent.get(`${prefix}/units`).query({ unitType }).set("X-Client-Date", asOf);

async function otherCompany(w: FactoryWorld, suffix: string, type = "factory") {
  return w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, $2) RETURNING id`, [
    `${w.tag}${suffix}`,
    type,
  ]);
}

describe("rental units read", () => {
  it("computes expected, paid, scheduled, prepaid credit and guarantee remaining per unit", async () => {
    await withFactoryWorld(async (w) => {
      const vacant = await unit(w, "FACTORY", "WAREHOUSE");
      const unitId = await unit(w, "FACTORY", "WAREHOUSE");
      const contractId = await contract(w, unitId, "FACTORY", { guarantee: "300" });
      const jan = await month(w, contractId, unitId, "FACTORY", 1);
      await month(w, contractId, unitId, "FACTORY", 2);
      await month(w, contractId, unitId, "FACTORY", 12);
      const c = { contractId, unitId, module: "FACTORY" };
      await payment(w, c, "120", { ledgerRowId: jan });
      await payment(w, c, "50", { ledgerRowId: jan, notes: "[Guarantee applied] Jan" });
      await payment(w, c, "300"); // guarantee deposit: no ledger row
      await payment(w, c, "100", { ledgerRowId: jan, status: "SCHEDULED", date: "2026-04-01" });

      const res = await units(w, "/api/factory/rental", "WAREHOUSE");
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const byId = new Map(res.body.map((u: { id: number }) => [u.id, u]));
      expect(byId.get(vacant)).toMatchObject({ contract: null, outstanding: null, guaranteeRemaining: null });
      expect(byId.get(unitId)).toMatchObject({
        expectedAsOf: 200,
        paidAsOf: 170,
        outstanding: 30,
        prepaidCredit: null,
        scheduledAmount: 100,
        guaranteeRemaining: 250,
        billingDay: 5,
        isShared: false,
      });

      await payment(w, c, "100", { ledgerRowId: jan });
      const credit = await units(w, "/api/factory/rental", "WAREHOUSE");
      const row = credit.body.find((u: { id: number }) => u.id === unitId);
      expect(row).toMatchObject({ outstanding: 0, prepaidCredit: 70 });
    });
  });

  it("shows internal warehouse leases and leases shared from another company on the Shops tab", async () => {
    await withFactoryWorld(async (w) => {
      const shop = await unit(w, "FACTORY", "SHOP");
      const internalWarehouse = await unit(w, "FACTORY", "WAREHOUSE");
      await contract(w, internalWarehouse, "FACTORY", { internal: true });
      const plainWarehouse = await unit(w, "FACTORY", "WAREHOUSE");
      await contract(w, plainWarehouse, "FACTORY");

      const owner = await otherCompany(w, "OWN");
      const sharedUnit = await unit(w, "ERP", "SHOP", owner);
      const sharedContract = await contract(w, sharedUnit, "ERP", {
        companyId: owner,
        linked: w.companyId,
        guarantee: "80",
      });
      const row = await month(w, sharedContract, sharedUnit, "ERP", 1, owner);
      const sc = { contractId: sharedContract, unitId: sharedUnit, module: "ERP", companyId: owner };
      await payment(w, sc, "150", { ledgerRowId: row });
      await payment(w, sc, "30", { ledgerRowId: row, notes: "[Guarantee applied]" });
      await payment(w, sc, "40", { ledgerRowId: row, status: "SCHEDULED", date: "2026-05-01" });

      const res = await units(w, "/api/factory/rental", "SHOP");
      expect(res.status).toBe(200);
      const ids = res.body.map((u: { id: number }) => u.id);
      expect(ids).toEqual([shop, internalWarehouse, sharedUnit]);
      expect(res.body[2]).toMatchObject({
        isShared: true,
        isInternalLeaseProjection: false,
        sourceModule: null,
        ownerCompanyName: `${w.tag}OWN`,
        expectedAsOf: 100,
        paidAsOf: 180,
        outstanding: 0,
        prepaidCredit: 80,
        scheduledAmount: 40,
        guaranteeRemaining: 50,
      });
    });
  });

  it("projects internal ERP and Factory leases into Properties as read-only references", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET company_type = 'properties' WHERE id = $1`, [w.companyId]);
      const source = await otherCompany(w, "SRC");
      const factoryWarehouse = await unit(w, "FACTORY", "SHOP", source);
      const factoryLease = await contract(w, factoryWarehouse, "FACTORY", {
        companyId: source,
        internal: true,
        linked: w.companyId,
      });
      const erpShop = await unit(w, "ERP", "SHOP", source);
      await contract(w, erpShop, "ERP", { companyId: source, internal: true, linked: w.companyId });
      const retired = await unit(w, "ERP", "WAREHOUSE", source, false);
      await contract(w, retired, "ERP", { companyId: source, internal: true, linked: w.companyId });

      const warehouses = await units(w, "/api/properties/rental", "WAREHOUSE");
      expect(warehouses.status).toBe(200);
      expect(warehouses.body.map((u: { id: number }) => u.id)).toEqual([factoryWarehouse]);
      expect(warehouses.body[0]).toMatchObject({
        isShared: true,
        isInternalLeaseProjection: true,
        sourceModule: "FACTORY",
        sourceCompanyId: source,
        expectedAsOf: 0,
        prepaidCredit: null,
      });
      expect(warehouses.body[0].contract.id).toBe(factoryLease);

      const shops = await units(w, "/api/properties/rental", "SHOP");
      expect(shops.body.map((u: { id: number }) => u.id)).toEqual([erpShop]);
    });
  });

  it("returns only owned units for an ERP warehouse view", async () => {
    await withFactoryWorld(async (w) => {
      const owner = await otherCompany(w, "ERPOWN");
      const sharedUnit = await unit(w, "ERP", "WAREHOUSE", owner);
      await contract(w, sharedUnit, "ERP", { companyId: owner, linked: w.companyId });
      const res = await units(w, "/api/factory/rental", "WAREHOUSE");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
