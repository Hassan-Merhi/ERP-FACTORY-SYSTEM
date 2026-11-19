/**
 * resyncPoVoucherCosting (the PO purchase-voucher repair of the container
 * costing sync) against PostgreSQL in one rolled-back transaction per test:
 * no voucher or no mismatch leaves everything alone; standard, same-company
 * parent freight, intercompany parent freight and own-freight vouchers are
 * rewritten to the expected totals with one audit row; a voucher in a closed
 * period is refused with nothing changed.
 */
import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks } from "./helpers/dispatchFlowFixture";
import { ledger, line, voucher } from "./helpers/voucherReadFixture";
import { resyncPoVoucherCosting } from "../server/routes/containers/accounting/costingVoucherResync";
import { toMoney } from "../server/lib/money";

type Args = Parameters<typeof resyncPoVoucherCosting>[0];
type Counts = Args["poCounts"];

async function purchaseOrder(w: FactoryWorld, voucherId: number | null) {
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme', 'a@x.io') RETURNING id`,
    [w.companyId, `${w.tag}-S`]
  );
  const container = await w.one(
    `INSERT INTO containers (company_id, container_number, supplier_id, import_date) VALUES ($1, $2, $3, '2026-04-01')
     RETURNING id`,
    [w.companyId, `${w.tag}-CN`, supplier]
  );
  const [po] = await w.q(
    `INSERT INTO purchase_orders (company_id, po_number, supplier_id, container_id, voucher_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, company_id AS "companyId", po_number AS "poNumber", voucher_id AS "voucherId"`,
    [w.companyId, `${w.tag}-PO`, supplier, container, voucherId]
  );
  return { po: po as Args["po"], supplier };
}

const counts = (): Counts => ({
  scannedPOs: 1,
  updatedLocalVouchers: 0,
  updatedParentVouchers: 0,
  updatedFreightVouchers: 0,
});

function run(w: FactoryWorld, po: Args["po"], over: Partial<Args>) {
  const poCounts = counts();
  const promise = resyncPoVoucherCosting({
    po,
    hasParentFreight: false,
    isSameCompanyPo: true,
    poFreightParentAccountId: null,
    poFreight: toMoney("0"),
    grossTotal: toMoney("100"),
    hasOwnFreight: false,
    freightAccountId: null,
    expectedLocalTotal: toMoney("100"),
    req: { session: { userId: w.userId, username: w.username } } as unknown as Request,
    intercoTotal: toMoney("100"),
    cNum: "CN-9",
    poCounts,
    ...over,
  });
  return { promise, poCounts };
}

const lines = (w: FactoryWorld, voucherId: number) =>
  w.q<{ ledger: number | null; supplier: number | null; dr: string; cr: string; narration: string }>(
    `SELECT ledger_account_id AS ledger, supplier_id AS supplier, debit_amount::text AS dr, credit_amount::text AS cr,
       narration FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );
const audits = async (w: FactoryWorld, voucherId: number) =>
  (
    await w.q(`SELECT reason FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 AND reason IS NOT NULL`, [
      voucherId,
    ])
  ).map((row) => row.reason);
const total = async (w: FactoryWorld, voucherId: number) =>
  (await w.q(`SELECT total_amount::text AS t FROM vouchers WHERE id = $1`, [voucherId]))[0].t;

async function standardVoucher(w: FactoryWorld, amount = "100") {
  const id = await voucher(w, "Purchase", { total: amount });
  const purchases = await ledger(w, "Purchases", "Expense");
  const { po, supplier } = await purchaseOrder(w, id);
  await line(w, id, { ledger_account_id: purchases }, amount);
  await line(w, id, { supplier_id: supplier }, "0", amount);
  return { id, po, purchases, supplier };
}

describe("resyncPoVoucherCosting: nothing to repair", () => {
  it("ignores a PO without a voucher, a missing voucher and a voucher already at the expected total", async () => {
    await withFactoryWorld(async (w) => {
      const { po: noVoucher } = await purchaseOrder(w, null);
      const a = run(w, noVoucher, {});
      await a.promise;
      expect(a.poCounts.updatedLocalVouchers).toBe(0);
      const b = run(w, { ...noVoucher, voucherId: 2147483000 }, {});
      await b.promise;
      expect(b.poCounts.updatedLocalVouchers).toBe(0);
    });
    await withFactoryWorld(async (w) => {
      const { id, po } = await standardVoucher(w);
      const c = run(w, po, { expectedLocalTotal: toMoney("100.0005") });
      await c.promise;
      expect(c.poCounts.updatedLocalVouchers).toBe(0);
      expect(await audits(w, id)).toEqual([]);
    });
  });
});

describe("resyncPoVoucherCosting: standard supplier-paid freight", () => {
  it("rewrites every debit and credit line to the expected total and audits the edit", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po, purchases, supplier } = await standardVoucher(w);
      const { promise, poCounts } = run(w, po, { expectedLocalTotal: toMoney("120") });
      await promise;
      expect(poCounts.updatedLocalVouchers).toBe(1);
      expect(await total(w, id)).toBe("120.00");
      expect(await lines(w, id)).toEqual([
        expect.objectContaining({ ledger: purchases, dr: "120.00", cr: "0.00" }),
        expect.objectContaining({ supplier, dr: "0.00", cr: "120.00" }),
      ]);
      expect(await audits(w, id)).toEqual(["containers-sync-all-vouchers"]);
    });
  });

  it("is refused in a closed period and leaves the voucher unchanged", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po } = await standardVoucher(w);
      await closeBooks(w, "2026-12-31");
      const { promise, poCounts } = run(w, po, { expectedLocalTotal: toMoney("120") });
      await expect(promise).rejects.toMatchObject({ code: "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD" });
      expect(poCounts.updatedLocalVouchers).toBe(0);
      expect(await total(w, id)).toBe("100.00");
      expect((await lines(w, id)).map((l) => [l.dr, l.cr])).toEqual([
        ["100.00", "0.00"],
        ["0.00", "100.00"],
      ]);
    });
  });
});

describe("resyncPoVoucherCosting: same-company parent freight", () => {
  it("adds the missing freight credit and re-splits goods against the supplier", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po, purchases, supplier } = await standardVoucher(w);
      const freightAcct = await ledger(w, "Freight Payable", "Liability");
      const { promise, poCounts } = run(w, po, {
        hasParentFreight: true,
        poFreightParentAccountId: freightAcct,
        poFreight: toMoney("20"),
        grossTotal: toMoney("120"),
        intercoTotal: toMoney("100"),
        expectedLocalTotal: toMoney("120"),
      });
      await promise;
      expect(poCounts).toMatchObject({ updatedLocalVouchers: 1, updatedFreightVouchers: 1 });
      expect(await lines(w, id)).toEqual([
        expect.objectContaining({ ledger: purchases, dr: "120.00" }),
        expect.objectContaining({ supplier, cr: "100.00" }),
        expect.objectContaining({ ledger: freightAcct, cr: "20.00", narration: `Freight - ${po.poNumber} (CN-9)` }),
      ]);
    });
  });

  it("keeps one freight credit, deletes duplicates and stray lines, and corrects the amount", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po } = await standardVoucher(w, "120");
      const freightAcct = await ledger(w, "Freight Payable", "Liability");
      await line(w, id, { ledger_account_id: freightAcct }, "0", "5");
      await line(w, id, { ledger_account_id: freightAcct }, "0", "5");
      await line(w, id, { ledger_account_id: await ledger(w, "Stray", "Expense") }, "0", "7");
      const { promise } = run(w, po, {
        hasParentFreight: true,
        poFreightParentAccountId: freightAcct,
        poFreight: toMoney("20"),
        grossTotal: toMoney("120"),
        intercoTotal: toMoney("100"),
        expectedLocalTotal: toMoney("120"),
        cNum: String(po.id),
      });
      await promise;
      const after = await lines(w, id);
      expect(after.map((l) => [l.dr, l.cr])).toEqual([
        ["120.00", "0.00"],
        ["0.00", "100.00"],
        ["0.00", "20.00"],
      ]);
      expect(after[2]).toMatchObject({ ledger: freightAcct, narration: `Freight - ${po.poNumber}` });
    });
  });
});

describe("resyncPoVoucherCosting: intercompany parent freight", () => {
  async function intercoVoucher(w: FactoryWorld, withParentLine: boolean) {
    const id = await voucher(w, "Purchase", { total: "100" });
    const purchases = await ledger(w, "Purchases", "Expense");
    const parentCredit = await ledger(w, "Due to parent", "Liability");
    const freightAcct = await ledger(w, "Parent freight", "Liability");
    await w.q(`INSERT INTO company_settings (company_id, parent_credit_account_id) VALUES ($1, $2)`, [
      w.companyId,
      parentCredit,
    ]);
    const { po } = await purchaseOrder(w, id);
    await line(w, id, { ledger_account_id: purchases }, "100");
    if (withParentLine) await line(w, id, { ledger_account_id: parentCredit }, "0", "100");
    else await line(w, id, { ledger_account_id: freightAcct }, "0", "100");
    return { id, po, purchases, parentCredit, freightAcct };
  }
  const interco = (freightAcct: number) => ({
    hasParentFreight: true,
    isSameCompanyPo: false,
    poFreightParentAccountId: freightAcct,
    poFreight: toMoney("20"),
    grossTotal: toMoney("120"),
    intercoTotal: toMoney("100"),
    expectedLocalTotal: toMoney("120"),
  });

  it("rebuilds the old single-debit voucher as goods and freight debits against the parent credit", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po, purchases, parentCredit, freightAcct } = await intercoVoucher(w, true);
      await run(w, po, interco(freightAcct)).promise;
      const after = await lines(w, id);
      expect(after).toHaveLength(3);
      expect(after).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ledger: parentCredit, cr: "120.00" }),
          expect.objectContaining({ ledger: purchases, dr: "100.00", narration: po.poNumber }),
          expect.objectContaining({ ledger: purchases, dr: "20.00", narration: `Freight - ${po.poNumber} (CN-9)` }),
        ])
      );
    });
  });

  it("inserts the parent credit when only a stray freight credit exists", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po, parentCredit, freightAcct } = await intercoVoucher(w, false);
      await run(w, po, { ...interco(freightAcct), expectedLocalTotal: toMoney("100") }).promise;
      const after = await lines(w, id);
      expect(after.find((l) => l.ledger === freightAcct)).toBeUndefined();
      expect(after).toContainEqual(
        expect.objectContaining({
          ledger: parentCredit,
          cr: "120.00",
          narration: `PO ${po.poNumber} - Credit to parent`,
        })
      );
      expect(after.filter((l) => l.dr !== "0.00").map((l) => l.dr)).toEqual(["100.00", "20.00"]);
    });
  });
});

describe("resyncPoVoucherCosting: own freight", () => {
  it("adds the freight debit and credit pair when the freight credit is missing", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po, purchases } = await standardVoucher(w);
      const freightAcct = await ledger(w, "Own freight", "Liability");
      await run(w, po, {
        hasOwnFreight: true,
        freightAccountId: freightAcct,
        poFreight: toMoney("15"),
        intercoTotal: toMoney("100"),
      }).promise;
      const after = await lines(w, id);
      expect(after.slice(2)).toEqual([
        expect.objectContaining({ ledger: purchases, dr: "15.00" }),
        expect.objectContaining({ ledger: freightAcct, cr: "15.00" }),
      ]);
    });
  });

  it("updates an existing freight credit and the goods lines to the new totals", async () => {
    await withFactoryWorld(async (w) => {
      const { id, po } = await standardVoucher(w);
      const freightAcct = await ledger(w, "Own freight", "Liability");
      await line(w, id, { ledger_account_id: freightAcct }, "10");
      await line(w, id, { ledger_account_id: freightAcct }, "0", "10");
      await run(w, po, {
        hasOwnFreight: true,
        freightAccountId: freightAcct,
        poFreight: toMoney("15"),
        intercoTotal: toMoney("90"),
        expectedLocalTotal: toMoney("90"),
      }).promise;
      expect((await lines(w, id)).map((l) => [l.dr, l.cr])).toEqual([
        ["90.00", "0.00"],
        ["0.00", "90.00"],
        ["10.00", "0.00"],
        ["0.00", "15.00"],
      ]);
      expect(await total(w, id)).toBe("90.00");
    });
  });
});
