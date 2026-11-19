/**
 * PATCH /api/credit-notes/:id against PostgreSQL in one rolled-back
 * transaction per test: id and type validation, line validation, the locked
 * Kwacha (ZMW) refund rules, the closed-period refusal, and edits of credit
 * and debit notes that rebuild the lines, move stock and post the refund /
 * inventory-cost variance. Refusals leave the note unchanged.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks } from "./helpers/dispatchFlowFixture";
import { item, ledger, voucher } from "./helpers/voucherReadFixture";

async function seed(w: FactoryWorld) {
  const cash = await ledger(w, "Till", "Cash");
  const shirt = await item(w, "Shirt");
  await w.q(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value, average_rate)
     VALUES ($1, $2, $3, 100, 1000, 10)`,
    [w.companyId, w.locationId, shirt]
  );
  const line = (quantity: string, refundRate = "20", inventoryCost = "10") => ({
    stockItemId: shirt,
    locationId: w.locationId,
    quantity,
    refundRate,
    inventoryCost,
  });
  return { cash, shirt, line };
}

async function note(w: FactoryWorld, noteType: "Credit Note" | "Debit Note") {
  const s = await seed(w);
  const res = await w.agent.post("/api/credit-notes").send({
    noteType,
    voucherDate: "2026-06-10",
    cashAccountType: "ledger",
    cashAccountId: s.cash,
    description: "fixture",
    items: [s.line("2")],
  });
  expect(res.status).toBe(200);
  const id = Number(res.body.voucherId ?? res.body.id ?? res.body.voucher?.id);
  expect(id).toBeGreaterThan(0);
  return { ...s, id };
}

const edit = (w: FactoryWorld, id: number | string, body: Record<string, unknown>) =>
  w.agent.patch(`/api/credit-notes/${id}`).send(body);

const stock = async (w: FactoryWorld, shirt: number) =>
  (
    await w.q(`SELECT quantity::text AS q FROM inventory WHERE location_id = $1 AND stock_item_id = $2`, [
      w.locationId,
      shirt,
    ])
  )[0].q;
const header = async (w: FactoryWorld, id: number) =>
  (await w.q(`SELECT voucher_date::text AS d, total_amount::text AS t FROM vouchers WHERE id = $1`, [id]))[0];

describe("PATCH /api/credit-notes/:id: refusals", () => {
  it("refuses a bad id, a missing note, a non-note voucher and invalid lines", async () => {
    await withFactoryWorld(async (w) => {
      const { id, cash, line } = await note(w, "Credit Note");
      const base = { voucherDate: "2026-06-10", cashAccountType: "ledger", cashAccountId: cash };
      expect((await edit(w, "abc", base)).status).toBe(400);
      expect((await edit(w, 2147483000, { ...base, items: [line("1")] })).status).toBe(404);
      const journal = await voucher(w, "Journal");
      expect((await edit(w, journal, { ...base, items: [line("1")] })).body.message).toBe("Not a credit/debit note");
      const bad = [
        [{ ...line("1"), stockItemId: null }, /Invalid stockItemId/],
        [{ ...line("1"), locationId: "x" }, /Invalid locationId/],
        [line("0"), /Invalid quantity/],
        [line("abc"), /Invalid quantity/],
      ] as const;
      for (const [row, message] of bad) {
        const res = await edit(w, id, { ...base, items: [row] });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect(await header(w, id)).toEqual({ d: "2026-06-10", t: "40.00" });
    });
  });

  it("refuses an edit in a closed period with nothing changed", async () => {
    await withFactoryWorld(async (w) => {
      const { id, cash, shirt, line } = await note(w, "Credit Note");
      const before = await stock(w, shirt);
      await closeBooks(w, "2026-12-31");
      const res = await edit(w, id, { voucherDate: "2026-06-10", cashAccountId: cash, items: [line("5")] });
      expect([res.status, res.body.code]).toEqual([409, "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD"]);
      expect(await stock(w, shirt)).toBe(before);
    });
  });

  it("fails a line at another company's location inside the edit transaction", async () => {
    await withFactoryWorld(async (w) => {
      const { id, cash, line } = await note(w, "Credit Note");
      const elsewhere = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}Z`,
      ]);
      const far = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`, [
        elsewhere,
        `${w.tag}FAR`,
      ]);
      const res = await edit(w, id, {
        voucherDate: "2026-06-10",
        cashAccountId: cash,
        items: [{ ...line("1"), locationId: far }],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await header(w, id)).toEqual({ d: "2026-06-10", t: "40.00" });
    });
  });
});

describe("PATCH /api/credit-notes/:id: Kwacha refunds", () => {
  async function zmwNote(w: FactoryWorld, exchangeRate: string | null) {
    const s = await seed(w);
    const id = await w.one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
       VALUES ($1, $2, 'Credit Note', '2026-06-10', 40, 'ZMW', $3) RETURNING id`,
      [w.companyId, `${w.tag}-ZCN`, exchangeRate]
    );
    return { ...s, id };
  }

  it("locks the date, currency and rate of a ZMW refund and requires its stored rate", async () => {
    await withFactoryWorld(async (w) => {
      const { id, line } = await zmwNote(w, "25");
      const items = [line("1")];
      const date = await edit(w, id, { voucherDate: "2026-06-11", items });
      expect([date.status, date.body.code]).toEqual([409, "ZMW_REFUND_DATE_LOCKED"]);
      expect((await edit(w, id, { currency: "USD", items })).body.code).toBe("ZMW_REFUND_RATE_LOCKED");
      expect((await edit(w, id, { exchangeRate: "26", items })).body.code).toBe("ZMW_REFUND_RATE_LOCKED");
      const price = await edit(w, id, { voucherDate: "2026-06-10", currency: "ZMW", exchangeRate: "25", items });
      expect(price.status).toBeGreaterThanOrEqual(400);
      expect(price.status).toBeLessThan(500);
    });
    await withFactoryWorld(async (w) => {
      const { id, line } = await zmwNote(w, null);
      const res = await edit(w, id, { items: [line("1")] });
      expect([res.status, res.body.code]).toEqual([409, "ZMW_REFUND_RATE_MISSING"]);
    });
  });

  it("refuses switching a USD note to ZMW", async () => {
    await withFactoryWorld(async (w) => {
      const { id, line } = await note(w, "Credit Note");
      const res = await edit(w, id, { currency: "ZMW", items: [line("1")] });
      expect([res.status, res.body.code]).toEqual([409, "REFUND_CURRENCY_LOCKED"]);
    });
  });
});

describe("PATCH /api/credit-notes/:id: edits", () => {
  it("rebuilds a credit note with a bank refund, restocks the difference and books the variance", async () => {
    await withFactoryWorld(async (w) => {
      const { id, shirt, line } = await note(w, "Credit Note");
      expect(await stock(w, shirt)).toBe("102.000");
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'B', 'B', '1') RETURNING id`,
        [w.companyId, `${w.tag}-BK`]
      );
      const res = await edit(w, id, {
        voucherDate: "2026-06-12",
        cashAccountType: "bank",
        cashAccountId: bank,
        description: "edited",
        items: [line("3", "15", "10")],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, voucherId: id, message: "Credit Note updated successfully" });
      expect(await header(w, id)).toEqual({ d: "2026-06-12", t: "45.00" });
      expect(await stock(w, shirt)).toBe("103.000");
      const entries = await w.q(
        `SELECT bank_account_id, debit_amount::text AS dr, credit_amount::text AS cr FROM voucher_entries WHERE voucher_id = $1`,
        [id]
      );
      expect(entries).toContainEqual(expect.objectContaining({ bank_account_id: bank, cr: "45.00" }));
      const audit = await w.q(
        `SELECT reason FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 AND reason = 'Credit Note edit'`,
        [id]
      );
      expect(audit).toHaveLength(1);
    });
  });

  it("rebuilds a debit note at a refund below cost", async () => {
    await withFactoryWorld(async (w) => {
      const { id, shirt, cash, line } = await note(w, "Debit Note");
      expect(await stock(w, shirt)).toBe("98.000");
      const res = await edit(w, id, { voucherDate: "2026-06-10", cashAccountId: cash, items: [line("1", "6", "10")] });
      expect(res.status).toBe(200);
      expect(await stock(w, shirt)).toBe("99.000");
      expect((await header(w, id)).t).toBe("6.00");
    });
  });

  it("refuses a missing or empty items list with 400 before any change, also for a Kwacha note", async () => {
    await withFactoryWorld(async (w) => {
      const { id, cash } = await note(w, "Credit Note");
      for (const items of [undefined, [], "x"]) {
        const res = await edit(w, id, { voucherDate: "2026-06-10", cashAccountId: cash, items });
        expect([res.status, res.body.message]).toEqual([400, "At least one item is required"]);
      }
      expect(await header(w, id)).toEqual({ d: "2026-06-10", t: "40.00" });
      const zmw = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
         VALUES ($1, $2, 'Credit Note', '2026-06-10', 40, 'ZMW', 25) RETURNING id`,
        [w.companyId, `${w.tag}-ZNI`]
      );
      expect((await edit(w, zmw, {})).status).toBe(400);
    });
  });
});
