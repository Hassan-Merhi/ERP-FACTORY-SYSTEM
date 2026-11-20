/**
 * ERP payroll bonus reads: bonus location options, the sales summary and the
 * server-side auto-calculation, over HTTP in one rolled-back transaction per
 * test.
 *
 * Pinned: required parameters, per-location bale rates and sales % rates,
 * the legacy single bale rate and single % bonus, the rule that a caller
 * supplied source company is honoured only when the user can access it.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let seq = 0;

async function sale(w: FactoryWorld, locationId: number, qty: string, total: string, companyId = w.companyId) {
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, location_id)
     VALUES ($1, 'Sales', $2, '2026-03-10', $3, $4) RETURNING id`,
    [companyId, `${w.tag}S${++seq}`, total, locationId]
  );
  const itemId = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'PCS') RETURNING id`,
    [companyId, `${w.tag}I${seq}`]
  );
  await w.q(
    `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
     VALUES ($1, $2, $3, 1, 0, $4, 0, $4)`,
    [voucherId, itemId, qty, total]
  );
}

async function employee(w: FactoryWorld, fields: Record<string, unknown> = {}) {
  return w.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, bales_bonus_rate, sales_bonus_pct,
       sales_bonus_pct_location_id)
     VALUES ($1, $2, 'Emp', $3, '2026-01-01', $4, $5, $6) RETURNING id`,
    [
      w.companyId,
      `${w.tag}E${++seq}`,
      `N${seq}`,
      fields.balesRate ?? null,
      fields.salesPct ?? null,
      fields.pctLocationId ?? null,
    ]
  );
}

async function otherCompanyWithLocation(w: FactoryWorld, suffix: string) {
  const companyId = await w.one(
    `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
    [`${w.tag}${suffix}`]
  );
  const locationId = await w.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far Shop') RETURNING id`,
    [companyId, `${w.tag}${suffix}L`]
  );
  return { companyId, locationId };
}

const auto = (w: FactoryWorld, body: Record<string, unknown>) =>
  w.agent.post("/api/payroll/auto-calculate-bonuses").send({ startDate: "2026-03-01", endDate: "2026-03-31", ...body });

describe("payroll bonus locations and sales summary", () => {
  it("lists owned locations and locations the company sells at", async () => {
    await withFactoryWorld(async (w) => {
      const far = await otherCompanyWithLocation(w, "OWN");
      await sale(w, far.locationId, "2", "20");
      const res = await w.agent.get("/api/payroll/bonus-locations");
      expect(res.status).toBe(200);
      const mine = res.body.locations.filter((l: { companyId: number }) => l.companyId === w.companyId);
      expect(mine).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: w.locationId, hasSales: false }),
          expect.objectContaining({ id: far.locationId, name: "Far Shop", hasSales: true }),
        ])
      );
    });
  });

  it("requires location and dates, totals cash sales, and refuses an inaccessible source company", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/payroll/sales-summary").query({ locationId: w.locationId })).status).toBe(400);
      await sale(w, w.locationId, "3", "45");
      const query = { locationId: w.locationId, startDate: "2026-03-01", endDate: "2026-03-31" };
      const own = await w.agent.get("/api/payroll/sales-summary").query(query);
      expect(own.body).toEqual({ totalSalesAmount: "45.00", totalQuantity: "3.000", locationName: "Yard" });

      // The handler itself does not check sourceCompanyId; the cross-company
      // reference guard in front of it refuses a company the user cannot access.
      const foreign = await otherCompanyWithLocation(w, "FX");
      await sale(w, foreign.locationId, "7", "70", foreign.companyId);
      const leak = await w.agent
        .get("/api/payroll/sales-summary")
        .query({ ...query, locationId: foreign.locationId, sourceCompanyId: foreign.companyId });
      expect(leak.status).toBe(403);
      expect(leak.body.totalSalesAmount).toBeUndefined();
    });
  });
});

describe("payroll bonus auto-calculation", () => {
  it("requires dates", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent.post("/api/payroll/auto-calculate-bonuses").send({ startDate: "2026-03-01" });
      expect(res.status).toBe(400);
    });
  });

  it("combines per-location bale and % rates, skipping zero rates and empty locations", async () => {
    await withFactoryWorld(async (w) => {
      await sale(w, w.locationId, "10", "200");
      const empty = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Empty') RETURNING id`,
        [w.companyId, `${w.tag}EMPTY`]
      );
      const emp = await employee(w);
      const idle = await employee(w);
      for (const [table, value, loc] of [
        ["employee_bale_rates", "1.5", w.locationId],
        ["employee_bale_rates", "0", w.locationId],
        ["employee_bale_rates", "2", empty],
        ["employee_bale_pct_rates", "5", w.locationId],
        ["employee_bale_pct_rates", "0", w.locationId],
        ["employee_bale_pct_rates", "5", empty],
      ] as const) {
        const text =
          table === "employee_bale_rates"
            ? `INSERT INTO employee_bale_rates (company_id, employee_id, location_id, rate) VALUES ($1, $2, $3, $4)`
            : `INSERT INTO employee_bale_pct_rates (company_id, employee_id, location_id, pct) VALUES ($1, $2, $3, $4)`;
        await w.q(text, [w.companyId, emp, loc, value]);
      }
      const res = await auto(w, {});
      expect(res.status).toBe(200);
      const mine = res.body.results.find((r: { employeeId: number }) => r.employeeId === emp);
      expect(mine.amount).toBe("25.00");
      expect(mine.breakdown).toEqual(["10 bales × $1.5 (Yard) = $15.00", "$200.00 sales × 5% (Yard) = $10.00"]);
      expect(res.body.results.some((r: { employeeId: number }) => r.employeeId === idle)).toBe(false);
    });
  });

  it("applies the legacy bale rate and % bonus, honouring only accessible source companies", async () => {
    await withFactoryWorld(async (w) => {
      await sale(w, w.locationId, "4", "100");
      const legacy = await employee(w, { balesRate: "2", salesPct: "10", pctLocationId: w.locationId });
      const noLocation = await employee(w, { balesRate: "2" });
      const own = await auto(w, { pctLocationId: w.locationId });
      const row = own.body.results.find((r: { employeeId: number }) => r.employeeId === legacy);
      expect(row).toMatchObject({ amount: "18.00" });
      expect(row.breakdown).toEqual(["4 bales × $2 (Yard) = $8.00", "$100.00 sales × 10% (Yard) = $10.00"]);
      expect(own.body.results.some((r: { employeeId: number }) => r.employeeId === noLocation)).toBe(false);

      // An inaccessible pct source company is ignored: the active company's own sales are used.
      const foreign = await otherCompanyWithLocation(w, "FY");
      await sale(w, w.locationId, "1", "900", foreign.companyId);
      const guarded = await auto(w, { pctLocationId: w.locationId, pctSourceCompanyId: foreign.companyId });
      const guardedRow = guarded.body.results.find((r: { employeeId: number }) => r.employeeId === legacy);
      expect(guardedRow.breakdown[1]).toBe("$100.00 sales × 10% (Yard) = $10.00");

      // An accessible source company (the active one) is honoured as given.
      const explicit = await auto(w, { pctLocationId: w.locationId, pctSourceCompanyId: w.companyId });
      expect(explicit.body.results.find((r: { employeeId: number }) => r.employeeId === legacy).amount).toBe("18.00");

      // A location the company does not sell at falls back to its owner's sales.
      const ownerOnly = await auto(w, { pctLocationId: foreign.locationId });
      const ownerRow = ownerOnly.body.results.find((r: { employeeId: number }) => r.employeeId === legacy);
      expect(ownerRow.breakdown).toEqual(["4 bales × $2 (Yard) = $8.00"]);
    });
  });
});

describe("payroll single employee bonus refusals", () => {
  it("refuses missing fields, non-positive amounts and foreign employees without posting", async () => {
    await withFactoryWorld(async (w) => {
      const post = (body: Record<string, unknown>) => w.agent.post("/api/payroll/bonus-employee").send(body);
      const emp = await employee(w);
      expect((await post({ employeeId: emp, date: "2026-03-01" })).status).toBe(400);
      const zero = await post({ employeeId: emp, amount: "-5", date: "2026-03-01" });
      expect(zero.status).toBe(400);
      expect(zero.body.message).toMatch(/positive number/);
      const missing = await post({ employeeId: 999999999, amount: "5", date: "2026-03-01" });
      expect(missing.status).toBe(404);
      const vouchers = await w.q(`SELECT id FROM vouchers WHERE company_id = $1 AND voucher_type = 'Journal'`, [
        w.companyId,
      ]);
      expect(vouchers).toEqual([]);
    });
  });
});
