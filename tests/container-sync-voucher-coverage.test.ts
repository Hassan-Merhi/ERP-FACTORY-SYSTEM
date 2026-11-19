/**
 * POST /api/containers/:id/sync-voucher in a rolled-back factory world: id and
 * company refusals, zero-total POs skipped, the posted-voucher correction
 * refusal (nothing rewritten), and the three rebuild shapes for supplier-,
 * own- and parent-paid freight.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

type Line = { ledger_account_id: number | null; debit: string; credit: string };

async function setup(w: FactoryWorld) {
  const supplierId = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Mill Ltd', '') RETURNING id`,
    [w.companyId, `${w.tag}S`]
  );
  const containerId = await w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id) VALUES ($1, $2, '2026-06-01', $3) RETURNING id`,
    [w.companyId, `${w.tag}C`, supplierId]
  );
  const account = (code: string, type: string) =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
      [w.companyId, `${w.tag}${code}`, type]
    );
  return {
    supplierId,
    containerId,
    purchases: await account("PUR", "Expense"),
    freight: await account("FRT", "Liability"),
    parent: await account("PAR", "Liability"),
  };
}

async function voucher(w: FactoryWorld, number: string, description: string, deleted = false) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, deleted_at)
     VALUES ($1, $2, 'Purchase', '2026-06-02', $3, 100, CASE WHEN $4::boolean THEN now() END) RETURNING id`,
    [w.companyId, `${w.tag}${number}`, description, deleted]
  );
}

async function po(
  w: FactoryWorld,
  s: Awaited<ReturnType<typeof setup>>,
  voucherId: number | null,
  fields: { items: string; freight?: string; paidBy?: string; ownAccount?: number; parentAccount?: number }
) {
  await w.q(
    `INSERT INTO purchase_orders (company_id, container_id, supplier_id, voucher_id, po_number, items_total, freight,
       freight_paid_by, freight_own_account_id, freight_parent_account_id, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'USD', 'Open')`,
    [
      w.companyId,
      s.containerId,
      s.supplierId,
      voucherId,
      `${w.tag}PO${voucherId ?? "x"}${fields.items}`,
      fields.items,
      fields.freight ?? "0",
      fields.paidBy ?? "supplier",
      fields.ownAccount ?? null,
      fields.parentAccount ?? null,
    ]
  );
}

const lines = (w: FactoryWorld, voucherId: number) =>
  w.q<Line>(
    `SELECT ledger_account_id, debit_amount::text AS debit, credit_amount::text AS credit
       FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );

const sync = (w: FactoryWorld, id: number | string) => w.agent.post(`/api/containers/${id}/sync-voucher`).send({});

describe("container sync-voucher", () => {
  it("refuses bad ids and other companies' containers, and skips zero-total POs", () =>
    withFactoryWorld(async (w) => {
      expect((await sync(w, "abc")).status).toBe(400);
      expect((await sync(w, 2_000_000_000)).status).toBe(404);
      const s = await setup(w);
      await po(w, s, null, { items: "0" });
      const res = await sync(w, s.containerId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ updatedLocalVouchers: 0, skipped: [expect.stringContaining("total is 0")] });
    }));

  it("refuses to rewrite a deleted posted voucher and changes nothing", () =>
    withFactoryWorld(async (w) => {
      const s = await setup(w);
      const v = await voucher(w, "DEL", "old", true);
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 100, 0), ($1, $3, 0, 100)`,
        [v, s.purchases, s.freight]
      );
      await po(w, s, v, { items: "40" });
      const res = await sync(w, s.containerId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VOUCHER_DELETED");
      expect((await lines(w, v)).map((l) => [l.debit, l.credit])).toEqual([
        ["100.00", "0.00"],
        ["0.00", "100.00"],
      ]);
    }));

  it("moves supplier-paid lines to the PO total and fixes a stale description", () =>
    withFactoryWorld(async (w) => {
      const s = await setup(w);
      const v = await voucher(w, "STD", "OLD-CONTAINER Mill Ltd");
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, NULL, 100, 0, 'Purchases of goods'), ($1, NULL, $3, 0, 100, 'supplier leg')`,
        [v, s.purchases, s.supplierId]
      );
      await po(w, s, v, { items: "70" });
      const res = await sync(w, s.containerId);
      expect(res.status).toBe(200);
      expect(res.body.updatedLocalVouchers).toBe(1);
      expect((await lines(w, v)).map((l) => [l.debit, l.credit])).toEqual([
        ["70.00", "0.00"],
        ["0.00", "70.00"],
      ]);
      const [row] = await w.q(`SELECT description, total_amount::text AS total FROM vouchers WHERE id = $1`, [v]);
      expect(row).toEqual({ description: `${w.tag}C Mill Ltd`, total: "70.00" });
    }));

  it("adds, then updates, the own-paid freight pair", () =>
    withFactoryWorld(async (w) => {
      const s = await setup(w);
      const v = await voucher(w, "OWN", `${w.tag}C Mill Ltd`);
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 100, 0), ($1, $3, 0, 100)`,
        [v, s.purchases, s.parent]
      );
      await po(w, s, v, { items: "60", freight: "15", paidBy: "own", ownAccount: s.freight });
      expect((await sync(w, s.containerId)).status).toBe(200);
      const first = await lines(w, v);
      expect(first.map((l) => [l.ledger_account_id, l.debit, l.credit])).toEqual([
        [s.purchases, "60.00", "0.00"],
        [s.parent, "0.00", "60.00"],
        [s.purchases, "15.00", "0.00"],
        [s.freight, "0.00", "15.00"],
      ]);
      await w.q(`UPDATE purchase_orders SET freight = 20 WHERE voucher_id = $1`, [v]);
      expect((await sync(w, s.containerId)).status).toBe(200);
      const second = await lines(w, v);
      expect(second).toHaveLength(4);
      expect(second[3]).toMatchObject({ ledger_account_id: s.freight, credit: "20.00" });
    }));

  it("rebuilds parent-paid freight around the company's parent credit account", () =>
    withFactoryWorld(async (w) => {
      const s = await setup(w);
      await w.q(
        `INSERT INTO company_settings (company_id, parent_credit_account_id) VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET parent_credit_account_id = EXCLUDED.parent_credit_account_id`,
        [w.companyId, s.parent]
      );
      const v = await voucher(w, "PAR", `${w.tag}C Mill Ltd`);
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, 100, 0), ($1, $3, 5, 0), ($1, $4, 0, 105)`,
        [v, s.purchases, s.freight, s.parent]
      );
      await po(w, s, v, { items: "50", freight: "10", paidBy: "parent", parentAccount: s.freight });
      expect((await sync(w, s.containerId)).status).toBe(200);
      expect((await lines(w, v)).map((l) => [l.ledger_account_id, l.debit, l.credit])).toEqual([
        [s.parent, "0.00", "60.00"],
        [s.purchases, "50.00", "0.00"],
        [s.purchases, "10.00", "0.00"],
      ]);

      const missing = await voucher(w, "PAR2", `${w.tag}C Mill Ltd`);
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 100, 0)`,
        [missing, s.purchases]
      );
      await po(w, s, missing, { items: "30", freight: "5", paidBy: "parent", parentAccount: s.freight });
      expect((await sync(w, s.containerId)).status).toBe(200);
      expect((await lines(w, missing)).map((l) => [l.ledger_account_id, l.debit, l.credit])).toEqual([
        [s.parent, "0.00", "35.00"],
        [s.purchases, "30.00", "0.00"],
        [s.purchases, "5.00", "0.00"],
      ]);
    }));
});
