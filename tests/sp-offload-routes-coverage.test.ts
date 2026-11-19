/**
 * Supplier Partner offload (server/routes/sp/spOffloadRoutes.ts), one
 * rolled-back transaction per test.
 *
 * In the app three guards run first on POST /api/sp/offload (prepaid company
 * guard, re-offload preparation, concurrency guard) and answer most malformed
 * requests themselves. To pin the handler's own defence-in-depth refusals, the
 * handler is also invoked directly (registered on a recording stand-in app)
 * with the world's real session and database; the success path and the second
 * offload go through the full HTTP stack.
 *
 * Pinned: every validation and lifecycle refusal leaves the container open with
 * no voucher, movement or prepaid usage; container invoice charges and each
 * charge kind land on the right credit account; the agent leg refuses without
 * the parent intercompany account.
 */
import { describe, expect, it } from "vitest";

import { registerSpOffloadRoutes } from "../server/routes/sp/spOffloadRoutes";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

type Handler = (req: unknown, res: unknown, next: () => void) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler>();
registerSpOffloadRoutes(
  new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (path: string, ...chain: Handler[]) =>
          handlers.set(`${method.toUpperCase()} ${path}`, chain[chain.length - 1]),
    }
  ) as never
);

/** Invoke a handler itself (after requireAuth) as the world's Admin. */
async function direct(w: FactoryWorld, route: string, body: Record<string, unknown> = {}) {
  let status = 200;
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
  };
  const req = {
    body,
    query: {},
    params: {},
    headers: {},
    session: { currentCompanyId: w.companyId, userId: w.userId },
  };
  await handlers.get(route)!(req, res, () => undefined);
  return { status, body: payload };
}

interface SpWorld {
  locationId: number;
  stockItemId: number;
}

/** Turn the world's company into a set-up Supplier Partner company. */
async function spCompany(w: FactoryWorld): Promise<SpWorld> {
  await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
  const setup = await w.agent.post("/api/sp/setup").send({
    confirmation: "CHANGE SP SETUP",
    reason: "SP offload coverage world",
    idempotencyKey: `setup-${w.tag}`,
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  const stockItemId = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'SP item', 'PCS', true) RETURNING id`,
    [w.companyId, `${w.tag}-ITEM`]
  );
  return { locationId: w.locationId, stockItemId };
}

async function container(w: FactoryWorld, sp: SpWorld, extra: Record<string, unknown> = {}, lines = true) {
  const res = await w.agent.post("/api/sp/containers").send({
    supplierName: "Offload Supplier",
    containerNumber: `${w.tag}-C${Math.floor(Math.random() * 1e6)}`,
    invoiceNumber: `${w.tag}-INV`,
    invoiceDate: "2026-06-01",
    invoiceTotalUsd: 1000,
    discountPct: 10,
    freightEstimateUsd: 0,
    lines: lines
      ? [{ articleCode: `${w.tag}-ITEM`, description: "Item", qty: 50, unitRateUsd: 20, stockItemId: sp.stockItemId }]
      : [],
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return Number(res.body.id);
}

const offload = (w: FactoryWorld, body: Record<string, unknown>) => direct(w, "POST /api/sp/offload", body);
const offloadHttp = (w: FactoryWorld, body: Record<string, unknown>) => w.agent.post("/api/sp/offload").send(body);

const sideEffects = async (w: FactoryWorld, containerId: number) => {
  const [row] = await w.q(
    `SELECT (SELECT status FROM sp_containers WHERE id = $2) AS status,
            (SELECT COUNT(*)::int FROM sp_offloads WHERE company_id = $1) AS offloads,
            (SELECT COUNT(*)::int FROM sp_stock_movements WHERE company_id = $1) AS movements,
            (SELECT COUNT(*)::int FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'SP-STOCK-%') AS stock_vouchers`,
    [w.companyId, containerId]
  );
  return row;
};
const untouched = { status: "open", offloads: 0, movements: 0, stock_vouchers: 0 };

const ledger = (w: FactoryWorld, code: string) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, $2::varchar, $2::text, 'Liability', '0', TRUE) RETURNING id`,
    [w.companyId, `${w.tag}${code}`]
  );

describe("SP offload refusals", () => {
  it("refuses a non-SP company and an SP company that was never set up", async () => {
    await withFactoryWorld(async (w) => {
      const notSp = await offload(w, { containerId: 1, offloadDate: "2026-06-02", locationId: w.locationId });
      expect(notSp.status).toBe(403);
      expect((await direct(w, "GET /api/sp/parent-agents")).status).toBe(403);
      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      const unset = await offload(w, { containerId: 1, offloadDate: "2026-06-02", locationId: w.locationId });
      expect(unset.status).toBe(400);
      expect(unset.body.message).toBe("SP accounts not configured. Run setup first.");
    });
  });

  it("validates the request before locking the container", async () => {
    await withFactoryWorld(async (w) => {
      const sp = await spCompany(w);
      const id = await container(w, sp);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ offloadDate: "2026-06-02", locationId: sp.locationId }, "containerId and offloadDate are required"],
        [{ containerId: id, offloadDate: "2026-06-02" }, "locationId is required"],
        [
          { containerId: id, offloadDate: "2026-06-02", locationId: 2_000_000_000 },
          "Invalid location for this company",
        ],
        [{ containerId: "1.5", offloadDate: "2026-06-02", locationId: sp.locationId }, "Invalid containerId"],
      ];
      for (const [body, message] of cases) {
        const res = await offload(w, body);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
      }
      const missing = await offload(w, {
        containerId: 2_000_000_000,
        offloadDate: "2026-06-02",
        locationId: sp.locationId,
      });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("SP_OFFLOAD_NOT_FOUND");
      expect(await sideEffects(w, id)).toEqual(untouched);
    });
  });

  it("refuses an empty container and unknown or over-used charge references without side effects", async () => {
    await withFactoryWorld(async (w) => {
      const sp = await spCompany(w);
      const empty = await container(w, sp, {}, false);
      const res = await offload(w, { containerId: empty, offloadDate: "2026-06-02", locationId: sp.locationId });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SP_OFFLOAD_EMPTY");

      const id = await container(w, sp);
      const prepaid = await w.one(
        `INSERT INTO sp_prepaid_charges (company_id, container_id, prepaid_date, charge_type, amount_paid_usd, amount_used_usd)
         VALUES ($1, $2, '2026-06-01', 'freight', 10, 0) RETURNING id`,
        [w.companyId, id]
      );
      const bad: Array<[Record<string, unknown>, RegExp]> = [
        [
          { chargeType: "prepaid_used", amountUsd: 50, prepaidChargeId: String(prepaid) },
          /has only 10\.0000 remaining/,
        ],
        [{ chargeType: "prepaid_used", amountUsd: 5, prepaidChargeId: "2000000000" }, /not found for this company/],
        [{ chargeType: "paid_now", amountUsd: 5, creditBankAccountId: "2000000000" }, /Bank account/],
        [{ chargeType: "unpaid_payable", amountUsd: 5, creditLedgerAccountId: "2000000000" }, /Ledger account/],
        [{ chargeType: "other", amountUsd: 5, creditLedgerAccountId: "2000000000" }, /Ledger account/],
        [{ chargeType: "parent_agent", amountUsd: 5, parentAgentAccountId: "1" }, /intercompany account not found/],
      ];
      for (const [line, message] of bad) {
        const r = await offload(w, {
          containerId: id,
          offloadDate: "2026-06-02",
          locationId: sp.locationId,
          chargeLines: [line],
        });
        expect(r.status).toBe(500);
        expect(r.body.message).toMatch(message);
      }
      expect(await sideEffects(w, id)).toEqual(untouched);
      const [used] = await w.q(`SELECT amount_used_usd::float AS used FROM sp_prepaid_charges WHERE id = $1`, [
        prepaid,
      ]);
      expect(used.used).toBe(0);
    });
  });
});

describe("SP offload posting", () => {
  it("posts invoice charges and every charge kind, then refuses a second offload", async () => {
    await withFactoryWorld(async (w) => {
      const sp = await spCompany(w);
      const id = await container(w, sp, { freightEstimateUsd: 30, surchargeUsd: 5 });
      const payable = await ledger(w, "PAY");
      const other = await ledger(w, "OTH");
      const res = await offloadHttp(w, {
        containerId: id,
        offloadDate: "2026-06-02",
        locationId: String(sp.locationId),
        chargeLines: [
          {
            chargeType: "unpaid_payable",
            amountUsd: 7,
            creditLedgerAccountId: String(payable),
            description: "Handling",
          },
          { chargeType: "other", amountUsd: "3", creditLedgerAccountId: String(other) },
          { chargeType: "parent_agent", amountUsd: 4, description: "Agent" },
          { chargeType: "freight", amountUsd: 6 },
          { chargeType: "unpaid_payable", amountUsd: 0, creditLedgerAccountId: String(payable) },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // 50 x 20 x 0.9 = 900 base; 30 + 5 + 7 + 3 + 4 + 6 = 55 landed.
      expect(Number(res.body.totalBaseCostUsd)).toBe(900);
      expect(Number(res.body.totalLandedCostUsd)).toBe(55);
      expect(Number(res.body.totalFinalCostUsd)).toBe(955);
      const charges = await w.q(
        `SELECT charge_type, amount_usd::float AS amount FROM sp_offload_charges WHERE offload_id = $1 ORDER BY id`,
        [res.body.id]
      );
      expect(charges.map((c) => c.charge_type)).toEqual([
        "invoice_charge",
        "invoice_charge",
        "unpaid_payable",
        "other",
        "parent_agent",
        "freight",
      ]);
      const [movement] = await w.q(
        `SELECT final_unit_cost_usd::float AS cost FROM sp_stock_movements WHERE offload_id = $1`,
        [res.body.id]
      );
      expect(movement.cost).toBeCloseTo(19.1, 6);
      expect((await sideEffects(w, id)).status).toBe("offloaded");

      const again = await offload(w, { containerId: id, offloadDate: "2026-06-02", locationId: sp.locationId });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("SP_OFFLOAD_ALREADY_DONE");
      const replay = await offloadHttp(w, { containerId: id, offloadDate: "2026-06-03", locationId: sp.locationId });
      expect(replay.status).toBe(409);
    });
  });

  it("draws down a prepaid charge and credits a bank for a paid-now charge", async () => {
    await withFactoryWorld(async (w) => {
      const sp = await spCompany(w);
      const id = await container(w, sp);
      const prepaid = await w.one(
        `INSERT INTO sp_prepaid_charges (company_id, container_id, prepaid_date, charge_type, amount_paid_usd, amount_used_usd)
         VALUES ($1, $2, '2026-06-01', 'freight', 10, 2) RETURNING id`,
        [w.companyId, id]
      );
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
         VALUES ($1, $2::varchar, 'SP bank', 'SP bank', $2::text, '0', 'Dr') RETURNING id`,
        [w.companyId, `${w.tag}-BANK`]
      );
      const res = await offload(w, {
        containerId: id,
        offloadDate: "2026-06-02",
        locationId: sp.locationId,
        chargeLines: [
          { chargeType: "prepaid_used", amountUsd: 8, prepaidChargeId: String(prepaid) },
          { chargeType: "paid_now", amountUsd: 2, creditBankAccountId: String(bank) },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [used] = await w.q(`SELECT amount_used_usd::float AS used FROM sp_prepaid_charges WHERE id = $1`, [
        prepaid,
      ]);
      expect(used.used).toBe(10);
      const bankLines = await w.q(
        `SELECT ve.credit_amount::float AS credit FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
          WHERE v.company_id = $1 AND ve.bank_account_id = $2`,
        [w.companyId, bank]
      );
      expect(bankLines).toEqual([{ credit: 2 }]);
    });
  });

  it("lists the parent company's agent accounts", async () => {
    await withFactoryWorld(async (w) => {
      await spCompany(w);
      const parent = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}P`]
      );
      await w.q(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [parent, w.companyId]);
      const agentLedger = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2, 'Agent Ledger', 'Liability', '0', TRUE) RETURNING id`,
        [parent, `${w.tag}AG`]
      );
      await w.q(
        `INSERT INTO agent_accounts (company_id, account_name, account_type, account_id) VALUES ($1, 'Agent One', 'ledger', $2)`,
        [parent, `ledger-${agentLedger}`]
      );
      const res = await w.agent.get("/api/sp/parent-agents");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({
          account_name: "Agent One",
          ledger_account_id: agentLedger,
          ledger_name: "Agent Ledger",
        }),
      ]);
    });
  });
});
