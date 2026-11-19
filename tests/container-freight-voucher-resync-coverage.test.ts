/**
 * resyncPurchaseOrderVoucher (server/routes/containers/
 * containerFreightWriteRoutesVoucherResync.ts), called directly inside a
 * rolled-back transaction: no-op when nothing changed, the posted-voucher
 * correction refusal (lines untouched), and every line-rebuild shape for
 * standard, own-paid, same-company parent-paid and intercompany parent-paid
 * freight.
 */
import type { Request } from "express";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { toMoney } from "../server/lib/money";
import { resyncPurchaseOrderVoucher } from "../server/routes/containers/containerFreightWriteRoutesVoucherResync";
import { withRolledBackPool } from "./helpers/routedPoolClient";

type Input = Parameters<typeof resyncPurchaseOrderVoucher>[0];
let seq = 0;

async function world(client: PoolClient) {
  const tag = `FR${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase();
  // Every statement is a literal at its call site; this only reads the returned id.
  const one = async (pending: Promise<{ rows: Array<{ id: unknown }> }>) => Number((await pending).rows[0].id);
  const companyId = await one(
    client.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [tag])
  );
  const account = (code: string) =>
    one(
      client.query(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Expense') RETURNING id`,
        [companyId, `${tag}${code}`]
      )
    );
  const accounts = {
    purchases: await account("PUR"),
    supplier: await account("SUP"),
    freight: await account("FRT"),
    parent: await account("PAR"),
    other: await account("OTH"),
  };
  const voucher = async (lines: Array<[number, number, number]>, deleted = false) => {
    const id = await one(
      client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
       VALUES ($1, $2, 'Purchase', '2026-06-02', 100, CASE WHEN $3::boolean THEN now() END) RETURNING id`,
        [companyId, `${tag}-${++seq}`, deleted]
      )
    );
    for (const [ledger, debit, credit] of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
        [id, ledger, debit, credit]
      );
    }
    return id;
  };
  const lines = async (voucherId: number) =>
    (
      await client.query(
        `SELECT ledger_account_id AS a, debit_amount::text AS d, credit_amount::text AS c FROM voucher_entries
          WHERE voucher_id = $1 ORDER BY id`,
        [voucherId]
      )
    ).rows.map((r) => [r.a, r.d, r.c]);
  return { client, companyId, accounts, voucher, lines };
}

function input(
  w: Awaited<ReturnType<typeof world>>,
  voucherId: number | null,
  overrides: Partial<Input> = {},
  po: { freightOwnAccountId?: number | null; freightParentAccountId?: number | null } = {}
): Omit<Input, "tx"> {
  return {
    existingPO: {
      voucherId,
      companyId: w.companyId,
      poNumber: "PO-1",
      freightOwnAccountId: po.freightOwnAccountId ?? null,
      freightParentAccountId: po.freightParentAccountId ?? null,
    } as Input["existingPO"],
    voucherTotalMismatch: false,
    newLocalVoucherTotal: toMoney("120"),
    oldLocalVoucherTotal: toMoney("100"),
    freightPaidByChanged: false,
    freightOwnAccountChanged: false,
    freightParentVoucherNeedsUpdate: false,
    req: { session: { userId: "u1", username: "tester" } } as unknown as Request,
    newHasParentFreight: false,
    newFreightParentAccountId: null,
    _pfParentId: null,
    _isSameCompanyOrNoInterco: true,
    newFreight: toMoney("20"),
    newGrandTotal: toMoney("120"),
    supplierTotal: toMoney("100"),
    _freightNarration: "Freight - PO-1",
    newHasOwnFreight: false,
    newFreightOwnAccountId: null,
    ...overrides,
  } as Omit<Input, "tx">;
}

const run = (args: Omit<Input, "tx">) => db.transaction((tx) => resyncPurchaseOrderVoucher({ ...args, tx }));

describe("resyncPurchaseOrderVoucher", () => {
  it("does nothing without a voucher or when no total or freight setting changed", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const v = await w.voucher([
        [w.accounts.purchases, 100, 0],
        [w.accounts.supplier, 0, 100],
      ]);
      await run(input(w, null));
      await run(input(w, v, { newLocalVoucherTotal: toMoney("100.0005") }));
      expect(await w.lines(v)).toEqual([
        [w.accounts.purchases, "100.00", "0.00"],
        [w.accounts.supplier, "0.00", "100.00"],
      ]);
    }));

  it("refuses a deleted posted voucher and leaves its lines", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const v = await w.voucher([[w.accounts.purchases, 100, 0]], true);
      await expect(run(input(w, v))).rejects.toMatchObject({ code: "VOUCHER_DELETED" });
      expect(await w.lines(v)).toEqual([[w.accounts.purchases, "100.00", "0.00"]]);
    }));

  it("moves standard lines to the new total and drops old embedded freight lines", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const v = await w.voucher([
        [w.accounts.purchases, 100, 0],
        [w.accounts.supplier, 0, 80],
        [w.accounts.freight, 0, 20],
      ]);
      await run(input(w, v, { freightPaidByChanged: true }, { freightOwnAccountId: w.accounts.freight }));
      expect(await w.lines(v)).toEqual([
        [w.accounts.purchases, "120.00", "0.00"],
        [w.accounts.supplier, "0.00", "120.00"],
      ]);
      const [row] = (await client.query(`SELECT total_amount::text AS t FROM vouchers WHERE id = $1`, [v])).rows;
      expect(row.t).toBe("120.00");
    }));

  it("adds an own-paid freight pair, then updates it in place", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const v = await w.voucher([
        [w.accounts.purchases, 100, 0],
        [w.accounts.supplier, 0, 100],
      ]);
      const own = { newHasOwnFreight: true, newFreightOwnAccountId: w.accounts.freight, voucherTotalMismatch: true };
      await run(input(w, v, own));
      expect(await w.lines(v)).toEqual([
        [w.accounts.purchases, "100.00", "0.00"],
        [w.accounts.supplier, "0.00", "100.00"],
        [w.accounts.purchases, "20.00", "0.00"],
        [w.accounts.freight, "0.00", "20.00"],
      ]);
      const v2 = await w.voucher([
        [w.accounts.freight, 10, 0],
        [w.accounts.purchases, 100, 0],
        [w.accounts.freight, 0, 10],
        [w.accounts.supplier, 0, 100],
      ]);
      await run(input(w, v2, { ...own, newFreight: toMoney("25") }));
      expect(await w.lines(v2)).toEqual([
        [w.accounts.freight, "25.00", "0.00"],
        [w.accounts.purchases, "100.00", "0.00"],
        [w.accounts.freight, "0.00", "25.00"],
        [w.accounts.supplier, "0.00", "100.00"],
      ]);
    }));

  it("rebuilds same-company parent freight, keeping one freight credit and dropping extras", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const parentFreight = {
        newHasParentFreight: true,
        newFreightParentAccountId: w.accounts.parent,
        freightParentVoucherNeedsUpdate: true,
      };
      const v = await w.voucher([
        [w.accounts.purchases, 100, 0],
        [w.accounts.other, 5, 0],
        [w.accounts.supplier, 0, 90],
        [w.accounts.parent, 0, 10],
        [w.accounts.parent, 0, 5],
      ]);
      await run(input(w, v, parentFreight));
      expect(await w.lines(v)).toEqual([
        [w.accounts.purchases, "120.00", "0.00"],
        [w.accounts.supplier, "0.00", "100.00"],
        [w.accounts.parent, "0.00", "20.00"],
      ]);
      const bare = await w.voucher([[w.accounts.other, 3, 0]]);
      await run(input(w, bare, parentFreight));
      expect(await w.lines(bare)).toEqual([
        [w.accounts.other, "120.00", "0.00"],
        [w.accounts.parent, "0.00", "20.00"],
      ]);
    }));

  it("rebuilds intercompany parent freight around the child's parent credit account", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const interco = {
        newHasParentFreight: true,
        newFreightParentAccountId: w.accounts.freight,
        _isSameCompanyOrNoInterco: false,
        voucherTotalMismatch: true,
      };
      const noSettings = await w.voucher([
        [w.accounts.purchases, 100, 0],
        [w.accounts.supplier, 0, 100],
      ]);
      await run(input(w, noSettings, interco));
      expect(await w.lines(noSettings)).toEqual([
        [w.accounts.purchases, "100.00", "0.00"],
        [w.accounts.purchases, "20.00", "0.00"],
      ]);

      await client.query(
        `INSERT INTO company_settings (company_id, parent_credit_account_id) VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET parent_credit_account_id = EXCLUDED.parent_credit_account_id`,
        [w.companyId, w.accounts.parent]
      );
      const kept = await w.voucher([
        [w.accounts.freight, 9, 0],
        [w.accounts.purchases, 100, 0],
        [w.accounts.parent, 0, 109],
      ]);
      await run(input(w, kept, interco));
      expect(await w.lines(kept)).toEqual([
        [w.accounts.parent, "0.00", "120.00"],
        [w.accounts.purchases, "100.00", "0.00"],
        [w.accounts.purchases, "20.00", "0.00"],
      ]);
      const inserted = await w.voucher([[w.accounts.supplier, 0, 50]]);
      await run(input(w, inserted, interco));
      expect(await w.lines(inserted)).toEqual([[w.accounts.parent, "0.00", "120.00"]]);
    }));
});
