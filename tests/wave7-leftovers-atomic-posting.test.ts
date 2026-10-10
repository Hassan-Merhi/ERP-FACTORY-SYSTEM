/**
 * Wave 7 leftovers (2026-10-09): atomic posting for the remaining writers.
 *
 *   1. PO charge and line-item edits — PO rows, voucher, lines, container
 *      totals/charges and the audit row in one transaction; a refused voucher
 *      write (closed period) leaves the PO as it was.
 *   2. Factory container create — the container, its daybook row and its
 *      FACTORY-IMPORT / FACTORY-FREIGHT / FACTORY-COMM journals together.
 *   3. Factory payroll PATCH to PAID — posts Dr Payroll Payable / Cr the chosen
 *      account (required), once; un-marking removes it.
 *   4. Factory payroll generation — posts the PAYROLL-GEN accrual; deleting a
 *      payroll rebuilds it.
 *   5. Advance delete — refused while a repayment exists; otherwise the advance
 *      and its voucher go together, audited. A repayment delete takes its
 *      receipt voucher with it.
 *   And the diagnostic lists the pre-wave rows (not back-filled).
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w7left";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let erpSupplierId: number;
let factorySupplierId: number;
let brokerId: number;
let expenseAccountId: number;
let payableFixtureAccountId: number;
let advancesAccountId: number;
let workerId: number;
let seq = 0;

const next = (label: string) => {
  seq += 1;
  return `${TEST_PREFIX}-${label}-${seq}`;
};

async function account(name: string, type: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance)
     VALUES ($1, $2, $3, $4, '0') RETURNING id`,
    [ctx.companyId, next("ACC").slice(0, 40), `${TEST_PREFIX} ${name}`, type]
  );
  return result.rows[0].id;
}

/** A voucher and its lines, written together (the balance guard checks at COMMIT). */
async function fixtureVoucher(
  number: string,
  type: string,
  date: string,
  lines: Array<{ accountId: number; debit: string; credit: string }>
): Promise<number> {
  return withFixtureTransaction(async (client) => {
    const total = lines.reduce((sum, line) => sum + Number(line.debit), 0).toFixed(2);
    const voucher = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, $3, $4, $5, 'USD') RETURNING id`,
      [ctx.companyId, number, type, date, total]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
         VALUES ($1, $2, $3, $4, 'fixture')`,
        [voucher.rows[0].id, line.accountId, line.debit, line.credit]
      );
    }
    return voucher.rows[0].id;
  });
}

// Live vouchers only: wave 16 (A) retires a removed voucher (soft delete, lines kept).
async function voucherSides(where: string, params: unknown[]) {
  const result = await pool.query<{ id: number; voucher_number: string; debit: string; credit: string; total: string }>(
    `SELECT v.id, v.voucher_number, v.total_amount::text AS total,
            COALESCE(SUM(ve.debit_amount), 0)::numeric(20,2)::text AS debit,
            COALESCE(SUM(ve.credit_amount), 0)::numeric(20,2)::text AS credit
       FROM vouchers v LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL AND ${where}
      GROUP BY v.id ORDER BY v.id`,
    [ctx.companyId, ...params]
  );
  return result.rows;
}

async function auditRows(tableName: string, recordId: number) {
  const result = await pool.query(`SELECT action, changes FROM audit_log WHERE table_name = $1 AND record_id = $2`, [
    tableName,
    recordId,
  ]);
  return result.rows;
}

/** Closes the books through `end` for the duration of `work`. */
async function withClosedPeriod<T>(end: string, work: () => Promise<T>): Promise<T> {
  const closingVoucherId = await fixtureVoucher(next("CLOSE"), "Journal", end, []);
  await pool.query(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, '2025-01-01', $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [ctx.companyId, end, ctx.userId, closingVoucherId, ctx.cashAccountId]
  );
  try {
    return await work();
  } finally {
    await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  erpSupplierId = (
    await pool.query<{ id: number }>(
      `INSERT INTO suppliers (code, legal_name, email, active) VALUES ($1, $2, $3, true) RETURNING id`,
      [next("SUP"), `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.test`]
    )
  ).rows[0].id;
  factorySupplierId = (
    await pool.query<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX} Factory Supplier`]
    )
  ).rows[0].id;
  brokerId = (
    await pool.query<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX} Broker`]
    )
  ).rows[0].id;
  expenseAccountId = await account("Purchases", "Expense");
  payableFixtureAccountId = await account("Supplier payable", "Liability");
  advancesAccountId = await account("Worker advances", "Asset");
  workerId = (
    await pool.query<{ id: number }>(
      `INSERT INTO factory_workers (company_id, full_name, salary_type, base_salary, active)
       VALUES ($1, $2, 'Daily', '10.00', true) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX} Worker`]
    )
  ).rows[0].id;
}, 120000);

afterAll(async () => {
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM factory_advance_repayments WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_worker_advances WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_payrolls WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_workers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  await pool.query(`DELETE FROM suppliers WHERE id = $1`, [erpSupplierId]);
  closeTestServer();
}, 120000);

// ── 1. Purchase orders ────────────────────────────────────────────────────────

async function poWithVoucher(date: string) {
  const container = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date, items_total, charges_total, grand_total)
     VALUES ($1, $2, $3, 'OTW', $4, '100', '10', '110') RETURNING id`,
    [ctx.companyId, next("CNT"), erpSupplierId, date]
  );
  const voucherId = await fixtureVoucher(next("PURCH"), "Purchase", date, [
    { accountId: expenseAccountId, debit: "110.00", credit: "0" },
    { accountId: payableFixtureAccountId, debit: "0", credit: "110.00" },
  ]);
  const po = await pool.query<{ id: number }>(
    `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, currency, items_total,
       freight, surcharge, fumigation, document_charges, discount, other_charges, status, voucher_id)
     VALUES ($1, $2, $3, $4, 'USD', '100', '10', '0', '0', '0', '0', '0', 'Open', $5) RETURNING id`,
    [ctx.companyId, next("PO"), container.rows[0].id, erpSupplierId, voucherId]
  );
  await pool.query(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'item', '10', '10', '100')`,
    [po.rows[0].id, ctx.stockItemIds[0]]
  );
  return { poId: po.rows[0].id, containerId: container.rows[0].id, voucherId };
}

describe("1. PO charge and line-item edits are one transaction", () => {
  it("a charge edit moves the PO, its voucher (balanced), the container and the audit row together", async () => {
    const { poId, containerId, voucherId } = await poWithVoucher("2026-06-01");
    const response = await agent.patch(`/api/purchase-orders/${poId}`).send({ freight: "25.005" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const po = (await pool.query(`SELECT freight::text FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
    expect(po.freight).toBe("25.01");
    const [voucher] = await voucherSides("v.id = $2", [voucherId]);
    expect(voucher.total).toBe("125.01");
    expect(voucher.debit).toBe("125.01");
    expect(voucher.credit).toBe("125.01");
    const container = (await pool.query(`SELECT grand_total::text FROM containers WHERE id = $1`, [containerId]))
      .rows[0];
    expect(container.grand_total).toBe("125.01");
    const charge = (
      await pool.query(
        `SELECT amount::text FROM container_charges WHERE container_id = $1 AND charge_type = 'Freight'`,
        [containerId]
      )
    ).rows[0];
    expect(charge.amount).toBe("25.01");
    expect(await auditRows("purchase_orders", poId)).toHaveLength(1);
  });

  it("a charge edit refused by the closed period leaves the PO, the container and its charges untouched", async () => {
    const { poId, containerId, voucherId } = await poWithVoucher("2025-12-15");
    await withClosedPeriod("2025-12-31", async () => {
      const response = await agent.patch(`/api/purchase-orders/${poId}`).send({ freight: "40" });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    const po = (await pool.query(`SELECT freight::text, charges_edited FROM purchase_orders WHERE id = $1`, [poId]))
      .rows[0];
    expect(po.freight).toBe("10.00");
    expect(po.charges_edited).not.toBe(true);
    const [voucher] = await voucherSides("v.id = $2", [voucherId]);
    expect(voucher.total).toBe("110.00");
    const charges = await pool.query(`SELECT 1 FROM container_charges WHERE container_id = $1`, [containerId]);
    expect(charges.rowCount).toBe(0);
    expect(await auditRows("purchase_orders", poId)).toHaveLength(0);
  });

  it("a line-item edit commits its audit row with it, and rolls back whole in a closed period", async () => {
    const open = await poWithVoucher("2026-06-02");
    const ok = await agent
      .patch(`/api/purchase-orders/${open.poId}`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "item", quantity: "12", rate: "10" }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await auditRows("purchase_orders", open.poId)).toHaveLength(1);
    const [openVoucher] = await voucherSides("v.id = $2", [open.voucherId]);
    expect(openVoucher.debit).toBe(openVoucher.credit);
    expect(openVoucher.total).toBe("130.00");

    const closed = await poWithVoucher("2025-12-16");
    await withClosedPeriod("2025-12-31", async () => {
      const refused = await agent
        .patch(`/api/purchase-orders/${closed.poId}`)
        .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "item", quantity: "20", rate: "10" }] });
      expect(refused.status).toBeGreaterThanOrEqual(400);
    });
    const items = (await pool.query(`SELECT quantity::text FROM po_line_items WHERE po_id = $1`, [closed.poId])).rows;
    expect(items.map((row) => Number(row.quantity))).toEqual([10]);
    const po = (await pool.query(`SELECT items_total::text FROM purchase_orders WHERE id = $1`, [closed.poId])).rows[0];
    expect(po.items_total).toBe("100.00");
    expect(await auditRows("purchase_orders", closed.poId)).toHaveLength(0);
  });

  it("a purchase-voucher item edit moves the goods lines by the difference and keeps the voucher balanced", async () => {
    const { poId, voucherId } = await poWithVoucher("2026-06-03");
    const response = await agent.patch(`/api/vouchers/${voucherId}/purchase`).send({
      items: [{ stockItemId: ctx.stockItemIds[0], itemName: "item", quantity: "3", rate: "40.005" }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [voucher] = await voucherSides("v.id = $2", [voucherId]);
    // Items 120.015 → 120.02 (was 100); the freight of 10 stays on the voucher.
    expect(voucher.debit).toBe("130.02");
    expect(voucher.credit).toBe("130.02");
    expect(voucher.total).toBe("130.02");
    const po = (await pool.query(`SELECT items_total::text FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
    expect(po.items_total).toBe("120.02");
    expect(await auditRows("vouchers", voucherId)).toHaveLength(1);
  });
});

// ── 2. Factory container create ──────────────────────────────────────────────

describe("2. Factory container create is atomic", () => {
  it("commits the container with balanced goods, freight and commission journals", async () => {
    const response = await agent.post("/api/factory/containers").send({
      containerNumber: next("FC"),
      supplierId: factorySupplierId,
      currencyCode: "USD",
      totalKg: "1000",
      ratePerKg: "0.50",
      arrivalDate: "2026-06-10",
      freight: "120",
      freightPaidBy: "supplier",
      commissionAmount: "30",
      commissionCurrencyCode: "USD",
      commissionSupplierId: brokerId,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const id = response.body.id as number;
    const vouchers = await voucherSides(
      `(v.voucher_number LIKE $2 OR v.voucher_number = $3 OR v.voucher_number = $4)`,
      [`FACTORY-IMPORT-${id}-%`, `FACTORY-FREIGHT-${id}`, `FACTORY-COMM-${id}`]
    );
    expect(vouchers).toHaveLength(3);
    for (const voucher of vouchers) expect(voucher.debit).toBe(voucher.credit);
    expect(vouchers.map((v) => v.debit).sort()).toEqual(["120.00", "30.00", "500.00"]);
  });

  it("rolls the container, its daybook row and its journals back when a journal cannot be posted", async () => {
    const containerNumber = next("FCX");
    const response = await agent.post("/api/factory/containers").send({
      containerNumber,
      supplierId: factorySupplierId,
      currencyCode: "USD",
      totalKg: "1000",
      ratePerKg: "0.50",
      arrivalDate: "2026-06-11",
      freight: "120",
      // A payer the freight journal has no credit leg for: refused, not posted one-sided.
      freightPaidBy: "parent",
      commissionAmount: "30",
      commissionCurrencyCode: "USD",
      commissionSupplierId: brokerId,
    });
    expect(response.status).toBe(400);
    const container = await pool.query(`SELECT id FROM factory_containers WHERE container_number = $1`, [
      containerNumber,
    ]);
    expect(container.rowCount).toBe(0);
    const orphans = await pool.query(`SELECT v.id FROM vouchers v WHERE v.company_id = $1 AND v.description LIKE $2`, [
      ctx.companyId,
      `%${containerNumber}%`,
    ]);
    expect(orphans.rowCount).toBe(0);
    const daybook = await pool.query(
      `SELECT id FROM factory_daybook_entries WHERE company_id = $1 AND description LIKE $2`,
      [ctx.companyId, `%${containerNumber}%`]
    );
    expect(daybook.rowCount).toBe(0);
  });
});

// ── 3. Factory payroll PATCH to PAID ─────────────────────────────────────────

async function payroll(net: string, status = "APPROVED", period = ["2026-05-01", "2026-05-31"]) {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, net_salary, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [ctx.companyId, workerId, period[0], period[1], net, status]
  );
  return result.rows[0].id;
}

const paymentVouchers = (payrollId: number) => voucherSides("v.voucher_number LIKE $2", [`PAYMENT-PAY-${payrollId}-%`]);

describe("3. Marking a factory payroll PAID posts its payment voucher", () => {
  it("refuses without a paying account and leaves the payroll unpaid", async () => {
    const id = await payroll("250.00");
    const response = await agent.patch(`/api/factory/payroll/${id}`).send({ status: "PAID" });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/cash or bank account/);
    const row = (await pool.query(`SELECT status FROM factory_payrolls WHERE id = $1`, [id])).rows[0];
    expect(row.status).toBe("APPROVED");
    expect(await paymentVouchers(id)).toHaveLength(0);
  });

  it("refuses an account of another company", async () => {
    const id = await payroll("250.00");
    const foreign = await pool.query<{ id: number }>(
      `SELECT id FROM ledger_accounts WHERE company_id <> $1 AND deleted_at IS NULL LIMIT 1`,
      [ctx.companyId]
    );
    if (!foreign.rows[0]) return;
    const response = await agent
      .patch(`/api/factory/payroll/${id}`)
      .send({ status: "PAID", cashAccountId: foreign.rows[0].id });
    expect(response.status).toBe(400);
    expect(await paymentVouchers(id)).toHaveLength(0);
  });

  it("posts Dr Payroll Payable / Cr the chosen account once, and un-marking removes it", async () => {
    const id = await payroll("250.50");
    const paid = await agent
      .patch(`/api/factory/payroll/${id}`)
      .send({ status: "PAID", cashAccountId: ctx.cashAccountId, paymentDate: "2026-06-05" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);

    const [voucher] = await paymentVouchers(id);
    expect(voucher.voucher_number).toBe(`PAYMENT-PAY-${id}-PAID`);
    expect(voucher.debit).toBe("250.50");
    expect(voucher.credit).toBe("250.50");
    const legs = (
      await pool.query(
        `SELECT la.name, ve.ledger_account_id, ve.debit_amount::text AS debit, ve.credit_amount::text AS credit
           FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          WHERE ve.voucher_id = $1 ORDER BY ve.id`,
        [voucher.id]
      )
    ).rows;
    expect(legs[0].name).toBe("Payroll Payable");
    expect(Number(legs[0].debit)).toBe(250.5);
    expect(legs[1].ledger_account_id).toBe(ctx.cashAccountId);
    expect(Number(legs[1].credit)).toBe(250.5);
    const row = (await pool.query(`SELECT status, cash_account_id FROM factory_payrolls WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "PAID", cash_account_id: ctx.cashAccountId });
    expect(await auditRows("factory_payrolls", id)).toHaveLength(1);

    // Saying PAID again posts nothing more.
    const again = await agent
      .patch(`/api/factory/payroll/${id}`)
      .send({ status: "PAID", cashAccountId: ctx.cashAccountId, paymentDate: "2026-06-05" });
    expect(again.status).toBe(200);
    expect(await paymentVouchers(id)).toHaveLength(1);

    // An amount change on a paid payroll is refused.
    const edit = await agent.patch(`/api/factory/payroll/${id}`).send({ deductions: "5" });
    expect(edit.status).toBe(409);

    const unmark = await agent.patch(`/api/factory/payroll/${id}`).send({ status: "APPROVED" });
    expect(unmark.status, JSON.stringify(unmark.body)).toBe(200);
    expect(await paymentVouchers(id)).toHaveLength(0);
    const after = (await pool.query(`SELECT status, cash_account_id FROM factory_payrolls WHERE id = $1`, [id]))
      .rows[0];
    expect(after).toMatchObject({ status: "APPROVED", cash_account_id: null });
  });

  it("rolls the status back when the payment voucher falls in a closed period", async () => {
    const id = await payroll("80.00");
    await withClosedPeriod("2025-12-31", async () => {
      const response = await agent
        .patch(`/api/factory/payroll/${id}`)
        .send({ status: "PAID", cashAccountId: ctx.cashAccountId, paymentDate: "2025-12-20" });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    const row = (await pool.query(`SELECT status, paid_at FROM factory_payrolls WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "APPROVED", paid_at: null });
    expect(await paymentVouchers(id)).toHaveLength(0);
    const daybook = await pool.query(
      `SELECT 1 FROM factory_daybook_entries WHERE reference_table = 'factory_payrolls' AND reference_id = $1`,
      [id]
    );
    expect(daybook.rowCount).toBe(0);
  });
});

// ── 4. Factory payroll generation posts the accrual ──────────────────────────

const accrual = (start: string, end: string) =>
  voucherSides(`v.voucher_number LIKE 'PAYROLL-GEN-%' AND v.voucher_date = $2 AND v.description LIKE $3`, [
    start,
    `%${end}%`,
  ]);

describe("4. Factory payroll generation posts Dr salary expense / Cr Payroll Payable", () => {
  it("posts the period accrual with the payrolls and rebuilds it when one is deleted", async () => {
    const second = await pool.query<{ id: number }>(
      `INSERT INTO factory_workers (company_id, full_name, salary_type, base_salary, active)
       VALUES ($1, $2, 'Daily', '12.50', true) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX} Worker Two`]
    );
    const response = await agent
      .post("/api/factory/payroll/generate")
      .send({ companyId: ctx.companyId, startDate: "2026-07-01", endDate: "2026-07-03" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const payrolls = (
      await pool.query<{ id: number; net_salary: string; worker_id: number }>(
        `SELECT id, net_salary::text, worker_id FROM factory_payrolls
          WHERE company_id = $1 AND period_start = '2026-07-01' AND period_end = '2026-07-03'`,
        [ctx.companyId]
      )
    ).rows;
    expect(payrolls.length).toBeGreaterThanOrEqual(2);
    const totalNet = payrolls.reduce((sum, row) => sum + Number(row.net_salary), 0);

    const [voucher] = await accrual("2026-07-01", "2026-07-03");
    expect(voucher.debit).toBe(voucher.credit);
    expect(Number(voucher.credit)).toBeCloseTo(totalNet, 2);

    // Generating again posts no second accrual.
    await agent
      .post("/api/factory/payroll/generate")
      .send({ companyId: ctx.companyId, startDate: "2026-07-01", endDate: "2026-07-03" });
    expect(await accrual("2026-07-01", "2026-07-03")).toHaveLength(1);

    const removed = payrolls.find((row) => row.worker_id === second.rows[0].id)!;
    const del = await agent.delete(`/api/factory/payroll/${removed.id}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const [rebuilt] = await accrual("2026-07-01", "2026-07-03");
    expect(rebuilt.debit).toBe(rebuilt.credit);
    expect(Number(rebuilt.credit)).toBeCloseTo(totalNet - Number(removed.net_salary), 2);
    expect(await auditRows("factory_payrolls", removed.id)).toHaveLength(1);
  });
});

// ── 5. Advance delete ────────────────────────────────────────────────────────

async function advanceWithVoucher(amount: string) {
  const advance = await pool.query<{ id: number }>(
    `INSERT INTO factory_worker_advances (company_id, worker_id, advance_date, amount, remaining_balance, cash_account_id)
     VALUES ($1, $2, '2026-06-01', $3, $3, $4) RETURNING id`,
    [ctx.companyId, workerId, amount, ctx.cashAccountId]
  );
  const id = advance.rows[0].id;
  await fixtureVoucher(`PAYMENT-ADV-${id}-1`, "Payment", "2026-06-01", [
    { accountId: advancesAccountId, debit: amount, credit: "0" },
    { accountId: ctx.cashAccountId, debit: "0", credit: amount },
  ]);
  return id;
}

async function repayment(advanceId: number, amount: string) {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_advance_repayments (company_id, advance_id, worker_id, repayment_date, amount, cash_account_id)
     VALUES ($1, $2, $3, '2026-06-10', $4, $5) RETURNING id`,
    [ctx.companyId, advanceId, workerId, amount, ctx.cashAccountId]
  );
  const id = result.rows[0].id;
  await fixtureVoucher(`RECEIPT-REPAY-${id}-1`, "Receipt", "2026-06-10", [
    { accountId: ctx.cashAccountId, debit: amount, credit: "0" },
    { accountId: advancesAccountId, debit: "0", credit: amount },
  ]);
  await pool.query(`UPDATE factory_worker_advances SET remaining_balance = remaining_balance - $2 WHERE id = $1`, [
    advanceId,
    amount,
  ]);
  return id;
}

describe("5. Advance delete", () => {
  it("refuses an advance with a live repayment (409) and leaves it, its voucher and the repayment", async () => {
    const advanceId = await advanceWithVoucher("100.00");
    const repaymentId = await repayment(advanceId, "40.00");
    const response = await agent.delete(`/api/factory/advances/${advanceId}`);
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/Reverse the repayments first/);
    expect((await pool.query(`SELECT 1 FROM factory_worker_advances WHERE id = $1`, [advanceId])).rowCount).toBe(1);
    expect((await voucherSides("v.voucher_number = $2", [`PAYMENT-ADV-${advanceId}-1`])).length).toBe(1);
    expect((await voucherSides("v.voucher_number = $2", [`RECEIPT-REPAY-${repaymentId}-1`])).length).toBe(1);

    // Reversing the repayment takes its receipt voucher with it, audited; then the advance deletes.
    const reverse = await agent.delete(`/api/factory/advance-repayments/${repaymentId}`);
    expect(reverse.status, JSON.stringify(reverse.body)).toBe(200);
    expect(await voucherSides("v.voucher_number = $2", [`RECEIPT-REPAY-${repaymentId}-1`])).toHaveLength(0);
    expect(await auditRows("factory_advance_repayments", repaymentId)).toHaveLength(1);

    const del = await agent.delete(`/api/factory/advances/${advanceId}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
  });

  it("deletes an advance with no repayment together with its voucher, audited", async () => {
    const advanceId = await advanceWithVoucher("60.00");
    const response = await agent.delete(`/api/factory/advances/${advanceId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await pool.query(`SELECT 1 FROM factory_worker_advances WHERE id = $1`, [advanceId])).rowCount).toBe(0);
    expect(await voucherSides("v.voucher_number LIKE $2", [`PAYMENT-ADV-${advanceId}-%`])).toHaveLength(0);
    expect(await auditRows("factory_worker_advances", advanceId)).toHaveLength(1);
  });

  it("keeps the advance and its voucher when the voucher is in a closed period", async () => {
    const advance = await pool.query<{ id: number }>(
      `INSERT INTO factory_worker_advances (company_id, worker_id, advance_date, amount, remaining_balance)
       VALUES ($1, $2, '2025-12-01', '70.00', '70.00') RETURNING id`,
      [ctx.companyId, workerId]
    );
    const advanceId = advance.rows[0].id;
    await fixtureVoucher(`PAYMENT-ADV-${advanceId}-1`, "Payment", "2025-12-01", [
      { accountId: advancesAccountId, debit: "70.00", credit: "0" },
      { accountId: ctx.cashAccountId, debit: "0", credit: "70.00" },
    ]);
    await withClosedPeriod("2025-12-31", async () => {
      const response = await agent.delete(`/api/factory/advances/${advanceId}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    expect((await pool.query(`SELECT 1 FROM factory_worker_advances WHERE id = $1`, [advanceId])).rowCount).toBe(1);
    expect(await auditRows("factory_worker_advances", advanceId)).toHaveLength(0);
  });
});

// ── Pre-wave rows: listed, not back-filled ────────────────────────────────────

describe("integrity diagnostic lists the pre-wave rows", () => {
  it("lists a PAID payroll with no payment voucher, a period with no accrual and an orphaned repayment voucher", async () => {
    const legacyPaid = await payroll("45.00", "PAID", ["2026-03-01", "2026-03-31"]);
    const orphan = await fixtureVoucher("RECEIPT-REPAY-2147480000-1", "Receipt", "2026-03-15", [
      { accountId: ctx.cashAccountId, debit: "5.00", credit: "0" },
      { accountId: advancesAccountId, debit: "0", credit: "5.00" },
    ]);
    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const byKey = (key: string) => report.checks.find((c) => c.key === key)!;

    const paid = byKey("factory_payroll_paid_without_payment_voucher");
    expect(paid.status).toBe("warn");
    expect(paid.samples.map((s) => s.id)).toContain(legacyPaid);
    const accrualCheck = byKey("factory_payroll_period_without_accrual");
    expect(accrualCheck.samples.some((s) => s.period_start === "2026-03-01")).toBe(true);
    const orphaned = byKey("factory_advance_repayment_voucher_orphaned");
    expect(orphaned.samples.map((s) => s.id)).toContain(orphan);

    // Nothing was posted for them.
    expect(await paymentVouchers(legacyPaid)).toHaveLength(0);
  }, 60000);
});
