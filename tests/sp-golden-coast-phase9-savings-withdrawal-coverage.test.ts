/**
 * Golden Coast Phase 9 Hassan Savings withdrawal routes (readiness and
 * withdrawal) through the real app against PostgreSQL, one rolled-back
 * transaction per test: non supplier-partner and unconfigured companies,
 * missing / ambiguous / mistyped savings accounts, input and payment-account
 * refusals, the savings cap and negative balance, a posted withdrawal with
 * idempotent replay, a reused request id with another payload, replay markers
 * whose voucher was deleted or changed, a closed period, and the SP role
 * permission. Refusals post nothing.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks } from "./helpers/dispatchFlowFixture";
import { ledger, nextSeq } from "./helpers/voucherReadFixture";

const BASE = "/api/sp/golden-coast/phase9/hassan-savings-withdrawal";
const readiness = (w: FactoryWorld) => w.agent.get(`${BASE}/readiness`);

async function account(w: FactoryWorld, subType: string, type: string, opening = "0") {
  const n = nextSeq();
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, $6, 'Cr') RETURNING id`,
    [w.companyId, `${w.tag}-${n}`, `${subType} ${n}`, type, subType, opening]
  );
}

/** A supplier_partner company; `golden` adds the two Golden Coast capital accounts. */
async function spWorld(work: (w: FactoryWorld) => Promise<void>, golden = true) {
  await withFactoryWorld(async (w) => {
    await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
    if (golden) {
      await account(w, "gc_partner_capital", "Equity");
      await account(w, "gc_owner_capital", "Equity");
    }
    await work(w);
  });
}

let requestSeq = 0;
function withdraw(w: FactoryWorld, paymentAccount: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return w.agent.post(BASE).send({
    confirmation: "WITHDRAW HASSAN SAVINGS",
    reason: "Hassan needs cash",
    withdrawalDate: "2026-10-15",
    amountUsd: "100",
    clientRequestId: `p9-${process.pid}-${Date.now().toString(36)}-${++requestSeq}`,
    paymentAccount,
    ...extra,
  });
}

const vouchers = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n;

describe("Phase 9 readiness", () => {
  it("refuses non supplier-partner companies and unconfigured Golden Coast setup", async () => {
    await withFactoryWorld(async (w) => {
      expect((await readiness(w)).status).toBe(403);
    });
    await spWorld(async (w) => {
      const res = await readiness(w);
      expect([res.status, res.body.code]).toEqual([409, "GC_PHASE9_NOT_CONFIGURED"]);
      const post = await withdraw(w, { kind: "ledger", id: 1 });
      expect([post.status, post.body.code]).toEqual([409, "GC_PHASE9_NOT_CONFIGURED"]);
    }, false);
  });

  it("refuses a missing, duplicated or mistyped Hassan Savings account", async () => {
    await spWorld(async (w) => {
      const missing = await readiness(w);
      expect([missing.status, missing.body.code]).toEqual([409, "GC_PHASE9_ACCOUNT_INVALID"]);
      expect(missing.body.message).toMatch(/not configured/);
      await account(w, "gc_hassan_savings", "Equity");
      expect((await readiness(w)).body.message).toMatch(/must use account type Loans/);
      await account(w, "gc_hassan_savings", "Loans");
      expect((await readiness(w)).body.message).toMatch(/ambiguous/);
    });
  });

  it("reports the savings balance and the cash and bank payment accounts", async () => {
    await spWorld(async (w) => {
      const savings = await account(w, "gc_hassan_savings", "Loans", "250");
      const notReady = await readiness(w);
      expect(notReady.body).toMatchObject({ ready: false, availableSavingsUsd: "250.00", paymentAccounts: [] });
      const cash = await ledger(w, "Till", "Cash");
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Main', 'BK', '1') RETURNING id`,
        [w.companyId, `${w.tag}-BK`]
      );
      const res = await readiness(w);
      expect(res.body).toMatchObject({ ready: true, hassanSavingsAccount: { id: savings, accountType: "Loans" } });
      expect(res.body.paymentAccounts).toEqual([
        expect.objectContaining({ kind: "ledger", id: cash }),
        expect.objectContaining({ kind: "bank", id: bank, type: "Bank Account" }),
      ]);
      await w.q(`UPDATE ledger_accounts SET opening_balance_side = 'Dr' WHERE id = $1`, [savings]);
      expect((await readiness(w)).body).toMatchObject({ ready: false, availableSavingsUsd: "-250.00" });
    });
  });
});

describe("Phase 9 withdrawal refusals", () => {
  it("refuses invalid input, foreign or non-cash payment accounts and amounts above the savings", async () => {
    await spWorld(async (w) => {
      const savings = await account(w, "gc_hassan_savings", "Loans", "150");
      const cash = await ledger(w, "Till", "Cash");
      const badInput = await withdraw(w, { kind: "ledger", id: cash }, { confirmation: "yes" });
      expect([badInput.status, badInput.body.code]).toEqual([400, "GC_PHASE9_INPUT_INVALID"]);
      const expense = await ledger(w, "Rent", "Expense");
      const notCash = await withdraw(w, { kind: "ledger", id: expense });
      expect([notCash.status, notCash.body.code]).toEqual([400, "GC_PHASE9_PAYMENT_ACCOUNT_INVALID"]);
      expect((await withdraw(w, { kind: "ledger", id: savings })).body.code).toBe("GC_PHASE9_PAYMENT_ACCOUNT_INVALID");
      expect((await withdraw(w, { kind: "bank", id: 2147483000 })).body.code).toBe("GC_PHASE9_PAYMENT_ACCOUNT_INVALID");
      const tooMuch = await withdraw(w, { kind: "ledger", id: cash }, { amountUsd: "150.01" });
      expect([tooMuch.status, tooMuch.body.code]).toEqual([409, "GC_PHASE9_WITHDRAWAL_EXCEEDS_SAVINGS"]);
      expect(await vouchers(w)).toBe(0);
    });
  });

  it("refuses a negative savings balance, a closed period and a role without the withdrawal permission", async () => {
    await spWorld(async (w) => {
      const savings = await account(w, "gc_hassan_savings", "Loans", "0");
      await w.q(`UPDATE ledger_accounts SET opening_balance = 10, opening_balance_side = 'Dr' WHERE id = $1`, [
        savings,
      ]);
      const cash = await ledger(w, "Till", "Cash");
      const negative = await withdraw(w, { kind: "ledger", id: cash });
      expect([negative.status, negative.body.code]).toEqual([409, "GC_PHASE9_BALANCE_INVALID"]);
      await w.q(`UPDATE ledger_accounts SET opening_balance = 500, opening_balance_side = 'Cr' WHERE id = $1`, [
        savings,
      ]);
      const manager = await w.agentFor("Manager");
      const denied = await manager.post(BASE).send({});
      expect([denied.status, denied.body.code]).toEqual([403, "SP_PERMISSION_DENIED"]);
      await closeBooks(w, "2026-12-31");
      const closed = await withdraw(w, { kind: "ledger", id: cash });
      expect([closed.status, closed.body.code]).toEqual([409, "ACCOUNTING_PERIOD_CLOSED"]);
      expect(closed.body.message).toMatch(/closed through 2026-12-31, so an entry dated 2026-10-15/);
      // Only the closing voucher of closeBooks exists.
      expect(await vouchers(w)).toBe(1);
    });
  });
});

/**
 * The accounting request boundary (voucher_path_request_guards) answers a
 * repeated clientRequestId before the handler: it replays the stored first
 * response verbatim or refuses a changed payload. Removing that guard row
 * (as retention would) lets the handler's own marker checks answer.
 */
const dropRequestGuards = (w: FactoryWorld) =>
  w.q(`DELETE FROM voucher_path_request_guards WHERE company_id = $1`, [w.companyId]);

describe("Phase 9 withdrawal posting and replay", () => {
  it("posts once; the request boundary replays the stored response and refuses a changed payload", async () => {
    await spWorld(async (w) => {
      const savings = await account(w, "gc_hassan_savings", "Loans", "300");
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number)
         VALUES ($1, $2, 'Main', 'BK', '1') RETURNING id`,
        [w.companyId, `${w.tag}-BK`]
      );
      const body = { clientRequestId: `${w.tag}-same`, reference: "REF-1" };
      const first = await withdraw(w, { kind: "bank", id: bank }, body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        ok: true,
        replayed: false,
        amountUsd: "100.00",
        availableSavingsAfterUsd: "200.00",
        hassanSavingsAccountId: savings,
      });
      expect(first.body.entries).toHaveLength(2);
      // The boundary replays the stored first response, marked as a replay.
      const again = await withdraw(w, { kind: "bank", id: bank }, body);
      expect([again.status, again.body.replayed, again.body.voucher.id]).toEqual([201, true, first.body.voucher.id]);
      expect(again.body.availableSavingsAfterUsd).toBe("200.00");
      const changed = await withdraw(w, { kind: "bank", id: bank }, { ...body, amountUsd: "5" });
      expect([changed.status, changed.body.code]).toEqual([409, "POSTING_IDEMPOTENCY_CONFLICT"]);
      expect(await vouchers(w)).toBe(1);
    });
  });

  it("without the boundary row, replays from the posting marker and refuses another payload", async () => {
    await spWorld(async (w) => {
      await account(w, "gc_hassan_savings", "Loans", "300");
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number)
         VALUES ($1, $2, 'Main', 'BK', '1') RETURNING id`,
        [w.companyId, `${w.tag}-BK`]
      );
      const payment = { kind: "bank", id: bank };
      const body = { clientRequestId: `${w.tag}-marker` };
      const first = await withdraw(w, payment, body);
      expect(first.status).toBe(201);
      await dropRequestGuards(w);
      const again = await withdraw(w, payment, body);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ replayed: true, voucher: { id: first.body.voucher.id } });
      expect(again.body.availableSavingsAfterUsd).toBe("200.00");
      await dropRequestGuards(w);
      const conflict = await withdraw(w, payment, { ...body, amountUsd: "5" });
      expect([conflict.status, conflict.body.code]).toEqual([409, "GC_PHASE9_IDEMPOTENCY_CONFLICT"]);
      expect(await vouchers(w)).toBe(1);
    });
  });

  it("refuses to replay a marker whose voucher entries or voucher no longer match", async () => {
    await spWorld(async (w) => {
      await account(w, "gc_hassan_savings", "Loans", "300");
      const cash = await ledger(w, "Till", "Cash");
      const body = { clientRequestId: `${w.tag}-tamper` };
      const first = await withdraw(w, { kind: "ledger", id: cash }, body);
      expect(first.status).toBe(201);
      const voucherId = first.body.voucher.id;
      await w.q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
      await w.q(`UPDATE voucher_entries SET credit_amount = 99 WHERE voucher_id = $1 AND credit_amount > 0`, [
        voucherId,
      ]);
      await dropRequestGuards(w);
      const entries = await withdraw(w, { kind: "ledger", id: cash }, body);
      expect([entries.status, entries.body.code]).toEqual([409, "GC_PHASE9_IDEMPOTENCY_INCONSISTENT"]);
      await w.q(`UPDATE vouchers SET total_amount = 1 WHERE id = $1`, [voucherId]);
      await dropRequestGuards(w);
      expect((await withdraw(w, { kind: "ledger", id: cash }, body)).body.message).toMatch(/no longer matches/);
      await w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [voucherId]);
      await dropRequestGuards(w);
      expect((await withdraw(w, { kind: "ledger", id: cash }, body)).body.message).toMatch(
        /missing or deleted voucher/
      );
    });
  });
});
