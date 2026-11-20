/**
 * server/routes/reportsLedgerRoutes.ts over HTTP against PostgreSQL, one
 * rolled-back company per test.
 *
 * Pinned: non-numeric ids and parameters are 400; another company's account
 * is 404; the monthly summary defaults to the current calendar year, signs
 * the opening balance credit-positive from a Dr/Cr/blank side plus earlier
 * postings, and ignores deleted and optional vouchers;
 * the month drill-down names each line after its supplier, its voucher's
 * location, its narration, its contra account, or "Multiple Accounts", with
 * "Unknown Supplier"/"Unknown Location" for blank names.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { ledger, nextSeq, otherCompany } from "./helpers/voucherReadFixture";

async function account(w: FactoryWorld, opening: string, side: string | null) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Report Ledger', 'Expense', $3, $4) RETURNING id`,
    [w.companyId, `${w.tag}R${nextSeq()}`, opening, side]
  );
}

async function voucherOn(
  w: FactoryWorld,
  date: string,
  opts: { locationId?: number | null; deleted?: boolean; optional?: boolean } = {}
) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id, optional, deleted_at)
     VALUES ($1, $2, 'Journal', $3, 0, $4, $5, CASE WHEN $6::boolean THEN now() END) RETURNING id`,
    [w.companyId, `${w.tag}V${nextSeq()}`, date, opts.locationId ?? null, opts.optional ?? false, opts.deleted ?? false]
  );
}

async function entry(
  w: FactoryWorld,
  voucherId: number,
  accountId: number,
  debit: string,
  credit: string,
  extra: { supplierId?: number | null; narration?: string | null } = {}
) {
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, supplier_id, narration)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [voucherId, accountId, debit, credit, extra.supplierId ?? null, extra.narration ?? null]
  );
}

describe("ledger monthly summary", () => {
  it("refuses a bad id and another company's account", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get(`/api/reports/ledger-monthly-summary/abc`)).status).toBe(400);
      const other = await otherCompany(w);
      const foreign = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Foreign', 'Expense') RETURNING id`,
        [other, `${w.tag}F`]
      );
      expect((await w.agent.get(`/api/reports/ledger-monthly-summary/${foreign}`)).status).toBe(404);
      expect((await w.agent.get(`/api/reports/ledger-vouchers/${foreign}/2026/3`)).status).toBe(404);
    }));

  it("defaults to the current year and signs a blank-side opening as debit", () =>
    withFactoryWorld(async (w) => {
      const id = await account(w, "40", null);
      const res = await w.agent.get(`/api/reports/ledger-monthly-summary/${id}`);
      expect(res.status).toBe(200);
      const year = new Date().getFullYear();
      // Local-midnight January 1 serialised as UTC: the same day, or the day before east of UTC.
      expect([`${year - 1}-12-31`, `${year}-01-01`]).toContain(res.body.dateRange.startDate);
      expect(res.body.openingBalance).toBe(-40);
      expect(res.body.months).toHaveLength(12);
      expect(res.body.rentServiceMonthPreview).toBeNull();
    }));

  it("adds earlier postings to a credit opening and sums base amounts per month", () =>
    withFactoryWorld(async (w) => {
      const id = await account(w, "100", "Cr");
      const contra = await ledger(w, "Contra", "Cash");
      const earlier = await voucherOn(w, "2025-12-15");
      await entry(w, earlier, id, "30", "0");
      await entry(w, earlier, contra, "0", "30");
      const march = await voucherOn(w, "2026-03-10");
      await entry(w, march, id, "0", "50");
      const deleted = await voucherOn(w, "2026-03-11", { deleted: true });
      await entry(w, deleted, id, "999", "0");
      const optional = await voucherOn(w, "2026-03-12", { optional: true });
      await entry(w, optional, id, "999", "0");
      const res = await w.agent
        .get(`/api/reports/ledger-monthly-summary/${id}`)
        .query({ startDate: "2026-01-01", endDate: "2026-12-31" });
      expect(res.status).toBe(200);
      // Credit opening 100, less the 30 debit posted before the range.
      expect(res.body.openingBalance).toBe(70);
      expect(res.body.months[2]).toMatchObject({ monthName: "March", debit: 0, credit: 50, closingBalance: 120 });
      expect(res.body.grandTotal).toEqual({ debit: 0, credit: 50, closingBalance: 120 });
      expect(res.body.dateRange).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" });
    }));
});

describe("ledger month drill-down", () => {
  it("refuses non-numeric parameters", () =>
    withFactoryWorld(async (w) => {
      const id = await account(w, "0", "Dr");
      for (const path of [`abc/2026/3`, `${id}/x/3`, `${id}/2026/y`]) {
        const res = await w.agent.get(`/api/reports/ledger-vouchers/${path}`);
        expect(res.status).toBe(400);
      }
      expect((await w.agent.get(`/api/reports/ledger-vouchers/999999999/2026/3`)).status).toBe(404);
    }));

  it("names every line after its best available particulars", () =>
    withFactoryWorld(async (w) => {
      const id = await account(w, "10", "Dr");
      const contra = await ledger(w, "Bank Side", "Bank");
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, email, legal_name) VALUES ($1, $2, '', 'Acme Ltd') RETURNING id`,
        [w.companyId, `${w.tag}S1`]
      );
      const blankSupplier = await w.one(
        `INSERT INTO suppliers (company_id, code, email, legal_name) VALUES ($1, $2, '', '') RETURNING id`,
        [w.companyId, `${w.tag}S2`]
      );
      const blankLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, '') RETURNING id`,
        [w.companyId, `${w.tag}BL`]
      );
      const before = await voucherOn(w, "2026-02-20");
      await entry(w, before, id, "0", "4");

      const v1 = await voucherOn(w, "2026-03-01");
      await entry(w, v1, id, "5", "0", { supplierId: supplier });
      const v2 = await voucherOn(w, "2026-03-02");
      await entry(w, v2, id, "6", "0", { supplierId: blankSupplier });
      const v3 = await voucherOn(w, "2026-03-03", { locationId: w.locationId });
      await entry(w, v3, id, "7", "0");
      const v4 = await voucherOn(w, "2026-03-04", { locationId: blankLocation });
      await entry(w, v4, id, "8", "0");
      const v5 = await voucherOn(w, "2026-03-05");
      await entry(w, v5, id, "0", "9", { narration: "x".repeat(60) });
      const v6 = await voucherOn(w, "2026-03-06");
      await entry(w, v6, id, "0", "10");
      await entry(w, v6, contra, "10", "0");
      const v7 = await voucherOn(w, "2026-03-07");
      await entry(w, v7, id, "0", "11");

      const res = await w.agent.get(`/api/reports/ledger-vouchers/${id}/2026/3`);
      expect(res.status).toBe(200);
      expect(res.body.monthName).toBe("March");
      expect(res.body.vouchers.map((v: { particulars: string }) => v.particulars)).toEqual([
        "Acme Ltd",
        "Unknown Supplier",
        "Yard",
        "Unknown Location",
        "x".repeat(50),
        expect.stringContaining("Bank Side"),
        "Multiple Accounts",
      ]);
      // Debit opening 10 is -10 credit-positive; the February credit of 4 lifts it to -6.
      expect(res.body.openingBalance).toBe(-6);
      expect(res.body.totals).toEqual({ debit: 26, credit: 30 });
      expect(res.body.closingBalance).toBe(-2);
    }));
});
