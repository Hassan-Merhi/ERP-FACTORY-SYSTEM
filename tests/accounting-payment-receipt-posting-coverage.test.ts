/**
 * Payment / Receipt voucher posting (postPaymentReceiptVoucherTx) and its
 * factory daybook row, against a rolled-back company: amount validation and
 * FX totals, every account type (company checks on ledgers and customers,
 * customer-linked ledgers), both entry orientations for asset and liability
 * payment accounts, optional vouchers, idempotent replays, employee balance
 * sync, the audit row and the daybook entry (with and without factory
 * settings, USD and foreign currency).
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  PaymentReceiptInputError,
  paymentVoucherTotals,
  postPaymentReceiptVoucherTx,
  writePaymentReceiptDaybookEntry,
  type PaymentReceiptInput,
} from "../server/services/accounting/paymentReceiptVoucherPosting";

describe("paymentVoucherTotals", () => {
  it("sums blank amounts as zero, rejects non-numbers and divides foreign totals by the rate", () => {
    const usd = paymentVoucherTotals([{ amount: "10.50" }, { amount: "" }, { amount: null }, {}], "USD", null);
    expect(usd?.transactionTotal.toFixed(2)).toBe("10.50");
    expect(usd?.baseTotal.toFixed(2)).toBe("10.50");
    expect(paymentVoucherTotals([{ amount: "ten" }], "USD", null)).toBeNull();
    const cfa = paymentVoucherTotals([{ amount: 6000 }], "CFA", "600");
    expect(cfa?.baseTotal.toFixed(2)).toBe("10.00");
    expect(paymentVoucherTotals([{ amount: 6000 }], "CFA", "0")?.baseTotal.toFixed(2)).toBe("6000.00");
    expect(paymentVoucherTotals([{ amount: 6000 }], "CFA", null)?.baseTotal.toFixed(2)).toBe("6000.00");
  });
});

async function accounts(world: FactoryWorld) {
  const ledger = (code: string, type: string) =>
    world.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, active) VALUES ($1, $2::varchar, $2::text, $3, true) RETURNING id`,
      [world.companyId, `${world.tag}-${code}`, type]
    );
  const cash = await ledger("CASH", "Cash");
  const expense = await ledger("EXP", "Expense");
  const receivable = await ledger("AR", "Asset");
  const customer = await world.one(
    `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, 'Linked Buyer', $3) RETURNING id`,
    [world.companyId, `${world.tag}-CU`, receivable]
  );
  const plainCustomer = await world.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Walk-in') RETURNING id`,
    [world.companyId, `${world.tag}-CU2`]
  );
  const supplier = await world.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Mill', '') RETURNING id`,
    [world.companyId, `${world.tag}-SU`]
  );
  const employee = await world.one(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date) VALUES ($1, $2, 'Ada', 'K', '2026-01-01')
     RETURNING id`,
    [world.companyId, `${world.tag}-EM`]
  );
  const bank = await world.one(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, active)
     VALUES ($1, $2, 'Main', 'Bank', '001', TRUE) RETURNING id`,
    [world.companyId, `${world.tag}-BK`]
  );
  return { cash, expense, receivable, customer, plainCustomer, supplier, employee, bank };
}

let seq = 0;
function input(world: FactoryWorld, patch: Partial<PaymentReceiptInput>): PaymentReceiptInput {
  return {
    companyId: world.companyId,
    voucherType: "Payment",
    voucherDate: "2026-05-02",
    paymentAccountType: "ledger",
    paymentAccountId: 0,
    entries: [],
    notes: "Rent",
    optional: false,
    currency: "USD",
    exchangeRate: null,
    effectiveDate: null,
    sourceId: `pr-${world.tag}-${++seq}`,
    actor: { userId: world.userId, username: world.username },
    reason: "coverage",
    ...patch,
  };
}

const post = (data: PaymentReceiptInput) => db.transaction((tx) => postPaymentReceiptVoucherTx(tx, data));
const refusal = (data: PaymentReceiptInput) =>
  post(data).then(
    () => "posted",
    (error: Error) => error
  );

describe("postPaymentReceiptVoucherTx refusals", () => {
  it("rejects invalid amounts and other companies' ledgers or customers", () =>
    withFactoryWorld(async (world) => {
      const a = await accounts(world);
      const bad = await refusal(
        input(world, {
          paymentAccountId: a.cash,
          entries: [{ accountType: "ledger", accountId: a.expense, amount: "x" }],
        })
      );
      expect(bad).toBeInstanceOf(PaymentReceiptInputError);
      expect((bad as PaymentReceiptInputError).status).toBe(400);

      const other = await world.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${world.tag}X`,
      ]);
      const foreignLedger = await world.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'F', 'Expense') RETURNING id`,
        [other, `${world.tag}-F`]
      );
      const foreignCustomer = await world.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'F') RETURNING id`,
        [other, `${world.tag}-FC`]
      );
      const ledgerRefusal = await refusal(
        input(world, {
          paymentAccountId: a.cash,
          entries: [{ accountType: "ledger", accountId: foreignLedger, amount: 5 }],
        })
      );
      expect((ledgerRefusal as Error).message).toBe(`Ledger account ${foreignLedger} not found in current company.`);
      const customerRefusal = await refusal(
        input(world, {
          paymentAccountId: a.cash,
          entries: [{ accountType: "customer", accountId: foreignCustomer, amount: 5 }],
        })
      );
      expect((customerRefusal as Error).message).toBe(`Customer ${foreignCustomer} not found in current company.`);
      const [{ count }] = await world.q(`SELECT count(*)::int AS count FROM vouchers WHERE company_id = $1`, [
        world.companyId,
      ]);
      expect(count).toBe(0);
    }));
});

describe("postPaymentReceiptVoucherTx postings", () => {
  it("pays out of cash: Dr contra accounts of every type, Cr cash, and replays the same source", () =>
    withFactoryWorld(async (world) => {
      const a = await accounts(world);
      const data = input(world, {
        paymentAccountId: a.cash,
        entries: [
          { accountType: "ledger", accountId: a.receivable, amount: "1" },
          { accountType: "customer", accountId: a.plainCustomer, amount: "2" },
          { accountType: "customer", accountId: a.customer, amount: "3" },
          { accountType: "supplier", accountId: a.supplier, amount: "4" },
          { accountType: "bank", accountId: a.bank, amount: "5" },
        ],
      });
      const first = await post(data);
      expect(first.replayed).toBe(false);
      const debits = first.entries.filter((e) => Number(e.debitAmount) > 0);
      expect(debits.find((e) => Number(e.debitAmount) === 1)).toMatchObject({
        ledgerAccountId: a.receivable,
        customerId: a.customer,
      });
      expect(debits.find((e) => Number(e.debitAmount) === 2)).toMatchObject({
        customerId: a.plainCustomer,
        ledgerAccountId: null,
      });
      expect(debits.find((e) => Number(e.debitAmount) === 3)).toMatchObject({
        customerId: a.customer,
        ledgerAccountId: a.receivable,
      });
      expect(debits.find((e) => Number(e.debitAmount) === 4)).toMatchObject({ supplierId: a.supplier });
      expect(debits.find((e) => Number(e.debitAmount) === 5)).toMatchObject({ bankAccountId: a.bank });
      const cashCredit = first.entries
        .filter((e) => e.ledgerAccountId === a.cash)
        .reduce((sum, e) => sum + Number(e.creditAmount), 0);
      expect(cashCredit).toBe(15);
      const [audit] = await world.q(
        `SELECT count(*)::int AS count FROM audit_log WHERE company_id = $1 AND record_id = $2`,
        [world.companyId, first.voucher.id]
      );
      expect(audit.count).toBeGreaterThan(0);

      const again = await post(data);
      expect(again).toMatchObject({ replayed: true });
      expect(again.voucher.id).toBe(first.voucher.id);
    }));

  it("pays from and receives into liability accounts with the liability on the right side", () =>
    withFactoryWorld(async (world) => {
      const a = await accounts(world);
      const pay = await post(
        input(world, {
          paymentAccountType: "employee",
          paymentAccountId: a.employee,
          entries: [{ accountType: "ledger", accountId: a.cash, amount: "7" }],
        })
      );
      expect(pay.entries.find((e) => e.employeeId === a.employee)).toMatchObject({ debitAmount: "7.00" });
      const [employee] = await world.q(`SELECT current_balance FROM employees WHERE id = $1`, [a.employee]);
      expect(Number(employee.current_balance)).not.toBe(0);

      const receive = await post(
        input(world, {
          voucherType: "Receipt",
          paymentAccountType: "supplier",
          paymentAccountId: a.supplier,
          entries: [{ accountType: "ledger", accountId: a.cash, amount: "8" }],
        })
      );
      expect(receive.entries.find((e) => e.supplierId === a.supplier)).toMatchObject({ creditAmount: "8.00" });
      expect(receive.entries.find((e) => e.ledgerAccountId === a.cash)).toMatchObject({ debitAmount: "8.00" });
    }));

  it("receives foreign currency into a bank and keeps optional vouchers off the employee balances", () =>
    withFactoryWorld(async (world) => {
      const a = await accounts(world);
      const receipt = await post(
        input(world, {
          voucherType: "Receipt",
          paymentAccountType: "bank",
          paymentAccountId: a.bank,
          currency: "CFA",
          exchangeRate: "600",
          effectiveDate: "2026-05-03",
          notes: null,
          entries: [{ accountType: "ledger", accountId: a.receivable, amount: "6000" }],
        })
      );
      expect(receipt.entries.find((e) => e.bankAccountId === a.bank)).toMatchObject({ debitAmount: "10.00" });
      expect(Number(receipt.voucher.totalAmount)).toBe(10);

      const draft = await post(
        input(world, {
          optional: true,
          paymentAccountType: "factorySupplier",
          paymentAccountId: await world.one(
            `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, 'Kiln') RETURNING id`,
            [world.companyId]
          ),
          entries: [{ accountType: "employee", accountId: a.employee, amount: "9" }],
        })
      );
      expect(draft.voucher.optional).toBe(true);
      const [employee] = await world.q(`SELECT current_balance FROM employees WHERE id = $1`, [a.employee]);
      expect(Number(employee.current_balance)).toBe(0);
    }));
});

describe("writePaymentReceiptDaybookEntry", () => {
  it("writes nothing without factory settings and a converted row with them", () =>
    withFactoryWorld(async (world) => {
      const a = await accounts(world);
      const { voucher } = await post(
        input(world, {
          currency: "CFA",
          exchangeRate: "500",
          paymentAccountId: a.cash,
          entries: [{ accountType: "ledger", accountId: a.expense, amount: "5000" }],
        })
      );
      const rows = () =>
        world.q(`SELECT * FROM factory_daybook_entries WHERE company_id = $1 AND reference_id = $2`, [
          world.companyId,
          voucher.id,
        ]);
      await world.q(`DELETE FROM factory_settings WHERE company_id = $1`, [world.companyId]);
      await writePaymentReceiptDaybookEntry(db, world.companyId, voucher);
      expect(await rows()).toHaveLength(0);

      await world.q(`INSERT INTO factory_settings (company_id) VALUES ($1)`, [world.companyId]);
      await writePaymentReceiptDaybookEntry(db, world.companyId, voucher);
      const [row] = await rows();
      expect(row).toMatchObject({ tx_type: "PAYMENT", currency_code: "CFA" });
      expect(Number(row.amount_currency)).toBe(5000);
      expect(Number(row.amount_usd)).toBe(10);

      for (const voucherType of ["Receipt", "Journal"]) {
        await writePaymentReceiptDaybookEntry(db, world.companyId, {
          ...voucher,
          id: voucher.id,
          voucherType,
          currency: null,
          exchangeRate: null,
          description: null,
        } as unknown as typeof voucher);
      }
      const all = await rows();
      expect(all.map((r) => r.tx_type).sort()).toEqual(["JOURNAL", "PAYMENT", "RECEIPT"]);
      expect(all.find((r) => r.tx_type === "JOURNAL")).toMatchObject({ currency_code: "USD" });
      expect(all.find((r) => r.tx_type === "JOURNAL")?.description).toMatch(/^Journal voucher #/);
    }));
});
