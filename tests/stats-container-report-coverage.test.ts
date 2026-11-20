/**
 * GET /api/reports/containers (server/routes/stats/registerStatsReportsRoutesPart2.ts)
 * over HTTP against PostgreSQL, one rolled-back company per test.
 *
 * Pinned: the report is scoped to the active company by default; a specific
 * company must be a positive integer the user belongs to (a non-member
 * company is 403); "all companies" means the user's memberships, or every
 * company for a Developer; status, supplier and date filters apply to the
 * import date, or to the offload date for "offloaded"; an offloaded
 * container's charge breakdown comes from its latest offload, with the
 * remainder of total charges reported as additional charges.
 *
 * Bug pinned: the voucher-number regexes (lines 139-141) are written as
 * /-\\d+$/ inside regex literals, which match a literal backslash and "d",
 * so live DUTY-/OFFICE-/TRANS-/XFER-/CHG- vouchers are never matched to a
 * container and the persisted offload amounts are always used.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

async function supplier(w: FactoryWorld, companyId = w.companyId) {
  return w.one(
    `INSERT INTO suppliers (company_id, code, email, legal_name) VALUES ($1, $2, '', 'Acme Ltd') RETURNING id`,
    [companyId, `${w.tag}S${nextSeq()}`]
  );
}

async function container(
  w: FactoryWorld,
  fields: { number: string; supplierId: number; status?: string; importDate?: string; offloadDate?: string | null },
  companyId = w.companyId
) {
  return w.one(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, offload_date,
       items_total, charges_total, grand_total)
     VALUES ($1, $2, $3, $4, $5, $6, 100, 20, 120) RETURNING id`,
    [
      companyId,
      fields.number,
      fields.supplierId,
      fields.status ?? "OTW",
      fields.importDate ?? "2026-03-01",
      fields.offloadDate ?? null,
    ]
  );
}

const numbers = (body: { containers: Array<{ containerNumber: string }> }) =>
  body.containers.map((c) => c.containerNumber).sort();

describe("container report scope", () => {
  it("refuses an invalid or non-member specific company and lists a member company", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const otherSupplier = await supplier(w, other);
      await container(w, { number: `${w.tag}OTHER`, supplierId: otherSupplier }, other);
      const own = await supplier(w);
      await container(w, { number: `${w.tag}OWN`, supplierId: own });

      for (const bad of ["abc", "0", "-3"]) {
        const res = await w.agent.get("/api/reports/containers").query({ specificCompanyId: bad });
        expect(res.status).toBe(400);
      }
      const denied = await w.agent.get("/api/reports/containers").query({ specificCompanyId: String(other) });
      expect(denied.status).toBe(403);
      const self = await w.agent.get("/api/reports/containers").query({ specificCompanyId: String(w.companyId) });
      expect(numbers(self.body)).toEqual([`${w.tag}OWN`]);

      await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
        w.userId,
        other,
      ]);
      const member = await w.agent.get("/api/reports/containers").query({ specificCompanyId: String(other) });
      expect(member.status).toBe(200);
      expect(numbers(member.body)).toEqual([`${w.tag}OTHER`]);
      const all = await w.agent.get("/api/reports/containers").query({ allCompanies: "true" });
      expect(numbers(all.body)).toEqual([`${w.tag}OTHER`, `${w.tag}OWN`]);
    }));

  it("limits 'all companies' to memberships unless the user is a Developer", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      await container(w, { number: `${w.tag}HIDDEN`, supplierId: await supplier(w, other) }, other);
      await container(w, { number: `${w.tag}MINE`, supplierId: await supplier(w) });
      const admin = await w.agent.get("/api/reports/containers").query({ allCompanies: "true" });
      expect(numbers(admin.body)).toEqual([`${w.tag}MINE`]);

      await w.setRole("Developer");
      // The session caches the role chosen at set-company time.
      expect((await w.agent.post("/api/auth/set-company").send({ companyId: w.companyId })).status).toBe(200);
      const developer = await w.agent.get("/api/reports/containers").query({ allCompanies: "true" });
      expect(developer.status).toBe(200);
      expect(numbers(developer.body)).toEqual(expect.arrayContaining([`${w.tag}HIDDEN`, `${w.tag}MINE`]));
      const specific = await w.agent.get("/api/reports/containers").query({ specificCompanyId: String(other) });
      expect(numbers(specific.body)).toEqual([`${w.tag}HIDDEN`]);
    }));
});

describe("container report filters and charges", () => {
  it("filters by status, supplier and the matching date column", () =>
    withFactoryWorld(async (w) => {
      const a = await supplier(w);
      const b = await supplier(w);
      await container(w, { number: `${w.tag}A1`, supplierId: a, importDate: "2026-02-01" });
      await container(w, { number: `${w.tag}A2`, supplierId: a, importDate: "2026-04-01" });
      await container(w, { number: `${w.tag}B1`, supplierId: b, importDate: "2026-03-01" });
      await container(w, {
        number: `${w.tag}OFF`,
        supplierId: b,
        status: "OFFLOADED",
        importDate: "2025-01-01",
        offloadDate: "2026-03-15",
      });
      const range = await w.agent
        .get("/api/reports/containers")
        .query({ status: "OTW", startDate: "2026-03-01", endDate: "2026-04-30" });
      expect(numbers(range.body)).toEqual([`${w.tag}A2`, `${w.tag}B1`]);
      expect(range.body.filters).toEqual({
        status: "OTW",
        supplierId: null,
        startDate: "2026-03-01",
        endDate: "2026-04-30",
      });
      const bySupplier = await w.agent.get("/api/reports/containers").query({ supplierId: String(a) });
      expect(numbers(bySupplier.body)).toEqual([`${w.tag}A1`, `${w.tag}A2`]);
      const offloaded = await w.agent
        .get("/api/reports/containers")
        .query({ status: "offloaded", startDate: "2026-03-01", endDate: "2026-03-31" });
      expect(numbers(offloaded.body)).toEqual([`${w.tag}OFF`]);
      const outside = await w.agent
        .get("/api/reports/containers")
        .query({ status: "Offloaded", endDate: "2026-03-01" });
      expect(outside.body.containers).toEqual([]);
    }));

  it("breaks offload charges down from the latest offload and ignores live charge vouchers", () =>
    withFactoryWorld(async (w) => {
      const s = await supplier(w);
      const number = `${w.tag}CH`;
      const id = await container(w, { number, supplierId: s, status: "OFFLOADED", offloadDate: "2026-03-15" });
      const bare = await container(w, { number: `${w.tag}NOOFF`, supplierId: s, status: "OFFLOADED" });
      await w.q(
        `INSERT INTO container_offloads (container_id, location_id, total_bales, additional_cost_per_bale,
           duties, office_charges, transport_fees, transfer_charges, total_charges)
         VALUES ($1, $2, 1, 0, 1, 1, 1, 1, 50), ($1, $2, 1, 0, 10, 5, 3, 2, 45)`,
        [id, w.locationId]
      );
      await w.q(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-03-15', 77), ($1, $3, 'Journal', '2026-03-15', 9),
                ($1, 'MISC-1', 'Journal', '2026-03-15', 5)`,
        [w.companyId, `DUTY-${number}-123`, `CHG-${number}-123-1`]
      );
      const res = await w.agent.get("/api/reports/containers");
      expect(res.status).toBe(200);
      const byNumber = new Map(res.body.containers.map((c: { containerNumber: string }) => [c.containerNumber, c]));
      expect(byNumber.get(number)).toMatchObject({
        // The live DUTY (77) and CHG (9) vouchers are not matched; the latest offload's amounts are used.
        chargeBreakdown: {
          duties: "10.00",
          officeCharges: "5.00",
          transportFees: "3.00",
          transferCharges: "2.00",
          additionalCharges: "5.00",
        },
        offloadingCharges: "25.00",
        totalContainerCost: "145.00",
      });
      expect(byNumber.get(`${w.tag}NOOFF`)).toMatchObject({ offloadingCharges: "0.00", totalContainerCost: "120.00" });
      expect(bare).toBeGreaterThan(0);
      expect(res.body.summary).toMatchObject({ totalContainers: 2, totalGrandTotal: 240, totalOffloadingCharges: 25 });
    }));
});
