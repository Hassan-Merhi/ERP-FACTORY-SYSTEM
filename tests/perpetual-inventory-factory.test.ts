/**
 * The factory under perpetual inventory (wave 8.4).
 *
 * Once a company's cut-over is applied:
 *   - a finalized factory invoice posts a journal numbered with the invoice:
 *     Dr customer ledger / Cr factory sales for the grand total less the
 *     charges that have their own CHARGE- voucher, and Dr COGS / Cr finished
 *     goods for the recorded cost of its bales; the factory customer ledger
 *     does not count it twice; un-finalizing removes it;
 *   - an invoice in another currency with no confirmed factory rate is
 *     refused (wave 17 B; it used to post nothing) and is listed;
 *   - the daily factory stock journal moves the factory stock accounts to the
 *     costing value, credits the expensed cost of the raw material received,
 *     and puts what is left in production variance; a second run the same day
 *     replaces it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import {
  loadCustomerLedgerLines,
  loadCustomerNotInLedger,
} from "../server/services/accounting/balances/customerLedgerStatement";
import {
  listUnpostedFactoryInvoices,
  syncFactoryInvoiceTx,
} from "../server/services/accounting/perpetualInventory/factoryInvoice";
import { syncFactoryStockJournalTx } from "../server/services/accounting/perpetualInventory/factoryStockJournal";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";

const PREFIX = "pifact";
const today = new Date().toISOString().slice(0, 10);

let companyId: number;
let customerId: number;
let orderId: number;
let containerId: number;
const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("perpetual-factory-test", work);

type Q = (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
async function maintenance(work: (q: Q) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await work((text, values) => client.query(text, values) as never);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function journal(voucherNumber: string) {
  const { rows } = await asMaintenance(() =>
    pool.query(
      `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c, ve.customer_id
         FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = $1 AND v.voucher_number = $2 ORDER BY ve.id`,
      [companyId, voucherNumber]
    )
  );
  return rows.map((row) => [row.code, row.d, row.c, row.customer_id]);
}

beforeAll(async () => {
  await maintenance(async (q) => {
    companyId = (
      await q(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [PREFIX.toUpperCase()])
    ).rows[0].id;
    const location = (
      await q(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2::varchar, $2::text) RETURNING id`, [
        companyId,
        `${PREFIX}-LOC`,
      ])
    ).rows[0].id;
    customerId = (
      await q(`INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`, [
        companyId,
        `${PREFIX}-CUST`,
      ])
    ).rows[0].id;
    const account = async (code: string, type: string) =>
      (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
           VALUES ($1, $2::varchar, $2::text, $3, 0, 'Dr') RETURNING id`,
          [companyId, code, type]
        )
      ).rows[0].id;
    const freightIncome = await account(`${PREFIX}_FREIGHT_INCOME`, "Income");
    const importCost = await account("FACTORY_IMPORT_COST", "Direct Expense");
    const supplier = await account(`${PREFIX}_SUPPLIER`, "Liability");
    const voucher = async (number: string, lines: Array<[number, string, string, number | null]>) => {
      const id = (
        await q(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', $3, $4) RETURNING id`,
          [companyId, number, today, lines.reduce((sum, [, d]) => sum + Number(d), 0)]
        )
      ).rows[0].id;
      for (const [ledger, d, c, customer] of lines) {
        await q(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, customer_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, ledger, d, c, customer]
        );
      }
      return id;
    };

    // Two bales sold on the invoice, costing 40 + 60.
    const bale = async (code: string, cost: string) =>
      (
        await q(
          `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, cost_per_kg, total_cost, status)
           VALUES ($1, $2, $2, 50, 0, $3, 'SOLD') RETURNING id`,
          [companyId, `${PREFIX}-${code}`, cost]
        )
      ).rows[0].id;
    const bales = [await bale("B1", "40"), await bale("B2", "60")];

    // Invoice INV-900001: 450 of bales + a 50 freight charge that has its own CHARGE- voucher.
    orderId = (
      await q(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, subtotal_bales,
                                      freight_amount, grand_total, finalized_at)
         VALUES ($1, $2, $3, 'FINALIZED', 'INV-900001', 450, 50, 500, now()) RETURNING id`,
        [companyId, customerId, today]
      )
    ).rows[0].id;
    for (const [index, baleId] of bales.entries()) {
      await q(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
         VALUES ($1, $2, $3, $4, 50, 225)`,
        [orderId, baleId, `${PREFIX}-R${index}`, location]
      );
    }
    // The charge's own CHARGE- voucher (Dr the customer side / Cr freight income).
    const chargeDebit = await account(`${PREFIX}_CHARGE_DR`, "Asset");
    const chargeVoucher = await voucher(`CHARGE-INV-900001-1-1`, [
      [chargeDebit, "50", "0", null],
      [freightIncome, "0", "50", null],
    ]);
    await q(
      `INSERT INTO customer_order_charges (order_id, name, amount, charge_type, voucher_id) VALUES ($1, 'Freight', 50, 'FREIGHT', $2)`,
      [orderId, chargeVoucher]
    );

    // Raw material: 600 kg left at 0.85 = 510.00, all received today; the container's
    // import voucher expensed 1,000.
    containerId = (
      await q(`INSERT INTO factory_containers (company_id, container_number) VALUES ($1, $2) RETURNING id`, [
        companyId,
        `${PREFIX}-C1`,
      ])
    ).rows[0].id;
    await q(
      `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
       VALUES ($1, $2, 1000, 400, 0.85, 0.85)`,
      [companyId, containerId]
    );
    await q(
      `INSERT INTO factory_container_receipts (company_id, container_id, receipt_date, received_kg, cumulative_received_kg, receipt_value_usd)
       VALUES ($1, $2, $3, 600, 600, 510)`,
      [companyId, containerId, today]
    );
    await voucher(`FACTORY-IMPORT-${containerId}-1`, [
      [importCost, "1000", "0", null],
      [supplier, "0", "1000", null],
    ]);

    await q(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, $2, '{}'::jsonb, 'test')`,
      [companyId, today]
    );
  });
}, 60000);

afterAll(async () => {
  await maintenance(async (q) => {
    await q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await q(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [companyId]);
    await q(
      `DELETE FROM customer_order_charges WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
      [companyId]
    );
    await q(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
      companyId,
    ]);
    await q(`DELETE FROM vouchers WHERE company_id = $1`, [companyId]);
    await q(
      `DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = $1)`,
      [companyId]
    );
    await q(`DELETE FROM customer_orders WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM customer_dispatch_batches WHERE company_id = $1`, [companyId]);
    await q(`UPDATE customers SET ledger_account_id = NULL WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM customers WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM ledger_accounts WHERE company_id = $1`, [companyId]);
    for (const table of [
      "factory_container_receipts",
      "factory_raw_stock",
      "factory_bales",
      "factory_containers",
      "locations",
    ]) {
      await q(`DELETE FROM ${table} WHERE company_id = $1`, [companyId]);
    }
    await deleteAuditLogRowsForTests(pool, "company_id = $1", [companyId]);
    await q(`DELETE FROM companies WHERE id = $1`, [companyId]);
  });
}, 60000);

describe("factory invoices in the ledger", () => {
  it("posts the receivable less vouchered charges, the revenue and the cost of the bales", async () => {
    expect(
      await asMaintenance(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, orderId)))
    ).not.toBeNull();
    const [customer] = (
      await asMaintenance(() => pool.query(`SELECT ledger_account_id FROM customers WHERE id = $1`, [customerId]))
    ).rows;
    expect(customer.ledger_account_id).not.toBeNull();
    expect(await journal(`INV-GL-${companyId}-${orderId}`)).toEqual([
      [`CUST-${customerId}`, "450.00", "0.00", customerId],
      ["FACTORY_BALE_SALES_INCOME", "0.00", "450.00", null],
      ["COGS", "100.00", "0.00", null],
      ["FACTORY_FINISHED_GOODS", "0.00", "100.00", null],
    ]);

    // Wave 10: the customer's statement is its ledger lines on the balance
    // engine (the factory composite that rebuilt the invoice from grand_total
    // and skipped this journal is retired). The journal carries the 450
    // receivable; the invoice is in the ledger, so nothing is listed as not
    // yet in the ledger. (This fixture's 50 charge voucher debits another
    // account, not the customer.)
    const window = { companyId, customerId };
    const entries = await asMaintenance(() => loadCustomerLedgerLines(db, window));
    const debits = entries.reduce((sum, entry) => sum + Number(entry.debitAmount ?? 0), 0);
    expect(debits).toBeCloseTo(450, 2);
    const memo = await asMaintenance(() => loadCustomerNotInLedger(db, window));
    expect(memo.rows).toEqual([]);

    // A second sync replaces it; un-finalizing removes it.
    await asMaintenance(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, orderId)));
    expect(await journal(`INV-GL-${companyId}-${orderId}`)).toHaveLength(4);
    await asMaintenance(() => pool.query(`UPDATE customer_orders SET status = 'VERIFIED' WHERE id = $1`, [orderId]));
    await asMaintenance(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, orderId)));
    expect(await journal(`INV-GL-${companyId}-${orderId}`)).toEqual([]);
    await asMaintenance(() => pool.query(`UPDATE customer_orders SET status = 'FINALIZED' WHERE id = $1`, [orderId]));
    await asMaintenance(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, orderId)));
  }, 60000);

  it("refuses an invoice in another currency with no confirmed rate and lists it", async () => {
    const otherOrder = await asMaintenance(async () => {
      const batch = (
        await pool.query(
          `INSERT INTO customer_dispatch_batches (company_id, customer_id, batch_number, batch_date, currency)
           VALUES ($1, $2, $3, $4, 'EUR') RETURNING id`,
          [companyId, customerId, `${PREFIX}-DB1`, today]
        )
      ).rows[0].id;
      return (
        await pool.query(
          `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total,
                                        finalized_at, dispatch_batch_id)
           VALUES ($1, $2, $3, 'FINALIZED', 'INV-900002', 300, now(), $4) RETURNING id`,
          [companyId, customerId, today, batch]
        )
      ).rows[0].id;
    });
    // Wave 17 B (decision 3): no EUR rate on or before the invoice date, so it is refused (409).
    await expect(
      asMaintenance(() => db.transaction((tx) => syncFactoryInvoiceTx(tx, companyId, otherOrder)))
    ).rejects.toMatchObject({ statusCode: 409, code: "FACTORY_INVOICE_RATE_UNCONFIRMED" });
    const unposted = await asMaintenance(() => listUnpostedFactoryInvoices(db, companyId));
    expect(unposted.map((row) => [row.invoiceNumber, row.currency, row.grandTotal])).toEqual([
      ["INV-900002", "EUR", "300.00"],
    ]);
  }, 60000);
});

describe("the daily factory stock journal", () => {
  it("moves the stock accounts to the costing value, capitalises receipts and closes to variance", async () => {
    const result = await asMaintenance(() => db.transaction((tx) => syncFactoryStockJournalTx(tx, companyId, today)));
    expect(result.received).toBe("510.00");
    // Raw +510; finished goods back from -100 (the invoice) to the 0 still held.
    expect(result.accounts.map((row) => [row.accountCode, row.target, row.ledgerBalance, row.amount])).toEqual([
      ["FACTORY_RAW_MATERIAL_STOCK", "510.00", "0.00", "510.00"],
      ["FACTORY_WIP", "0.00", "0.00", "0.00"],
      ["FACTORY_FINISHED_GOODS", "0.00", "-100.00", "100.00"],
    ]);
    expect(result.variance).toBe("-100.00");
    const number = `GL-FACTORY-STOCK-${companyId}-${today}`;
    expect(await journal(number)).toEqual([
      ["FACTORY_RAW_MATERIAL_STOCK", "510.00", "0.00", null],
      ["FACTORY_FINISHED_GOODS", "100.00", "0.00", null],
      ["FACTORY_IMPORT_COST", "0.00", "510.00", null],
      ["PRODUCTION_VARIANCE", "0.00", "100.00", null],
    ]);

    // Run again the same day: replaced, not added to.
    await asMaintenance(() => db.transaction((tx) => syncFactoryStockJournalTx(tx, companyId, today)));
    expect(await journal(number)).toHaveLength(4);
  }, 60000);
});
