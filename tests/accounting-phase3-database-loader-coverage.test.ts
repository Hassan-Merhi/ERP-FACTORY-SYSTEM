/**
 * loadDatabasePhase3AccountingAudit is reached from the nightly
 * convergenceReconciliation scheduler (scheduledConvergenceReconciliation.ts).
 * The real-database case proves the six snapshot queries run against the
 * migrated schema; the scripted transaction drives the row-validation branches
 * that a healthy database can never produce.
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { loadDatabasePhase3AccountingAudit } from "../server/services/accounting/databasePhase3AccountingAudit";
import { auditPhase3Accounting } from "../server/services/accounting/phase3AccountingAudit";
import { withRolledBackPool } from "./helpers/routedPoolClient";

type Rows = Record<string, unknown>[];
type Tx = Parameters<typeof loadDatabasePhase3AccountingAudit>[0]["tx"];

function scriptedTx(results: Rows[]): { tx: Tx; calls: () => number } {
  let call = 0;
  const tx = { execute: async () => ({ rows: results[call++] ?? [] }) } as unknown as Tx;
  return { tx, calls: () => call };
}

const voucherRow = (over: Record<string, unknown> = {}) => ({
  voucher_id: 11,
  voucher_type: "Payment",
  currency: "USD",
  total_amount: "10",
  deleted_at: null,
  base_debit: "10",
  base_credit: "10",
  tx_debit: "10",
  tx_credit: "10",
  cash_tx_debit: "0",
  cash_tx_credit: "10",
  ...over,
});
const stockRow = { operational_value: "5", accounting_value: "5", inventory_account_count: 1 };

describe("loadDatabasePhase3AccountingAudit against the real schema", () => {
  it("refuses a missing company and loads an empty snapshot for a fresh one", async () => {
    await withRolledBackPool(async (client) => {
      const missing = db.transaction((tx) => loadDatabasePhase3AccountingAudit({ tx, companyId: 2_000_000_000 }));
      await expect(missing).rejects.toMatchObject({ code: "PHASE3_COMPANY_MISSING" });

      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO companies (code, name, company_type) VALUES ('P3LOAD' || floor(random() * 1e9)::text, 'Phase3 loader', 'supplier_partner') RETURNING id`
      );
      const companyId = rows[0].id;
      const snapshot = await db.transaction((tx) => loadDatabasePhase3AccountingAudit({ tx, companyId }));
      expect(snapshot).toEqual({
        companyId,
        payments: [],
        vouchers: [],
        sales: [],
        payrolls: [],
        stock: {
          companyId,
          operationalInventoryValue: "0",
          accountingInventoryValue: "0",
          accountingInventoryAccountCount: 0,
        },
        duplicateEntries: [],
      });
      expect(auditPhase3Accounting(snapshot).clean).toBe(true);
    });
  });
});

describe("loadDatabasePhase3AccountingAudit row mapping", () => {
  it("rejects a non-positive company id before querying", async () => {
    const { tx, calls } = scriptedTx([]);
    await expect(loadDatabasePhase3AccountingAudit({ tx, companyId: 0 })).rejects.toMatchObject({
      code: "PHASE3_DATABASE_ROW_INVALID",
    });
    expect(calls()).toBe(0);
  });

  it("maps vouchers, payments, sales, payroll, stock and duplicates", async () => {
    const { tx, calls } = scriptedTx([
      [{ company_type: "factory" }],
      [
        voucherRow(),
        voucherRow({ voucher_id: 12, voucher_type: "Receipt", deleted_at: "2026-01-01" }),
        voucherRow({ voucher_id: 13, voucher_type: "Sales", tx_debit: "6500", tx_credit: "6500" }),
        voucherRow({ voucher_id: 14, voucher_type: null }),
      ],
      [
        {
          voucher_id: 13,
          total_amount: "10",
          deleted_at: null,
          revenue_credit: "10",
          sold_quantity: "2",
          cogs_value: "4",
          movement_quantity: "-2",
          movement_value: "-4",
        },
      ],
      [
        {
          payroll_id: 3,
          status: "PAID",
          net_salary: "100",
          cash_account_id: null,
          payment_voucher_count: 1,
          payment_voucher_total: "100",
          payment_debit: "100",
          payment_credit: "100",
          payment_cash_credit: "100",
          daybook_count: 1,
          daybook_amount: "100",
        },
        {
          payroll_id: 4,
          status: null,
          net_salary: "0",
          cash_account_id: 77,
          payment_voucher_count: 0,
          payment_voucher_total: "0",
          payment_debit: "0",
          payment_credit: "0",
          payment_cash_credit: "0",
          daybook_count: 0,
          daybook_amount: "0",
        },
      ],
      [stockRow],
      [{ voucher_id: 11, signature: null, occurrences: 2 }],
    ]);
    const snapshot = await loadDatabasePhase3AccountingAudit({ tx, companyId: 5 });
    expect(calls()).toBe(6);
    expect(snapshot.vouchers.map((v) => [v.voucherId, v.ledgerExpectation, v.cancelled])).toEqual([
      [11, expect.any(String), false],
      [12, expect.any(String), true],
      [13, expect.any(String), false],
      [14, "unclassified", false],
    ]);
    // ERP POS Sales headers use base amounts as the document side.
    expect(snapshot.vouchers[2]).toMatchObject({ documentDebit: "10", documentCredit: "10" });
    expect(snapshot.vouchers[0]).toMatchObject({ documentDebit: "10" });
    expect(snapshot.payments.map((p) => [p.voucherId, p.voucherType, p.cancelled])).toEqual([
      [11, "Payment", false],
      [12, "Receipt", true],
    ]);
    expect(snapshot.sales).toEqual([
      expect.objectContaining({ voucherId: 13, revenueRequired: true, cancelled: false }),
    ]);
    expect(snapshot.payrolls.map((p) => [p.payrollId, p.status, p.cashAccountId])).toEqual([
      [3, "PAID", null],
      [4, "", 77],
    ]);
    expect(snapshot.stock).toEqual({
      companyId: 5,
      operationalInventoryValue: "5",
      accountingInventoryValue: "5",
      accountingInventoryAccountCount: 1,
    });
    expect(snapshot.duplicateEntries).toEqual([{ voucherId: 11, signature: "", occurrences: 2 }]);
  });

  it("marks supplier-partner sales as not requiring revenue and keeps cancelled sales", async () => {
    const { tx } = scriptedTx([
      [{ company_type: "Supplier_Partner" }],
      [],
      [
        {
          voucher_id: 20,
          total_amount: "1",
          deleted_at: new Date(),
          revenue_credit: "0",
          sold_quantity: "0",
          cogs_value: "0",
          movement_quantity: "0",
          movement_value: "0",
        },
      ],
      [],
      [stockRow],
      [],
    ]);
    const snapshot = await loadDatabasePhase3AccountingAudit({ tx, companyId: 5 });
    expect(snapshot.sales).toEqual([expect.objectContaining({ revenueRequired: false, cancelled: true })]);
  });

  it("treats a null company type as a normal company", async () => {
    const { tx } = scriptedTx([[{ company_type: null }], [], [], [], [stockRow], []]);
    await expect(loadDatabasePhase3AccountingAudit({ tx, companyId: 5 })).resolves.toMatchObject({ sales: [] });
  });

  it.each([
    ["voucher id", [[voucherRow({ voucher_id: -1 })]], /voucher.voucherId must be a positive integer/],
    ["voucher amount", [[voucherRow({ total_amount: " " })]], /voucher:11.totalAmount is required/],
    ["cash side", [[voucherRow({ cash_tx_credit: null })]], /payment:11.cashCredit is required/],
    [
      "sale amount",
      [[], [{ voucher_id: 2, total_amount: "1", revenue_credit: null }]],
      /sale:2.revenueCredit is required/,
    ],
    [
      "payroll cash account",
      [[], [], [{ payroll_id: 3, net_salary: "1", cash_account_id: 0 }]],
      /payroll:3.cashAccountId must be a positive integer/,
    ],
    [
      "payroll count",
      [[], [], [{ payroll_id: 3, net_salary: "1", cash_account_id: null, payment_voucher_count: -2 }]],
      /payroll:3.paymentVoucherCount must be a non-negative integer/,
    ],
    ["missing stock row", [[], [], [], []], /stock snapshot is missing/],
    [
      "stock count",
      [[], [], [], [{ ...stockRow, inventory_account_count: 1.5 }]],
      /stock.inventoryAccountCount must be a non-negative integer/,
    ],
    [
      "duplicate occurrences",
      [[], [], [], [stockRow], [{ voucher_id: 1, signature: "x", occurrences: "many" }]],
      /duplicateEntry.occurrences must be a non-negative integer/,
    ],
  ])("rejects a corrupt %s row", async (_label, rest, message) => {
    const { tx } = scriptedTx([[{ company_type: "factory" }], ...(rest as Rows[])]);
    await expect(loadDatabasePhase3AccountingAudit({ tx, companyId: 5 })).rejects.toThrow(message);
  });
});
