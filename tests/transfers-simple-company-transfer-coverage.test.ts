/**
 * Simple company transfers over HTTP: refusals (bad input, no access to the
 * other company, unknown transfer) write nothing; a USD transfer creates both
 * vouchers and clearing accounts, a retry with the same clientRequestId
 * replays the same transfer, and delete (over HTTP or the service) posts
 * reversals in both companies (then replays). A
 * Kwacha transfer between a USD/ZMW subsidiary and its parent posts native
 * ZMW evidence and reverses it. The approved-rate policy is stubbed, as in
 * the other Zambia transfer suites. One rolled-back transaction per test.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/services/accounting/zambiaVoucherRatePolicy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/accounting/zambiaVoucherRatePolicy")>()),
  assertApprovedZmwVoucherRate: async (_companyId: number, _date: string, currency: string | null) =>
    String(currency ?? "").toUpperCase() === "ZMW" ? "26.5" : null,
}));

import { simpleCompanyTransferService } from "../server/routes/transfers/simpleCompanyTransferService";
import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/simple-company-transfer";

interface Pair {
  other: number;
  fromCash: number;
  toCash: number;
}

async function pair(w: FactoryWorld, opts: { zambia?: boolean; access?: boolean } = {}): Promise<Pair> {
  const other = await w.one(
    `INSERT INTO companies (code, name, company_type, base_currency, display_currency, parent_company_id)
     VALUES ($1::varchar, $1::text, 'factory', 'USD', $2, $3) RETURNING id`,
    [`${w.tag}Z`, opts.zambia ? "ZMW" : "USD", opts.zambia ? w.companyId : null]
  );
  if (opts.access !== false) {
    await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [w.userId, other]);
  }
  const cash = (companyId: number, code: string) =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Cash') RETURNING id`,
      [companyId, `${w.tag}${code}`]
    );
  return { other, fromCash: await cash(w.companyId, "F"), toCash: await cash(other, "T") };
}

function body(w: FactoryWorld, p: Pair, over: Record<string, unknown> = {}) {
  return {
    fromCompanyId: w.companyId,
    toCompanyId: p.other,
    fromLedgerAccountId: p.fromCash,
    toLedgerAccountId: p.toCash,
    amount: "150.00",
    transferDate: "2026-03-02",
    clientRequestId: `${w.tag}-req`,
    ...over,
  };
}

async function transferCount(w: FactoryWorld, p: Pair) {
  const [row] = await w.q(
    `SELECT COUNT(*)::int AS n FROM inter_company_transfers WHERE from_company_id = $1 AND to_company_id = $2`,
    [w.companyId, p.other]
  );
  return row.n;
}

describe("simple company transfer refusals", () => {
  it("refuses a non-positive amount and a malformed body without writing", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      expect((await w.agent.post(URL).send(body(w, p, { amount: "0" }))).status).toBe(400);
      expect((await w.agent.post(URL).send(body(w, p, { fromCompanyId: "x" }))).status).toBe(400);
      expect(await transferCount(w, p)).toBe(0);
    });
  });

  it("refuses a company the user cannot access", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w, { access: false });
      const res = await w.agent.post(URL).send(body(w, p));
      expect(res.status).toBe(403);
      expect(await transferCount(w, p)).toBe(0);
      const ledgers = await w.q(`SELECT id FROM ledger_accounts WHERE company_id = $1 AND code = 'TRANSFER-CLEARING'`, [
        p.other,
      ]);
      expect(ledgers).toHaveLength(0);
    });
  });

  it("refuses Kwacha without a linked USD/ZMW subsidiary", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      const res = await w.agent.post(URL).send(body(w, p, { currency: "ZMW", exchangeRate: "26.5" }));
      expect(res.status).toBe(409);
      expect(await transferCount(w, p)).toBe(0);
    });
  });

  it("returns 404 for an unknown transfer and 400 for a bad id", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.delete(`${URL}/999999999`)).status).toBe(404);
      expect((await w.agent.delete(`${URL}/abc`)).status).toBe(400);
    });
  });
});

describe("simple company transfer lifecycle", () => {
  it("creates a USD transfer, replays a retry with the same clientRequestId, and lists it", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      const created = await w.agent.post(URL).send(body(w, p, { description: "Float top-up" }));
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ fromCompanyId: w.companyId, toCompanyId: p.other });
      const retry = await w.agent.post(URL).send(body(w, p, { description: "Float top-up" }));
      // The USD voucher numbers derive from clientRequestId, so the retry
      // rebuilds the same posting payload and replays it.
      expect(retry.status).toBe(201);
      expect(retry.body).toMatchObject({
        id: created.body.id,
        fromVoucherId: created.body.fromVoucherId,
        toVoucherId: created.body.toVoucherId,
      });
      expect(await transferCount(w, p)).toBe(1);
      const numbers = await w.q(
        `SELECT voucher_number FROM vouchers WHERE company_id = ANY($1) AND voucher_number LIKE 'TR-%' ORDER BY id`,
        [[w.companyId, p.other]]
      );
      expect(numbers).toHaveLength(2);
      expect(numbers.map((v) => v.voucher_number)).toEqual([
        expect.stringMatching(/^TR-OUT-[0-9a-f]{24}$/),
        expect.stringMatching(/^TR-IN-[0-9a-f]{24}$/),
      ]);

      const vouchers = await w.q(`SELECT total_amount::numeric AS total FROM vouchers WHERE id = ANY($1)`, [
        [created.body.fromVoucherId, created.body.toVoucherId],
      ]);
      expect(vouchers.map((v) => Number(v.total))).toEqual([150, 150]);
      const clearing = await w.q(
        `SELECT company_id FROM ledger_accounts WHERE code = 'TRANSFER-CLEARING' AND company_id = ANY($1)`,
        [[w.companyId, p.other]]
      );
      expect(clearing).toHaveLength(2);
      expect((await w.agent.get("/api/simple-company-transfers")).status).toBe(200);
      expect((await w.agent.get(`/api/company-accounts/${w.companyId}`)).status).toBe(200);
    });
  });

  it("deletes over HTTP, reversing both companies' vouchers", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      const created = await w.agent.post(URL).send(body(w, p));
      expect(created.status).toBe(201);
      // DELETE carries no company ids in its body; the service authorizes both
      // membership-checked companies for the reversal postings itself.
      const res = await w.agent.delete(`${URL}/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, replayed: false });
      expect(await transferCount(w, p)).toBe(0);
      const reversals = await w.q(`SELECT company_id, voucher_number FROM vouchers WHERE id = ANY($1) ORDER BY id`, [
        res.body.reversalVoucherIds,
      ]);
      expect(reversals.map((v) => v.company_id)).toEqual([w.companyId, p.other]);
      expect(reversals.every((v) => String(v.voucher_number).startsWith("REV-TR-"))).toBe(true);
      const again = await w.agent.delete(`${URL}/${created.body.id}`);
      expect(again.body).toEqual({ success: true, replayed: true });
    });
  });

  it("refuses an HTTP delete by a user without access to the other company", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      const created = await w.agent.post(URL).send(body(w, p));
      await w.q(`DELETE FROM user_company_roles WHERE user_id = $1 AND company_id = $2`, [w.userId, p.other]);
      const res = await w.agent.delete(`${URL}/${created.body.id}`);
      expect(res.status).toBe(403);
      expect(await transferCount(w, p)).toBe(1);
      const reversals = await w.q(
        `SELECT id FROM vouchers WHERE voucher_number LIKE 'REV-TR-%' AND company_id = ANY($1)`,
        [[w.companyId, p.other]]
      );
      expect(reversals).toHaveLength(0);
    });
  });

  it("reverses a USD transfer through the service and replays the delete", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      const created = await w.agent.post(URL).send(body(w, p));
      const removed = await simpleCompanyTransferService.delete(w.userId, created.body.id);
      expect(removed).toMatchObject({ success: true, replayed: false });
      expect(await transferCount(w, p)).toBe(0);
      const reversals = await w.q(`SELECT voucher_number, description FROM vouchers WHERE id = ANY($1)`, [
        (removed as { reversalVoucherIds: number[] }).reversalVoucherIds,
      ]);
      expect(reversals.every((v) => String(v.voucher_number).startsWith("REV-TR-"))).toBe(true);
      expect(await simpleCompanyTransferService.delete(w.userId, created.body.id)).toEqual({
        success: true,
        replayed: true,
      });
      const again = await w.agent.delete(`${URL}/${created.body.id}`);
      expect(again.body).toEqual({ success: true, replayed: true });
    });
  });

  it("refuses to reverse a transfer whose vouchers cannot be loaded", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      const created = await w.agent.post(URL).send(body(w, p));
      // A NULL voucher id is missing, not voucher 0.
      await w.q(`UPDATE inter_company_transfers SET to_voucher_id = NULL WHERE id = $1`, [created.body.id]);
      await expect(simpleCompanyTransferService.delete(w.userId, created.body.id)).rejects.toMatchObject({
        statusCode: 409,
        message: "Transfer is missing one or both accounting vouchers",
      });
      // A voucher of the other company is not loadable for this side either.
      await w.q(`UPDATE inter_company_transfers SET to_voucher_id = $2 WHERE id = $1`, [
        created.body.id,
        created.body.fromVoucherId,
      ]);
      await expect(simpleCompanyTransferService.delete(w.userId, created.body.id)).rejects.toMatchObject({
        statusCode: 409,
        message: "Transfer accounting vouchers could not be loaded for reversal",
      });
      expect(await transferCount(w, p)).toBe(1);
    });
  });

  it("refuses a delete by a user without access to both companies", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w);
      const created = await w.agent.post(URL).send(body(w, p));
      await w.q(`DELETE FROM user_company_roles WHERE user_id = $1 AND company_id = $2`, [w.userId, p.other]);
      await expect(simpleCompanyTransferService.delete(w.userId, created.body.id)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(await transferCount(w, p)).toBe(1);
    });
  });

  it("posts a Kwacha transfer once per clientRequestId and reverses its native ZMW evidence", async () => {
    await withFactoryWorld(async (w) => {
      const p = await pair(w, { zambia: true });
      const zmw = body(w, p, { amount: "2650", currency: "ZMW", exchangeRate: "26.5" });
      const res = await w.agent.post(URL).send(zmw);
      expect(res.status).toBe(201);
      const retry = await w.agent.post(URL).send(zmw);
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(res.body.id);
      const [inVoucher] = await w.q(`SELECT voucher_number FROM vouchers WHERE id = $1`, [res.body.toVoucherId]);
      expect(inVoucher.voucher_number).toMatch(/^TR-IN-ZMW-/);
      const removed = (await simpleCompanyTransferService.delete(w.userId, res.body.id)) as {
        reversalVoucherIds: number[];
      };
      const lines = await w.q(
        `SELECT transaction_currency, transaction_debit_amount::numeric AS dr FROM voucher_entries WHERE voucher_id = $1`,
        [removed.reversalVoucherIds[1]]
      );
      expect(lines.some((line) => line.transaction_currency === "ZMW" && Number(line.dr) === 2650)).toBe(true);
    });
  });
});
