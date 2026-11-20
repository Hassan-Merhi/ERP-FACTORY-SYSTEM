/**
 * server/routes/sp/spGoldenCoastPhase4CutoverFifoRoutes.ts over HTTP against
 * PostgreSQL, one rolled-back supplier-partner company per test.
 *
 * Pinned: status and cutover refuse a non supplier-partner company, a
 * non-Admin role and a company without Golden Coast capital roles; a missing
 * or duplicated Stock in Hand account blocks the status; without a Phase 3
 * (or carry-forward) opening voucher the plan is withheld; an inventory value
 * that does not reconcile is reported as a blocker; a reconciled snapshot is
 * posted once and then reported as already posted (replayed, nothing
 * inserted). The legacy-mutation guard answers 410 for Golden Coast companies
 * and lets other supplier-partner companies through.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq } from "./helpers/voucherReadFixture";

const STATUS = "/api/sp/golden-coast/phase4/cutover-fifo/status";
const CUTOVER = "/api/sp/golden-coast/phase4/cutover-fifo";

async function supplierPartner(w: FactoryWorld, opts: { goldenCoast?: boolean; stockAccounts?: number } = {}) {
  await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
  const ledger = (code: string, type: string, subType: string) =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type)
       VALUES ($1, $2::varchar, $2::text, $3, $4) RETURNING id`,
      [w.companyId, `${w.tag}${code}`, type, subType]
    );
  if (opts.goldenCoast !== false) {
    await ledger("PC", "Equity", "gc_partner_capital");
    await ledger("OC", "Equity", "gc_owner_capital");
  }
  const stock: number[] = [];
  for (let i = 0; i < (opts.stockAccounts ?? 1); i += 1) stock.push(await ledger(`SIH${i}`, "Asset", "sp_stock"));
  const equity = await ledger("EQ", "Equity", "gc_misc");
  return { stock: stock[0], equity };
}

async function openingVoucher(w: FactoryWorld, number: string, stock: number, equity: number, amount: string) {
  const v = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2026-09-01', $3) RETURNING id`,
    [w.companyId, number, amount]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
     VALUES ($1, $2, $4, 0), ($1, $3, 0, $4)`,
    [v, stock, equity, amount]
  );
}

async function stockOnHand(w: FactoryWorld, qty: string, rate: string, description: string | null = "Bale") {
  const item = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, $3, 'PCS') RETURNING id`,
    [w.companyId, `${w.tag}I${nextSeq()}`, description ?? ""]
  );
  await w.q(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate) VALUES ($1, $2, $3, $4, $5)`,
    [w.companyId, w.locationId, item, qty, rate]
  );
  return item;
}

const cutover = (w: FactoryWorld) =>
  w.agent
    .post(CUTOVER)
    .set("Idempotency-Key", `${w.tag}-${nextSeq()}`)
    .send({ confirmation: "RUN SP MIGRATION", reason: "Golden Coast cutover rehearsal" });

const movements = (w: FactoryWorld) =>
  w.q(`SELECT qty_in::text AS qty, final_unit_cost_usd::text AS cost FROM sp_stock_movements WHERE company_id = $1`, [
    w.companyId,
  ]);

describe("cutover FIFO status refusals", () => {
  it("refuses a company that is not a supplier partner, and a non-Admin user", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get(STATUS)).status).toBe(403);
      await supplierPartner(w);
      const manager = await w.agentFor("Manager");
      expect((await manager.get(STATUS)).status).toBe(403);
    }));

  it("refuses a supplier partner without Golden Coast capital roles", () =>
    withFactoryWorld(async (w) => {
      await supplierPartner(w, { goldenCoast: false });
      const res = await w.agent.get(STATUS);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("GC_PHASE4_NOT_CONFIGURED");
      const post = await cutover(w);
      expect(post.status).toBe(409);
      expect(post.body.code).toBe("GC_PHASE4_CUTOVER_BLOCKED");
      expect(await movements(w)).toEqual([]);
    }));

  it("blocks on a missing or duplicated Stock in Hand account", () =>
    withFactoryWorld(async (w) => {
      await supplierPartner(w, { stockAccounts: 0 });
      const none = await w.agent.get(STATUS);
      expect(none.status).toBe(409);
      expect(none.body.message).toMatch(/not configured/);
      await w.q(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type)
         VALUES ($1, $2::varchar, $2::text, 'Asset', 'sp_stock'), ($1, $3::varchar, $3::text, 'Asset', 'sp_stock')`,
        [w.companyId, `${w.tag}S1`, `${w.tag}S2`]
      );
      const two = await w.agent.get(STATUS);
      expect(two.status).toBe(409);
      expect(two.body.message).toMatch(/ambiguous/);
    }));
});

describe("cutover FIFO planning and posting", () => {
  it("withholds the plan until an opening voucher exists", () =>
    withFactoryWorld(async (w) => {
      await supplierPartner(w);
      await stockOnHand(w, "10", "5");
      const res = await w.agent.get(STATUS);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ openingPosted: false, plan: null, canPost: false, posted: false });
      expect(res.body.blockers.join(" ")).toMatch(/Phase 3 cutover voucher has not been posted/);
      const post = await cutover(w);
      expect(post.status).toBe(409);
      expect(await movements(w)).toEqual([]);
    }));

  it("reports an inventory value that does not reconcile to the carry-forward opening", () =>
    withFactoryWorld(async (w) => {
      const { stock, equity } = await supplierPartner(w);
      await openingVoucher(w, `GC-EXISTING-POSITION-20260901-C${w.companyId}`, stock, equity, "80");
      await stockOnHand(w, "10", "5");
      const res = await w.agent.get(STATUS);
      expect(res.body).toMatchObject({
        phase3Posted: false,
        carryForwardPosted: true,
        openingPosted: true,
        plan: null,
      });
      expect(res.body.blockers.join(" ")).toMatch(/does not reconcile/);
    }));

  it("posts a reconciled snapshot once and then reports it as already posted", () =>
    withFactoryWorld(async (w) => {
      const { stock, equity } = await supplierPartner(w);
      await openingVoucher(w, `GC-CUTOVER-20260901-C${w.companyId}`, stock, equity, "62.50");
      await stockOnHand(w, "10", "5");
      await stockOnHand(w, "5", "2.5", null);
      await stockOnHand(w, "0", "0");
      const status = await w.agent.get(STATUS);
      expect(status.body).toMatchObject({ phase3Posted: true, canPost: true, blockers: [] });
      expect(status.body.plan).toMatchObject({ rowCount: 2, totalValueUsd: "62.50" });

      const first = await cutover(w);
      expect(first.status, first.text).toBe(200);
      expect(first.body).toMatchObject({ replayed: false, posted: true });
      expect(first.body.inserted).toHaveLength(2);
      expect((await movements(w)).map((m) => Number(m.qty)).sort()).toEqual([10, 5].sort());

      const again = await cutover(w);
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(again.body.blockers.join(" ")).toMatch(/already exists/);
      expect(await movements(w)).toHaveLength(2);
    }));
});

describe("retired legacy Golden Coast mutations", () => {
  it("answers 410 for a Golden Coast company and passes other supplier partners through", () =>
    withFactoryWorld(async (w) => {
      await supplierPartner(w, { goldenCoast: false });
      const plain = await w.agent.post("/api/sp/sales").send({});
      expect(plain.status).not.toBe(410);
      await w.q(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type)
         VALUES ($1, $2::varchar, $2::text, 'Equity', 'gc_partner_capital'),
                ($1, $3::varchar, $3::text, 'Equity', 'gc_owner_capital')`,
        [w.companyId, `${w.tag}P2`, `${w.tag}O2`]
      );
      const retired = await w.agent.post("/api/sp/sales").send({});
      expect(retired.status).toBe(410);
      expect(retired.body.code).toBe("GC_LEGACY_POSTING_RETIRED");
      const patch = await w.agent.patch("/api/sp/containers/123").send({});
      expect(patch.status).toBe(410);
      // A read is never intercepted.
      expect((await w.agent.get("/api/sp/containers")).status).not.toBe(410);
    }));
});
