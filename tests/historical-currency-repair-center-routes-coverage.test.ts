/**
 * Historical currency repair-center routes
 * (server/routes/historicalCurrencyRepairCenterRoutes.ts): role gate,
 * diagnostic read, dry-run plan with a signed token, and apply refusals
 * (missing/tampered token, another user's token, another company's row,
 * a row changed after preview) before a successful apply. Rolled back per
 * test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/accounts/multi-currency/repair-center";

const openingLedger = (w: FactoryWorld, companyId = w.companyId, code = `${w.tag}OB`) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Opening cash', 'Cash', 50, 'Dr') RETURNING id`,
    [companyId, code]
  );

const repairOf = (id: number, amount = "50") => ({
  kind: "ledger",
  id,
  currency: "USD",
  historicalRate: "1",
  nativeAmount: amount,
  side: "Dr",
  note: "approved",
});

describe("historical currency repair center routes", () => {
  it("refuses roles other than Admin, Owner or Developer", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      expect((await manager.get(BASE)).status).toBe(403);
      expect((await manager.post(`${BASE}/plan`).send({ repairs: [] })).status).toBe(403);
      expect((await manager.post(`${BASE}/apply`).send({})).status).toBe(403);
    });
  });

  it("returns the diagnostic without writing and refuses an empty or foreign plan", async () => {
    await withFactoryWorld(async (w) => {
      const diag = await w.agent.get(BASE);
      expect(diag.status).toBe(200);
      expect(diag.body).toMatchObject({ companyId: w.companyId, writePerformed: false });
      expect(typeof diag.body.totalCases).toBe("number");

      expect((await w.agent.post(`${BASE}/plan`).send({ repairs: [] })).status).toBe(400);
      expect((await w.agent.post(`${BASE}/plan`).send({})).status).toBe(400);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await openingLedger(w, other, `${w.tag}XOB`);
      const refused = await w.agent.post(`${BASE}/plan`).send({ repairs: [repairOf(foreign)] });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(/not found in the selected company/);
    });
  });

  it("plans with a token, refuses bad, foreign-user and stale confirmations, then applies", async () => {
    await withFactoryWorld(async (w) => {
      const ledgerId = await openingLedger(w);
      const repairs = [repairOf(ledgerId)];
      const plan = await w.agent.post(`${BASE}/plan`).send({ repairs });
      expect(plan.status).toBe(200);
      expect(plan.body).toMatchObject({ dryRun: true, writePerformed: false, plan: { itemCount: 1 } });
      const token = plan.body.confirmationToken as string;

      const missing = await w.agent.post(`${BASE}/apply`).send({ repairs });
      expect(missing.status).toBe(409);
      expect(missing.body.code).toBe("INVALID_REPAIR_CONFIRMATION");
      const tampered = await w.agent.post(`${BASE}/apply`).send({ repairs, confirmationToken: `${token}x` });
      expect(tampered.body.code).toBe("INVALID_REPAIR_CONFIRMATION");

      const otherAdmin = await w.agentFor("Admin");
      const foreignUser = await otherAdmin.post(`${BASE}/apply`).send({ repairs, confirmationToken: token });
      expect(foreignUser.status).toBe(409);
      expect(foreignUser.body.message).toMatch(/company or user mismatch/);

      const changed = await w.agent
        .post(`${BASE}/apply`)
        .send({ repairs: [repairOf(ledgerId, "60")], confirmationToken: token });
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe("STALE_REPAIR_PLAN");
      const audits = await w.q(`SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'repair'`, [w.companyId]);
      expect(audits).toEqual([]);

      const applied = await w.agent.post(`${BASE}/apply`).send({ repairs, confirmationToken: token });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ dryRun: false, writePerformed: true });
      const after = await w.q(`SELECT 1 FROM audit_log WHERE company_id = $1 AND action = 'repair'`, [w.companyId]);
      expect(after).toHaveLength(1);
    });
  });
});
