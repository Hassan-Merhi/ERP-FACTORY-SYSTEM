/**
 * Legacy PATCH /api/vouchers/:id/journal (server/routes/vouchers/voucherJournalRoutes.ts).
 *
 * The central journal editor handles active Journal vouchers; draft (optional)
 * journals, optional transitions and Payment/Receipt vouchers fall through to
 * this legacy handler. Every refusal leaves the voucher and its lines as they
 * were; a successful edit replaces the lines and audits the change.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks, ledger } from "./helpers/dispatchFlowFixture";

interface Draft {
  voucherId: number;
  cash: number;
  sales: number;
}

async function voucher(
  w: FactoryWorld,
  type: string,
  optional: boolean,
  extra: { number?: string; source?: string } = {}
) {
  const cash = await ledger(w, `CASH${type}`, "Asset");
  const sales = await ledger(w, `SALES${type}`, "Income");
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, source_module)
     VALUES ($1, $2, $3, '2026-06-01', 10, $4, $5) RETURNING id`,
    [w.companyId, extra.number ?? `${w.tag}-${type}`, type, optional, extra.source ?? null]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, 10, 0, 'old debit'), ($1, $3, 0, 10, 'old credit')`,
    [voucherId, cash, sales]
  );
  return { voucherId, cash, sales } satisfies Draft;
}

const lines = (d: Draft, debit: string, credit = debit) => [
  { type: "DR", accountType: "ledger", accountId: d.cash, amount: debit, narration: "new debit" },
  { type: "CR", accountType: "ledger", accountId: d.sales, amount: credit, narration: "new credit" },
];

const patch = (w: FactoryWorld, id: number, body: Record<string, unknown>) =>
  w.agent.patch(`/api/vouchers/${id}/journal`).send(body);

const entriesOf = (w: FactoryWorld, id: number) =>
  w.q<{ narration: string; debit: string; credit: string }>(
    `SELECT narration, debit_amount::numeric(18,2)::text AS debit, credit_amount::numeric(18,2)::text AS credit
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [id]
  );

const unchanged = [
  { narration: "old debit", debit: "10.00", credit: "0.00" },
  { narration: "old credit", debit: "0.00", credit: "10.00" },
];

describe("legacy journal PATCH refusals", () => {
  it("rejects a draft edit with no lines and leaves the voucher untouched", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Journal", true);
      const missing = await patch(w, d.voucherId, { voucherDate: "2026-06-02", entries: [], optional: true });
      expect(missing.status).toBe(400);
      expect(missing.body.message).toBe("Missing required fields");
      const noDate = await patch(w, d.voucherId, { entries: lines(d, "5"), optional: true });
      expect(noDate.status).toBe(400);
      expect(await entriesOf(w, d.voucherId)).toEqual(unchanged);
    });
  });

  it("refuses an unbalanced activation but allows an unbalanced draft", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Journal", true);
      const active = await patch(w, d.voucherId, {
        voucherDate: "2026-06-02",
        entries: lines(d, "5", "4"),
        optional: false,
      });
      expect(active.status).toBe(400);
      expect(active.body.message).toBe("Total debits must equal total credits");
      expect(await entriesOf(w, d.voucherId)).toEqual(unchanged);

      const draft = await patch(w, d.voucherId, {
        voucherDate: "2026-06-02",
        entries: lines(d, "5", "4"),
        optional: true,
      });
      expect(draft.status).toBe(200);
      expect(await entriesOf(w, d.voucherId)).toEqual([
        { narration: "new debit", debit: "5.00", credit: "0.00" },
        { narration: "new credit", debit: "0.00", credit: "4.00" },
      ]);
    });
  });

  it("refuses an intercompany transfer leg with 409", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Payment", false);
      await w.q(
        `INSERT INTO inter_company_transfers (from_company_id, to_company_id, from_ledger_account_id, to_ledger_account_id,
           from_voucher_id, amount, transfer_date, transfer_type)
         VALUES ($1, $1, $2, $3, $4, 10, '2026-06-01', 'CASH')`,
        [w.companyId, d.cash, d.sales, d.voucherId]
      );
      const res = await patch(w, d.voucherId, { voucherDate: "2026-06-01", entries: lines(d, "10") });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED");
      expect(await entriesOf(w, d.voucherId)).toEqual(unchanged);
    });
  });

  it("refuses converting an existing voucher to Kwacha", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Payment", false);
      const res = await patch(w, d.voucherId, {
        voucherDate: "2026-06-01",
        entries: lines(d, "10"),
        currency: "ZMW",
        exchangeRate: "25",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.message).toMatch(/ZMW requires reversal/);
      expect(await entriesOf(w, d.voucherId)).toEqual(unchanged);
    });
  });

  it("refuses a migrated read-only voucher inside the transaction", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Payment", false, { number: `MIG-${w.tag}` });
      const res = await patch(w, d.voucherId, { voucherDate: "2026-06-01", entries: lines(d, "10") });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.message).toMatch(/migrat/i);
      expect(await entriesOf(w, d.voucherId)).toEqual(unchanged);
    });
  });

  it("refuses an edit in a closed period with the correction refusal", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Payment", false);
      await closeBooks(w, "2026-06-30");
      const res = await patch(w, d.voucherId, { voucherDate: "2026-06-01", entries: lines(d, "10") });
      expect(res.status).toBe(409);
      expect(await entriesOf(w, d.voucherId)).toEqual(unchanged);
    });
  });

  it("returns 404 for a voucher of another company", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}X`]
      );
      const foreign = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, 'Payment', '2026-06-01', 10, false) RETURNING id`,
        [other, `${w.tag}-FOREIGN`]
      );
      const res = await patch(w, foreign, { voucherDate: "2026-06-01", entries: [{ type: "DR", amount: "1" }] });
      expect([403, 404]).toContain(res.status);
      const [row] = await w.q(`SELECT voucher_date::text AS d FROM vouchers WHERE id = $1`, [foreign]);
      expect(row.d).toBe("2026-06-01");
    });
  });
});

describe("legacy journal PATCH success", () => {
  it("replaces a Payment voucher's lines in CFA and audits the edit", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Payment", false);
      const res = await patch(w, d.voucherId, {
        voucherDate: "2026-06-03",
        entries: lines(d, "6500"),
        notes: "Edited payment",
        currency: "CFA",
        exchangeRate: "650",
      });
      expect(res.status).toBe(200);
      expect(res.body.whatsapp).toMatchObject({ prompt: false });
      const [header] = await w.q(
        `SELECT voucher_date::text AS d, description, total_amount::numeric(18,2)::text AS total FROM vouchers WHERE id = $1`,
        [d.voucherId]
      );
      expect(header).toEqual({ d: "2026-06-03", description: "Edited payment", total: "10.00" });
      const entries = await w.q(
        `SELECT transaction_currency AS c, transaction_debit_amount::numeric(18,2)::text AS td
           FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [d.voucherId]
      );
      expect(entries).toEqual([
        { c: "CFA", td: "6500.00" },
        { c: "CFA", td: "0.00" },
      ]);
      const audit = await w.q(
        `SELECT COUNT(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = 'vouchers'`,
        [w.companyId]
      );
      expect(audit[0].n).toBeGreaterThan(0);
    });
  });

  it("uses an explicit main account and accepts a customer line", async () => {
    await withFactoryWorld(async (w) => {
      const d = await voucher(w, "Receipt", false);
      const customer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Journal Customer') RETURNING id`,
        [w.companyId, `${w.tag}C`]
      );
      const res = await patch(w, d.voucherId, {
        voucherDate: "2026-06-04",
        mainAccountId: d.sales,
        mainAccountType: "ledger",
        entries: [
          { type: "DR", accountType: "ledger", accountId: d.cash, amount: "7" },
          { type: "CR", accountType: "customer", accountId: customer, amount: "7" },
        ],
      });
      expect(res.status).toBe(200);
      const [line] = await w.q(
        `SELECT customer_id FROM voucher_entries WHERE voucher_id = $1 AND customer_id IS NOT NULL`,
        [d.voucherId]
      );
      expect(Number(line.customer_id)).toBe(customer);
    });
  });
});
