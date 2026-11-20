/**
 * server/routes/containers/containerHelpers.ts: syncIntercoParentVoucher
 * (no parent company, missing journal with and without a verified parent,
 * the PARENT-FREIGHT fallback journal create/update, an unchanged journal,
 * total and freight resyncs, stale freight removal), requireNonSP and the
 * small entry predicates. Everything runs on one rolled-back transaction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  calcPoAmounts,
  isCreditOnlyEntry,
  isDebitOnlyEntry,
  requireNonSP,
  syncIntercoParentVoucher,
} from "../server/routes/containers/containerHelpers";
import { toMoney } from "../server/lib/money";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

afterEach(() => {
  vi.restoreAllMocks();
});

async function accounts(w: FactoryWorld) {
  const mk = (code: string, name: string, type: string) =>
    w.one(`INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`, [
      w.companyId,
      `${w.tag}${code}`,
      name,
      type,
    ]);
  return {
    receivable: await mk("R", "Sub receivable", "Asset"),
    supplier: await mk("S", "Supplier payable", "Liability"),
    freight: await mk("F", "Freight payable", "Liability"),
  };
}

async function parentJournal(w: FactoryWorld, total: string, lines: Array<[number, string, string, string]>) {
  const id = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description)
     VALUES ($1, $2, 'Journal', CURRENT_DATE, $3, 'CONT-9 SUPPLIER') RETURNING id`,
    [w.companyId, `INTERCO-PARENT-${w.tag}PO-1-1700000000`, total]
  );
  for (const [account, debit, credit, narration] of lines) {
    await w.q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration) VALUES ($1, $2, $3, $4, $5)`,
      [id, account, debit, credit, narration]
    );
  }
  return id;
}

const entriesOf = (w: FactoryWorld, voucherId: number) =>
  w.q<{ ledger_account_id: number; debit_amount: string; credit_amount: string; narration: string }>(
    `SELECT ledger_account_id, debit_amount::text, credit_amount::text, narration FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );

describe("entry predicates and PO amounts", () => {
  it("classifies one-sided entries and excludes freight paid by the subsidiary or parent", () => {
    expect(isDebitOnlyEntry({ debitAmount: "5", creditAmount: "0" })).toBe(true);
    expect(isDebitOnlyEntry({ debitAmount: "5", creditAmount: "1" })).toBe(false);
    expect(isCreditOnlyEntry({ debitAmount: null, creditAmount: "2" })).toBe(true);
    expect(isCreditOnlyEntry({ debitAmount: "0", creditAmount: "0" })).toBe(false);
    expect(calcPoAmounts({ itemsTotal: "100", freight: "10", discount: "5", freightPaidBy: "own" })).toMatchObject({
      grossTotal: 105,
      intercoTotal: 95,
    });
    expect(calcPoAmounts({ itemsTotal: "100", freight: "10" })).toMatchObject({
      intercoTotal: 110,
      freightPaidBy: "supplier",
    });
  });
});

describe("syncIntercoParentVoucher", () => {
  it("returns not-found without a parent company or when the verified parent's journal is missing", async () => {
    await withFactoryWorld(async (w) => {
      // storage caches the parent id for five minutes, so stub it per case.
      const parent = vi.spyOn(storage, "getParentCompanyId").mockResolvedValue(null);
      expect(await syncIntercoParentVoucher(db, "NOPE", "10")).toEqual({
        found: false,
        updated: false,
        amount: "10.00",
      });
      expect(await syncIntercoParentVoucher(db, ["NOPE", ""], "10", "CONT-X", undefined, w.companyId)).toEqual({
        found: false,
        updated: false,
        amount: "10.00",
      });
      parent.mockRestore();
    });
  });

  it("creates and then updates a PARENT-FREIGHT fallback journal when no parent journal exists", async () => {
    await withFactoryWorld(async (w) => {
      const parent = vi.spyOn(storage, "getParentCompanyId").mockResolvedValue(w.companyId);
      const acc = await accounts(w);
      const sub = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}SUB`,
      ]);
      await w.q(
        `INSERT INTO intercompany_pos_configs (source_company_id, dest_company_id, dest_interco_account_id, source_interco_account_id) VALUES ($1, $2, $3, $3)`,
        [sub, w.companyId, acc.receivable]
      );
      const opts = { freightAmount: "40", freightParentAccountId: acc.freight, subsidiaryCompanyId: sub };
      const created = await syncIntercoParentVoucher(db, `${w.tag}NEW`, "500", "CONT-1", opts);
      expect(created).toMatchObject({ found: true, updated: true, amount: "40.00" });
      const lines = await entriesOf(w, created.voucherId!);
      expect(lines.map((l) => [l.ledger_account_id, l.debit_amount, l.credit_amount])).toEqual([
        [acc.freight, "0.00", "40.00"],
        [acc.receivable, "40.00", "0.00"],
      ]);

      const updated = await syncIntercoParentVoucher(db, `${w.tag}NEW`, "500", undefined, {
        ...opts,
        freightAmount: "55",
      });
      expect(updated).toMatchObject({ found: true, updated: true, voucherId: created.voucherId, amount: "55.00" });
      const after = await entriesOf(w, created.voucherId!);
      expect(after.map((l) => [l.debit_amount, l.credit_amount])).toEqual([
        ["0.00", "55.00"],
        ["55.00", "0.00"],
      ]);
      expect(after[0].narration).toBe(`Freight - ${w.tag}NEW`);
      parent.mockRestore();
    });
  });

  it("gives up on the fallback when the subsidiary is the parent, or the engine refuses a one-sided journal", async () => {
    await withFactoryWorld(async (w) => {
      const parent = vi.spyOn(storage, "getParentCompanyId").mockResolvedValue(w.companyId);
      const acc = await accounts(w);
      const same = await syncIntercoParentVoucher(db, `${w.tag}P`, "10", "C", {
        freightAmount: "5",
        freightParentAccountId: acc.freight,
        subsidiaryCompanyId: w.companyId,
      });
      expect(same).toEqual({ found: false, updated: false, amount: "10.00" });
      const sub = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}S2`,
      ]);
      await w.q(`SAVEPOINT before_one_sided`);
      const oneSided = await syncIntercoParentVoucher(db, `${w.tag}Q`, "10", "C", {
        freightAmount: "5",
        freightParentAccountId: acc.freight,
        subsidiaryCompanyId: sub,
      });
      await w.q(`ROLLBACK TO SAVEPOINT before_one_sided`);
      expect(oneSided).toEqual({ found: false, updated: false, amount: "10.00" });
      parent.mockRestore();
    });
  });

  it("leaves a matching journal alone and rescales the lines when the total changes", async () => {
    await withFactoryWorld(async (w) => {
      const acc = await accounts(w);
      const id = await parentJournal(w, "100", [
        [acc.receivable, "100", "0", "PO"],
        [acc.supplier, "0", "100", "PO"],
      ]);
      const same = await syncIntercoParentVoucher(db, `${w.tag}PO-1`, "100.0004", "CONT-9", undefined, w.companyId);
      expect(same).toEqual({ found: true, updated: false, voucherId: id, amount: "100.00", oldAmount: "100.00" });

      const changed = await syncIntercoParentVoucher(db, `${w.tag}PO-1`, "120", "CONT-9", undefined, w.companyId);
      expect(changed).toMatchObject({ updated: true, amount: "120.00", oldAmount: "100.00" });
      expect((await entriesOf(w, id)).map((l) => [l.debit_amount, l.credit_amount])).toEqual([
        ["120.00", "0.00"],
        ["0.00", "120.00"],
      ]);
    });
  });

  it("splits out a missing freight credit, then fixes its amount and container narration", async () => {
    await withFactoryWorld(async (w) => {
      const acc = await accounts(w);
      const id = await parentJournal(w, "100", [
        [acc.receivable, "100", "0", "PO"],
        [acc.supplier, "0", "100", "PO"],
      ]);
      const opts = { freightAmount: "30", freightParentAccountId: acc.freight };
      const split = await syncIntercoParentVoucher(db, `${w.tag}PO-1`, "100", "CONT-9", opts, w.companyId);
      expect(split.updated).toBe(true);
      expect(
        (await entriesOf(w, id)).map((l) => [l.ledger_account_id, l.debit_amount, l.credit_amount, l.narration])
      ).toEqual([
        [acc.receivable, "100.00", "0.00", "PO"],
        [acc.supplier, "0.00", "70.00", "PO"],
        [acc.freight, "0.00", "30.00", `Freight - ${w.tag}PO-1 (CONT-9)`],
      ]);

      await w.q(
        `UPDATE voucher_entries SET narration = 'Freight - old' WHERE voucher_id = $1 AND ledger_account_id = $2`,
        [id, acc.freight]
      );
      const renamed = await syncIntercoParentVoucher(db, `${w.tag}PO-1`, "100", "CONT-9", opts, w.companyId);
      expect(renamed.updated).toBe(true);
      const freightLine = (await entriesOf(w, id)).find((l) => l.ledger_account_id === acc.freight)!;
      expect(freightLine.narration).toBe(`Freight - ${w.tag}PO-1 (CONT-9)`);

      const unchanged = await syncIntercoParentVoucher(db, `${w.tag}PO-1`, "100", "CONT-9", opts, w.companyId);
      expect(unchanged.updated).toBe(false);
    });
  });

  it("removes a stale freight credit when freight is no longer parent-paid", async () => {
    await withFactoryWorld(async (w) => {
      const acc = await accounts(w);
      const id = await parentJournal(w, "100", [
        [acc.receivable, "100", "0", "PO"],
        [acc.supplier, "0", "70", "PO"],
        [acc.freight, "0", "30", "Freight - PO-1"],
      ]);
      const res = await syncIntercoParentVoucher(db, `${w.tag}PO-1`, "100", "CONT-9", undefined, w.companyId);
      expect(res.updated).toBe(true);
      const lines = await entriesOf(w, id);
      expect(lines.map((l) => [l.ledger_account_id, l.credit_amount])).toEqual([
        [acc.receivable, "0.00"],
        [acc.supplier, "100.00"],
      ]);
      expect(toMoney(lines[0].debit_amount).toFixed(2)).toBe("100.00");
    });
  });
});

describe("requireNonSP", () => {
  const run = async (companyId: number | undefined) => {
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    const next = vi.fn();
    await requireNonSP({ session: { currentCompanyId: companyId } } as never, res as never, next);
    return { res, next };
  };

  it("passes without a company or for a normal company and blocks a supplier partner", async () => {
    await withFactoryWorld(async (w) => {
      expect((await run(undefined)).next).toHaveBeenCalledWith();
      expect((await run(w.companyId)).next).toHaveBeenCalledWith();
      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      const blocked = await run(w.companyId);
      expect(blocked.res.status).toHaveBeenCalledWith(403);
      expect(blocked.next).not.toHaveBeenCalled();
    });
  });

  it("hands a database error to next", async () => {
    const spy = vi.spyOn(db, "execute").mockRejectedValueOnce(new Error("db down"));
    const { next } = await run(42);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "db down" }));
    spy.mockRestore();
  });
});
