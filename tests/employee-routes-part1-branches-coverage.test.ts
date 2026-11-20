/**
 * Employee bale rates, bale percentage rates, PATCH and DELETE
 * (registerEmployeeRoutesPart1). Validation, role and company refusals are
 * checked to write nothing.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function employee(w: FactoryWorld, code: string, companyId = w.companyId) {
  return w.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Eve', 'Staff', '2025-01-01') RETURNING id`,
    [companyId, `${w.tag}${code}`]
  );
}
const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${w.tag}X`]);

describe("employee bale rates", () => {
  it("keeps only positive rates with a location and replaces the previous set", async () => {
    await withFactoryWorld(async (w) => {
      const id = await employee(w, "E1");
      expect((await w.agent.put(`/api/employees/${id}/bale-rates`).send({ rates: "x" })).status).toBe(400);
      const res = await w.agent.put(`/api/employees/${id}/bale-rates`).send({
        rates: [
          { locationId: w.locationId, rate: "1.25", sourceCompanyId: String(w.companyId) },
          { locationId: w.locationId, rate: "0" },
          { locationId: null, rate: "3" },
          { locationId: String(w.locationId), rate: "abc" },
        ],
      });
      expect(res.body).toEqual({ ok: true });
      const rows = await w.q(
        `SELECT location_id, rate::text, source_company_id FROM employee_bale_rates WHERE employee_id = $1`,
        [id]
      );
      expect(rows).toEqual([{ location_id: w.locationId, rate: "1.2500", source_company_id: w.companyId }]);
      await w.agent.put(`/api/employees/${id}/bale-rates`).send({ rates: [] });
      expect(await w.q(`SELECT 1 FROM employee_bale_rates WHERE employee_id = $1`, [id])).toEqual([]);
    });
  });

  it("stores and reads percentage rates", async () => {
    await withFactoryWorld(async (w) => {
      const id = await employee(w, "E1");
      expect((await w.agent.put(`/api/employees/${id}/bale-pct-rates`).send({})).status).toBe(400);
      const res = await w.agent.put(`/api/employees/${id}/bale-pct-rates`).send({
        rates: [{ locationId: w.locationId, pct: "2.5" }, { locationId: w.locationId, pct: "-1" }, { pct: "4" }],
      });
      expect(res.body).toEqual({ ok: true });
      const read = await w.agent.get(`/api/employees/${id}/bale-pct-rates`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual([expect.objectContaining({ locationId: w.locationId, sourceCompanyId: null })]);
      expect(Number(read.body[0].pct)).toBe(2.5);
    });
  });

  it("refuses another company's employee and missing ids before the handler, writing nothing", async () => {
    await withFactoryWorld(async (w) => {
      const foreign = await employee(w, "F1", await otherCompany(w));
      // The company-resource access policy owns this check: the employee must
      // belong to the session company or the request never reaches the handler.
      for (const target of [foreign, 999999999]) {
        const rate = await w.agent
          .put(`/api/employees/${target}/bale-rates`)
          .send({ rates: [{ locationId: w.locationId, rate: "9" }] });
        expect(rate.status).toBe(404);
        expect(rate.body.message).toBe("Record not found");
        const pct = await w.agent
          .put(`/api/employees/${target}/bale-pct-rates`)
          .send({ rates: [{ locationId: w.locationId, pct: "9" }] });
        expect(pct.status).toBe(404);
        expect(pct.body.message).toBe("Record not found");
      }
      const written = await w.q(
        `SELECT company_id FROM employee_bale_rates WHERE employee_id = ANY($1::int[])
         UNION ALL SELECT company_id FROM employee_bale_pct_rates WHERE employee_id = ANY($1::int[])`,
        [[foreign, 999999999]]
      );
      expect(written).toEqual([]);
    });
  });
});

describe("PATCH /api/employees/:id", () => {
  it("validates, normalizes optional fields and refuses other companies", async () => {
    await withFactoryWorld(async (w) => {
      const id = await employee(w, "E1");
      expect((await w.agent.patch(`/api/employees/abc`).send({ firstName: "x" })).status).toBe(400);
      const empty = await w.agent.patch(`/api/employees/${id}`).send({});
      expect(empty.body.message).toBe("No fields to update");

      const res = await w.agent.patch(`/api/employees/${id}`).send({
        firstName: "Eva",
        lastName: "Updated",
        code: `${w.tag}E1B`,
        monthlySalary: "500",
        department: "Ops",
        active: false,
        joinDate: "2025-02-01",
        employeeGroupId: "none",
        salesBonusPct: "",
        salesBonusPctSourceCompanyId: null,
        salesBonusPctLocationId: "",
        balesBonusRate: null,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ firstName: "Eva", department: "Ops", active: false, salesBonusPct: null });

      const set = await w.agent.patch(`/api/employees/${id}`).send({
        salesBonusPct: "2",
        salesBonusPctSourceCompanyId: String(w.companyId),
        salesBonusPctLocationId: String(w.locationId),
        balesBonusRate: "0.5",
        employeeGroupId: null,
      });
      expect(set.body).toMatchObject({
        salesBonusPctSourceCompanyId: w.companyId,
        salesBonusPctLocationId: w.locationId,
      });

      const foreign = await employee(w, "F1", await otherCompany(w));
      expect((await w.agent.patch(`/api/employees/${foreign}`).send({ firstName: "Hijack" })).status).toBe(404);
      const [row] = await w.q<{ first_name: string }>(`SELECT first_name FROM employees WHERE id = $1`, [foreign]);
      expect(row.first_name).toBe("Eve");
    });
  });
});

describe("DELETE /api/employees/:id", () => {
  it("refuses non-admins, bad ids, missing and foreign employees", async () => {
    await withFactoryWorld(async (w) => {
      const id = await employee(w, "E1");
      const manager = await w.agentFor("Manager");
      expect((await manager.delete(`/api/employees/${id}`)).status).toBe(403);
      expect((await w.agent.delete(`/api/employees/abc`)).status).toBe(400);
      expect((await w.agent.delete(`/api/employees/2147483000`)).status).toBe(404);
      const foreign = await employee(w, "F1", await otherCompany(w));
      expect((await w.agent.delete(`/api/employees/${foreign}`)).status).toBe(404);
      expect(
        await w.q(`SELECT 1 FROM employees WHERE id = ANY($1::int[]) AND deleted_at IS NULL`, [[id, foreign]])
      ).toHaveLength(2);
    });
  });

  it("asks for confirmation when the employee carries a balance, and deletes otherwise", async () => {
    await withFactoryWorld(async (w) => {
      const owed = await employee(w, "E2");
      await w.q(`UPDATE employees SET current_balance = 150 WHERE id = $1`, [owed]);
      const conflict = await w.agent.delete(`/api/employees/${owed}`);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ requiresConfirmation: true, employeeBalance: 150 });
      expect(await w.q(`SELECT 1 FROM employees WHERE id = $1`, [owed])).toHaveLength(1);
      expect((await w.agent.delete(`/api/employees/${owed}?forceDelete=true`)).status).toBe(200);

      const advanced = await employee(w, "E4");
      await w.q(
        `INSERT INTO salary_advances (company_id, employee_id, advance_date, amount, remaining_balance) VALUES ($1, $2, '2026-01-01', 10, 10)`,
        [w.companyId, advanced]
      );
      const blocked = await w.agent.delete(`/api/employees/${advanced}`);
      expect(blocked.status).toBe(400);
      expect(await w.q(`SELECT 1 FROM employees WHERE id = $1`, [advanced])).toHaveLength(1);

      const clean = await employee(w, "E3");
      const ok = await w.agent.delete(`/api/employees/${clean}`);
      expect(ok.status).toBe(200);
      expect(ok.body.message).toBe("Employee deleted successfully");
    });
  });
});
