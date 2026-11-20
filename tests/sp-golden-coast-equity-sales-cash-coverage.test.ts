/**
 * Golden Coast "settle GC Sales Cash from Hassan Dakik Equity" routes
 * (readiness and settlement) through the real app, one rolled-back
 * transaction per test: non supplier-partner and unconfigured companies,
 * missing / mistyped canonical accounts, input refusals, the payable and
 * equity ceilings, a posted settlement with marker replay, a reused request id
 * with another payload, tampered or deleted replay vouchers, a closed period
 * and the SP owner-withdrawal permission. Refusals post nothing.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks } from "./helpers/dispatchFlowFixture";
import { nextSeq } from "./helpers/voucherReadFixture";

const BASE = "/api/sp/golden-coast/equity-sales-cash-settlement";
const readiness = (w: FactoryWorld) => w.agent.get(`${BASE}/readiness`);

async function account(w: FactoryWorld, subType: string, type: string, opening = "0") {
  const n = nextSeq();
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, $6, 'Cr') RETURNING id`,
    [w.companyId, `${w.tag}-${n}`, `${subType} ${n}`, type, subType, opening]
  );
}

interface Accounts {
  freshStart: number;
  hassan: number;
}

/** A supplier_partner company; `golden` adds the two Golden Coast capital accounts. */
async function spWorld(work: (w: FactoryWorld, a: Accounts) => Promise<void>, golden = true, hassanOpening = "1000") {
  await withFactoryWorld(async (w) => {
    await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
    const accounts = { freshStart: 0, hassan: 0 };
    if (golden) {
      accounts.freshStart = await account(w, "gc_partner_capital", "Equity");
      accounts.hassan = await account(w, "gc_owner_capital", "Equity", hassanOpening);
    }
    await work(w, accounts);
  });
}

let requestSeq = 0;
function settle(w: FactoryWorld, extra: Record<string, unknown> = {}) {
  return w.agent.post(BASE).send({
    confirmation: "SETTLE SALES CASH FROM EQUITY",
    reason: "Hassan settles sales cash",
    settlementDate: "2026-10-15",
    amountUsd: "100",
    clientRequestId: `eq-${process.pid}-${Date.now().toString(36)}-${++requestSeq}`,
    ...extra,
  });
}

const vouchers = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n;
const dropRequestGuards = (w: FactoryWorld) =>
  w.q(`DELETE FROM voucher_path_request_guards WHERE company_id = $1`, [w.companyId]);

describe("equity sales-cash readiness", () => {
  it("refuses non supplier-partner companies and unconfigured Golden Coast setup", async () => {
    await withFactoryWorld(async (w) => {
      expect((await readiness(w)).status).toBe(403);
      expect((await settle(w)).status).toBe(403);
    });
    await spWorld(async (w) => {
      const res = await readiness(w);
      expect([res.status, res.body.code]).toEqual([409, "GC_EQUITY_SALES_CASH_NOT_CONFIGURED"]);
      const post = await settle(w);
      expect([post.status, post.body.code]).toEqual([409, "GC_EQUITY_SALES_CASH_NOT_CONFIGURED"]);
    }, false);
  });

  it("refuses a missing or mistyped GC Sales Cash account", async () => {
    await spWorld(async (w) => {
      const missing = await readiness(w);
      expect([missing.status, missing.body.code]).toEqual([409, "GC_EQUITY_SALES_CASH_ACCOUNT_INVALID"]);
      expect(missing.body.message).toMatch(/not configured/);
      const wrong = await account(w, "sp_payable", "Expense");
      expect((await readiness(w)).body.message).toMatch(/must use account type/);
      expect((await settle(w)).body.code).toBe("GC_EQUITY_SALES_CASH_ACCOUNT_INVALID");
      await w.q(`UPDATE ledger_accounts SET account_type = 'Liability' WHERE id = $1`, [wrong]);
      await account(w, "sp_payable", "Liability");
      expect((await readiness(w)).body.message).toMatch(/ambiguous/);
      expect(await vouchers(w)).toBe(0);
    });
  });

  it("reports both balances and the settleable maximum", async () => {
    await spWorld(async (w, a) => {
      const payable = await account(w, "sp_payable", "Liability", "300");
      const res = await readiness(w);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ready: true,
        gcSalesCashAccount: { id: payable },
        hassanEquityAccount: { id: a.hassan },
        freshStartEquityAccount: { id: a.freshStart },
        payableSalesCashUsd: "300.00",
        availableHassanEquityUsd: "1000.00",
        freshStartEquityUsd: "0.00",
        maxSettlementUsd: "300.00",
      });
      await w.q(`UPDATE ledger_accounts SET opening_balance_side = 'Dr' WHERE id = $1`, [a.hassan]);
      expect((await readiness(w)).body).toMatchObject({ ready: false, maxSettlementUsd: "0.00" });
    });
  });
});

describe("equity sales-cash settlement refusals", () => {
  it("refuses invalid input and amounts above either ceiling without posting", async () => {
    await spWorld(
      async (w) => {
        await account(w, "sp_payable", "Liability", "300");
        const bad = await settle(w, { confirmation: "yes" });
        expect([bad.status, bad.body.code]).toEqual([400, "GC_EQUITY_SALES_CASH_INPUT_INVALID"]);
        const early = await settle(w, { settlementDate: "2026-08-01" });
        expect([early.status, early.body.code]).toEqual([400, "GC_EQUITY_SALES_CASH_PRE_CUTOVER_DATE"]);
        const overPayable = await settle(w, { amountUsd: "300.01" });
        expect([overPayable.status, overPayable.body.code]).toEqual([409, "GC_EQUITY_SALES_CASH_EXCEEDS_PAYABLE"]);
        const overEquity = await settle(w, { amountUsd: "250.01" });
        expect([overEquity.status, overEquity.body.code]).toEqual([409, "GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY"]);
        expect(await vouchers(w)).toBe(0);
      },
      true,
      "250"
    );
  });

  it("refuses a role without the owner-withdrawal permission and posts nothing in a closed period", async () => {
    await spWorld(async (w) => {
      await account(w, "sp_payable", "Liability", "300");
      const manager = await w.agentFor("Manager");
      const denied = await manager.post(BASE).send({});
      expect([denied.status, denied.body.code]).toEqual([403, "SP_PERMISSION_DENIED"]);
      await closeBooks(w, "2026-12-31");
      const closed = await settle(w);
      // Mapped like the Phase 9 route: 409 ACCOUNTING_PERIOD_CLOSED, not a 500.
      expect([closed.status, closed.body.code]).toEqual([409, "ACCOUNTING_PERIOD_CLOSED"]);
      expect(closed.body.message).toMatch(/closed through 2026-12-31, so an entry dated 2026-10-15/);
      expect(await vouchers(w)).toBe(1);
    });
  });
});

describe("equity sales-cash settlement posting and replay", () => {
  it("posts the three-line voucher once and replays from the posting marker", async () => {
    await spWorld(async (w, a) => {
      const payable = await account(w, "sp_payable", "Liability", "300");
      const body = { clientRequestId: `${w.tag}-same`, reference: "REF-1" };
      const first = await settle(w, body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        ok: true,
        replayed: false,
        amountUsd: "100.00",
        gcSalesCashPayableAfterUsd: "200.00",
        hassanEquityAfterUsd: "900.00",
        freshStartEquityCreditUsd: "200.00",
        gcSalesCashAccountId: payable,
        hassanEquityAccountId: a.hassan,
        freshStartEquityAccountId: a.freshStart,
      });
      expect(first.body.entries).toHaveLength(3);
      await dropRequestGuards(w);
      const again = await settle(w, body);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        replayed: true,
        voucher: { id: first.body.voucher.id },
        gcSalesCashPayableAfterUsd: "200.00",
        hassanEquityAfterUsd: "900.00",
      });
      await dropRequestGuards(w);
      const conflict = await settle(w, { ...body, amountUsd: "5" });
      expect([conflict.status, conflict.body.code]).toEqual([409, "GC_EQUITY_SALES_CASH_IDEMPOTENCY_CONFLICT"]);
      expect(await vouchers(w)).toBe(1);
    });
  });

  it("refuses to replay a marker whose voucher routing, total or existence changed", async () => {
    await spWorld(async (w, a) => {
      await account(w, "sp_payable", "Liability", "300");
      const body = { clientRequestId: `${w.tag}-tamper` };
      const first = await settle(w, body);
      expect(first.status).toBe(201);
      const voucherId = first.body.voucher.id;
      await w.q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
      await w.q(`UPDATE voucher_entries SET ledger_account_id = $2 WHERE voucher_id = $1 AND ledger_account_id = $3`, [
        voucherId,
        a.freshStart,
        a.hassan,
      ]);
      await dropRequestGuards(w);
      const routing = await settle(w, body);
      expect([routing.status, routing.body.code]).toEqual([409, "GC_EQUITY_SALES_CASH_IDEMPOTENCY_INCONSISTENT"]);
      expect(routing.body.message).toMatch(/requested routing/);
      await w.q(`UPDATE vouchers SET total_amount = 1 WHERE id = $1`, [voucherId]);
      await dropRequestGuards(w);
      expect((await settle(w, body)).body.message).toMatch(/no longer matches/);
      await w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [voucherId]);
      await dropRequestGuards(w);
      expect((await settle(w, body)).body.message).toMatch(/missing or deleted voucher/);
    });
  });
});
