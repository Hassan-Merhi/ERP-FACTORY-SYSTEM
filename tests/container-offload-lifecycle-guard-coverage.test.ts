/**
 * Container offload lifecycle preflight (POST / PATCH
 * /api/containers/:id/offload) over real HTTP in one rolled-back transaction
 * per test. Pins every refusal before the offload handler runs: bad ids and
 * locations, another company's container or location, non-offloadable
 * status, missing POs / lines, foreign or wrong-type ledgers, expense
 * additional charges, unavailable own-freight and parent-agent ledgers, the
 * concurrent-offload advisory lock, and that stale parent-freight metadata is
 * only logged.
 */
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let seq = 0;
const url = (id: number | string) => `/api/containers/${id}/offload`;

const company = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'erp') RETURNING id`, [
    `${w.tag}C${++seq}`,
  ]);
const ledger = (w: FactoryWorld, type: string, companyId = w.companyId) =>
  w.one(`INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`, [
    companyId,
    `${w.tag}L${++seq}`,
    `${type} ${seq}`,
    type,
  ]);

async function containerWithPo(
  w: FactoryWorld,
  o: {
    status?: string;
    lines?: boolean;
    po?: boolean;
    paidBy?: string;
    own?: number;
    parent?: number;
    companyId?: number;
  } = {}
) {
  const companyId = o.companyId ?? w.companyId;
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme', '') RETURNING id`,
    [companyId, `${w.tag}S${++seq}`]
  );
  const container = await w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status) VALUES ($1, $2, '2026-01-01', $3, $4) RETURNING id`,
    [companyId, `${w.tag}CN${++seq}`, supplier, o.status ?? "OTW"]
  );
  if (o.po === false) return container;
  const po = await w.one(
    `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, items_total, freight, freight_paid_by,
       freight_own_account_id, freight_parent_account_id)
     VALUES ($1, $2, $3, $4, 100, 5, $5, $6, $7) RETURNING id`,
    [companyId, container, `${w.tag}PO${++seq}`, supplier, o.paidBy ?? null, o.own ?? null, o.parent ?? null]
  );
  if (o.lines !== false) {
    const item = await w.one(
      `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Rag', 'KG') RETURNING id`,
      [companyId, `${w.tag}I${++seq}`]
    );
    await w.q(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'Rag', 10, 10, 100)`,
      [po, item]
    );
  }
  return container;
}

const refuse = async (
  w: FactoryWorld,
  id: number | string,
  body: Record<string, unknown>,
  status: number,
  message: string | RegExp
) => {
  const res = await w.agent.post(url(id)).send(body);
  expect(res.status).toBe(status);
  expect(res.body.message).toMatch(message);
  return res;
};

describe("request and ownership refusals", () => {
  it("refuses bad ids, missing locations and another company's container or location", () =>
    withFactoryWorld(async (w) => {
      const loc = { locationId: w.locationId };
      await refuse(w, 0, loc, 400, "Invalid id");
      const own = await containerWithPo(w);
      await refuse(w, own, {}, 400, "Location is required");
      const other = await company(w);
      const foreign = await containerWithPo(w, { companyId: other });
      await refuse(w, foreign, loc, 404, "Container not found for the selected company");
      const foreignLoc = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`,
        [other, `${w.tag}FL`]
      );
      await refuse(w, own, { locationId: foreignLoc }, 400, "Invalid location for the selected company");
      const [row] = await w.q(`SELECT status FROM containers WHERE id = $1`, [foreign]);
      expect(row.status).toBe("OTW");
    }));

  it("refuses non-offloadable containers and containers without POs or lines", () =>
    withFactoryWorld(async (w) => {
      const loc = { locationId: w.locationId };
      const closed = await refuse(w, await containerWithPo(w, { status: "CLOSED" }), loc, 409, /cannot be offloaded/);
      expect(closed.body.code).toBe("CONTAINER_NOT_OFFLOADABLE");
      await refuse(w, await containerWithPo(w, { po: false }), loc, 400, "Container has no purchase orders to offload");
      await refuse(
        w,
        await containerWithPo(w, { lines: false }),
        loc,
        400,
        "Container purchase orders have no line items"
      );
    }));

  it("refuses a second concurrent offload of the same container", () =>
    withFactoryWorld(async (w) => {
      const container = await containerWithPo(w);
      const other = new Client({ connectionString: process.env.DATABASE_URL });
      await other.connect();
      try {
        await other.query("SELECT pg_advisory_lock($1, $2)", [w.companyId, container]);
        const res = await w.agent.post(url(container)).send({ locationId: w.locationId });
        expect([res.status, res.body.code]).toEqual([409, "CONTAINER_OFFLOAD_IN_PROGRESS"]);
      } finally {
        await other.query("SELECT pg_advisory_unlock_all()");
        await other.end();
      }
    }));
});

describe("ledger refusals", () => {
  it("refuses foreign ledgers, wrong office accounts and expense additional charges", () =>
    withFactoryWorld(async (w) => {
      const container = await containerWithPo(w);
      const base = { locationId: w.locationId };
      const foreign = await ledger(w, "Asset", await company(w));
      await refuse(
        w,
        container,
        { ...base, duties: 5, dutiesAccountId: foreign },
        400,
        `Ledger account #${foreign} not found for the selected company`
      );
      const expense = await ledger(w, "Expense");
      await refuse(
        w,
        container,
        { ...base, officeCharges: 5, officeChargesAccountId: expense },
        400,
        /^Office charges account "Expense \d+" has an invalid account type/
      );
      const direct = await ledger(w, "Direct Expense");
      await refuse(
        w,
        container,
        {
          ...base,
          additionalCharges: [
            { amount: 0, ledgerAccountId: direct },
            { amount: 3, ledgerAccountId: direct },
          ],
        },
        400,
        /^Additional charges cannot credit the "Direct Expense \d+" expense account/
      );
    }));

  it("refuses an own-freight ledger that is not in the company", () =>
    withFactoryWorld(async (w) => {
      const foreign = await ledger(w, "Asset", await company(w));
      const container = await containerWithPo(w, { paidBy: "own", own: foreign });
      await refuse(
        w,
        container,
        { locationId: w.locationId },
        400,
        `Own-account freight ledger #${foreign} is unavailable`
      );
    }));

  it("refuses parent-agent ledgers that are not in the parent company", () =>
    withFactoryWorld(async (w) => {
      const parent = await company(w);
      await w.q(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [parent, w.companyId]);
      const notParents = await ledger(w, "Asset");
      const container = await containerWithPo(w);
      await refuse(
        w,
        container,
        { locationId: w.locationId, agentChargeLines: [{ amountUsd: 4, parentAgentAccountId: notParents }] },
        400,
        `Parent-agent ledger #${notParents} is unavailable`
      );
    }));
});

describe("pass-through", () => {
  it("lets valid ledgers and stale parent-freight metadata through to the offload handler", () =>
    withFactoryWorld(async (w) => {
      const parent = await company(w);
      await w.q(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [parent, w.companyId]);
      const agent = await ledger(w, "Liability", parent);
      const stale = await ledger(w, "Asset", await company(w));
      const office = await ledger(w, "Asset");
      const container = await containerWithPo(w, { paidBy: "parent", parent: stale });
      const res = await w.agent.patch(url(container)).send({
        locationId: w.locationId,
        officeCharges: 2,
        officeChargesAccountId: office,
        additionalCharges: [{ amount: 1, ledgerAccountId: office }],
        agentChargeLines: [{ amountUsd: 1, parentAgentAccountId: agent }],
      });
      const guardMessages =
        /not found for the selected company|invalid account type|cannot credit|is unavailable|Location is required/;
      expect(String(res.body?.message ?? "")).not.toMatch(guardMessages);
      expect(res.body?.code).not.toBe("CONTAINER_OFFLOAD_IN_PROGRESS");
    }));

  it("refuses the PATCH re-offload to non-admin roles", () =>
    withFactoryWorld(async (w) => {
      const clerk = await w.agentFor("Accountant");
      const res = await clerk.patch(url(await containerWithPo(w))).send({ locationId: w.locationId });
      expect(res.status).toBe(403);
    }));
});
