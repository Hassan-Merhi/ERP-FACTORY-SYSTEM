/**
 * Phase 25 — receivables and payables as open items.
 *
 *   1. the FIFO plan (pure): credits settle invoices by due date, the opening
 *      first; a changed source releases the automatic rows before the manual ones;
 *   2. AR-4 aging by due date on the allocation table: projected FIFO before
 *      the run, the run writes the rows (audited, the allocation event in the
 *      transaction), a second run writes nothing, manual re-allocation
 *      (Admin/Owner, reason, audited, refused beyond what is open), a deleted
 *      invoice releases its rows; unapplied credits listed; the control tie-out;
 *   3. the overdue check: an old paid invoice no longer marks a customer overdue;
 *   4. AR-1/AR-11: employee balances from the engine, employee aging, the cache diagnostic;
 *   5. AR-2: bank and employee statements list only the lines the engine gives them;
 *   6. AR-7: a credit note for a customer credits the customer, references the
 *      invoice, restocks at the invoice's original cost, is refused beyond what
 *      was sold and is not edited in place;
 *   7. AR-9: a factory supplier opening carries its side;
 *   8. AR-6: the customer statement endpoint is the ledger, the cache a memo;
 *   9. AR-10: in a supplier-partner company the evidence lines do not move the balance;
 *  10. AR-12/AR-13: the chat aging and the overdue WhatsApp text on the aging service.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { MoneyDecimal } from "../server/lib/money";
import { planFifoAllocations, type OpenItem } from "../server/services/accounting/allocations/fifoPlan";
import {
  registerAllocationListener,
  type AllocationEvent,
} from "../server/services/accounting/allocations/allocationEvents";
import { loadOverdueCustomerBalances } from "../server/services/scheduler/overdueCustomerQuery";
import { getPartyBalance } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { buildUnifiedSupplierLedger } from "../server/routes/vouchers/unifiedSupplierLedger";
import { formatOverdueReminder } from "../server/services/scheduler/net-position";
import { agingChatResult } from "../server/chat/reports/implementations/agingChatTable";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p25oi";

const iso = (date: Date) => date.toISOString().slice(0, 10);
const now = new Date();
const daysAgo = (days: number) =>
  iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)));
const today = daysAgo(0);

let ctx: TestContext;
let agent: request.SuperAgentTest;
const ids: Record<string, number> = {};
let sequence = 0;

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function insertId(text: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(text, params);
  return rows[0].id;
}

interface Line {
  ledger?: number;
  bank?: number;
  customer?: number;
  supplier?: number;
  employee?: number;
  debit?: string;
  credit?: string;
}

/** `legacy`: a line naming two targets predates the line-target guard (history only). */
async function voucher(date: string, lines: Line[], type = "Journal", legacy = false) {
  sequence += 1;
  return withFixtureTransaction(
    async (client) => {
      const created = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
       VALUES ($1, $2, $3, $4, 0, 'USD', false) RETURNING id`,
        [ctx.companyId, `${PREFIX.toUpperCase()}-${sequence}`, type, date]
      );
      for (const line of lines) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, supplier_id,
                                      employee_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            created.rows[0].id,
            line.ledger ?? null,
            line.bank ?? null,
            line.customer ?? null,
            line.supplier ?? null,
            line.employee ?? null,
            line.debit ?? "0",
            line.credit ?? "0",
          ]
        );
      }
      return created.rows[0].id;
    },
    { legacyUnbalanced: legacy }
  );
}

const sale = (customer: number, date: string, amount: string) =>
  voucher(date, [
    { customer, debit: amount },
    { ledger: ctx.salesAccountId, credit: amount },
  ]);
const receipt = (customer: number, date: string, amount: string) =>
  voucher(date, [
    { ledger: ctx.cashAccountId, debit: amount },
    { customer, credit: amount },
  ]);

async function agingRow(kind: string, id: number, asOf = today) {
  const response = await agent.get(`/api/reports/aging?kind=${kind}&asOf=${asOf}`);
  expect(response.status).toBe(200);
  return { report: response.body, row: response.body.parties.find((party: { id: number }) => party.id === id) };
}

async function liveAllocations(customer: number) {
  const { rows } = await pool.query(
    `SELECT id, invoice_voucher_id, payment_voucher_id, amount::text AS amount, method, release_reason
       FROM party_open_item_allocations
      WHERE company_id = $1 AND party_kind = 'customer' AND party_id = $2 AND released_at IS NULL
      ORDER BY id`,
    [ctx.companyId, customer]
  );
  return rows;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  ids.CU = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side, payment_terms_days)
     VALUES ($1, $2, $3, 0, 'Dr', 30) RETURNING id`,
    [ctx.companyId, `${PREFIX}-CU`, `${PREFIX} open items customer`]
  );
  ids.INV1 = await sale(ids.CU, daysAgo(100), "100.00");
  ids.INV2 = await sale(ids.CU, daysAgo(45), "50.00");
  ids.REC = await receipt(ids.CU, daysAgo(10), "120.00");
  ids.INV3 = await sale(ids.CU, daysAgo(5), "20.00");

  // Paid long ago, then a new invoice not yet due (no terms: 30 days).
  ids.CU2 = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-CU2`, `${PREFIX} paid customer`]
  );
  await sale(ids.CU2, daysAgo(200), "200.00");
  await receipt(ids.CU2, daysAgo(150), "200.00");
  await sale(ids.CU2, daysAgo(3), "40.00");

  ids.EMP = await insertId(
    `INSERT INTO employees (company_id, code, first_name, last_name, join_date, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Open', 'Items', '2026-01-01', 0, 'Cr') RETURNING id`,
    [ctx.companyId, `${PREFIX.toUpperCase()}-EMP-${ctx.companyId}`]
  );
  ids.SALEXP = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Expense', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-SAL-${ctx.companyId}`, `${PREFIX} salaries`]
  );
  await voucher(daysAgo(40), [
    { ledger: ids.SALEXP, debit: "80.00" },
    { employee: ids.EMP, credit: "80.00" },
  ]);
  await voucher(daysAgo(5), [
    { employee: ids.EMP, debit: "30.00" },
    { ledger: ctx.cashAccountId, credit: "30.00" },
  ]);
  // A line naming a ledger account and the employee is the ledger's (AR-2).
  await voucher(
    daysAgo(4),
    [
      { ledger: ids.SALEXP, employee: ids.EMP, debit: "7.00" },
      { ledger: ctx.cashAccountId, credit: "7.00" },
    ],
    "Journal"
  );

  ids.BANK = await insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Test bank', '000', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-BK-${ctx.companyId}`, `${PREFIX} bank`]
  );
  await voucher(daysAgo(3), [
    { bank: ids.BANK, debit: "15.00" },
    { ledger: ctx.cashAccountId, credit: "15.00" },
  ]);
  await voucher(
    daysAgo(2),
    [
      { ledger: ids.SALEXP, bank: ids.BANK, debit: "9.00" },
      { ledger: ctx.cashAccountId, credit: "9.00" },
    ],
    "Journal",
    true
  );

  ids.FS = await insertId(
    `INSERT INTO factory_suppliers (company_id, name, opening_balance, opening_balance_side)
     VALUES ($1, $2, 70, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX} factory supplier`]
  );
}, 180_000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("1: the FIFO plan", () => {
  const item = (key: string, amount: string, bookedOn: string | null, dueDate: string | null): OpenItem => ({
    key,
    voucherId: key === "opening" ? null : Number(key),
    voucherNumber: key,
    voucherType: null,
    bookedOn,
    dueDate,
    amount: new MoneyDecimal(amount),
  });

  it("settles the opening, then invoices by due date", () => {
    const plan = planFifoAllocations({
      invoices: [
        item("2", "50", "2026-01-10", "2026-03-01"),
        item("1", "30", "2026-01-20", "2026-02-01"),
        item("opening", "10", null, null),
      ],
      credits: [item("3", "60", "2026-02-15", null)],
      allocations: [],
      releaseMissing: true,
    });
    expect(plan.creates.map((row) => [row.invoiceKey, row.amount.toFixed(2)])).toEqual([
      ["opening", "10.00"],
      ["1", "30.00"],
      ["2", "20.00"],
    ]);
  });

  it("releases rows of a gone item, and the automatic rows before the manual ones", () => {
    const plan = planFifoAllocations({
      invoices: [item("1", "30", "2026-01-01", "2026-01-31")],
      credits: [item("3", "50", "2026-02-01", null)],
      allocations: [
        { id: 1, invoiceKey: "1", paymentKey: "3", amount: new MoneyDecimal(20), method: "manual", sequence: 1 },
        { id: 2, invoiceKey: "1", paymentKey: "3", amount: new MoneyDecimal(20), method: "auto_fifo", sequence: 2 },
        { id: 3, invoiceKey: "9", paymentKey: "3", amount: new MoneyDecimal(5), method: "auto_fifo", sequence: 3 },
      ],
      releaseMissing: true,
    });
    expect(plan.releases.sort()).toEqual([2, 3]);
    expect(plan.creates.map((row) => row.amount.toFixed(2))).toEqual(["10.00"]);
  });
});

describe("2: open items, aging by due date and allocations", () => {
  it("projects the FIFO allocation and ages by days past due", async () => {
    const { report, row } = await agingRow("customer", ids.CU);
    expect(report.amountBasis).toBe("book");
    expect(row.balance).toBe("50.00");
    // REC 120 settles INV1 100 and 20 of INV2: INV2 30 is 15 days past due, INV3 not due.
    expect(row.buckets).toMatchObject({ days1to30: "30.00", notDue: "20.00", over90: "0.00", opening: "0.00" });
    expect(row.pendingAllocations).toBe(2);
    expect(row.openItems.map((open: { voucherId: number; open: string }) => [open.voucherId, open.open])).toEqual([
      [ids.INV2, "30.00"],
      [ids.INV3, "20.00"],
    ]);
    expect(report.controlTieOut.tied).toBe(true);
  });

  it("writes the rows once, audited, with the allocation event in the transaction", async () => {
    const events: AllocationEvent[] = [];
    const remove = registerAllocationListener({
      posted: async (tx, event) => {
        // The row is visible inside the listener's transaction.
        const seen = await tx.execute(`SELECT 1 FROM party_open_item_allocations WHERE id = ${event.allocationId}`);
        expect(seen.rows).toHaveLength(1);
        events.push(event);
      },
    });
    try {
      // Integration review: the first run of a company is the Owner's, with the
      // reviewed preview's hash (it covers every kind and enables the hourly run).
      const asAdmin = await agent.post("/api/open-items/allocate").send({ kind: "customer" });
      expect(asAdmin.status).toBe(403);
      await setRole("Owner");
      const preview = await agent.get("/api/open-items/allocate/preview");
      expect(preview.status).toBe(200);
      expect(preview.body.enabled).toBeNull();
      const first = await agent
        .post("/api/open-items/allocate")
        .send({ confirm: true, planHash: preview.body.planHash });
      await setRole("Admin");
      expect(first.status).toBe(200);
      expect(first.body.enabled).toMatchObject({ enabledOn: expect.any(String) });
      const mine = events.filter((event) => event.partyKind === "customer" && event.partyId === ids.CU);
      expect(mine.map((event) => [event.invoiceVoucherId, event.paymentVoucherId, event.amount])).toEqual([
        [ids.INV1, ids.REC, "100.00"],
        [ids.INV2, ids.REC, "20.00"],
      ]);
      expect(mine[0]).toMatchObject({ companyId: ctx.companyId, currency: "USD", method: "auto_fifo" });
      const second = await agent.post("/api/open-items/allocate").send({ kind: "customer" });
      expect(second.body.results[0]).toMatchObject({ created: 0, released: 0 });
    } finally {
      remove();
    }
    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE company_id = $1 AND table_name = 'party_open_item_allocations'
          AND record_identifier = $2`,
      [ctx.companyId, `customer:${ids.CU}`]
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["recalculate"]);
    expect((await agingRow("customer", ids.CU)).row.pendingAllocations).toBe(0);
  });

  it("re-allocates manually with a reason, within what is open", async () => {
    const rows = await liveAllocations(ids.CU);
    const toInv2 = rows.find((r) => r.invoice_voucher_id === ids.INV2)!;
    const noReason = await agent.post("/api/open-items/reallocate").send({
      kind: "customer",
      partyId: ids.CU,
      release: [toInv2.id],
      allocate: [],
      reason: "",
    });
    expect(noReason.status).toBe(400);

    const moved = await agent.post("/api/open-items/reallocate").send({
      kind: "customer",
      partyId: ids.CU,
      release: [toInv2.id],
      allocate: [{ invoiceVoucherId: ids.INV3, paymentVoucherId: ids.REC, amount: "20.00" }],
      reason: "customer asked to settle the latest invoice",
    });
    expect(moved.status).toBe(200);
    const { row } = await agingRow("customer", ids.CU);
    expect(row.buckets).toMatchObject({ days1to30: "50.00", notDue: "0.00" });
    expect(row.pendingAllocations).toBe(0);

    const beyond = await agent.post("/api/open-items/reallocate").send({
      kind: "customer",
      partyId: ids.CU,
      release: [],
      allocate: [{ invoiceVoucherId: ids.INV2, paymentVoucherId: ids.REC, amount: "0.01" }],
      reason: "nothing left on the receipt",
    });
    expect(beyond.status).toBe(409);
    const audit = await pool.query(
      `SELECT action, reason FROM audit_log
        WHERE company_id = $1 AND table_name = 'party_open_item_allocations' AND action = 'adjust'`,
      [ctx.companyId]
    );
    expect(audit.rows).toEqual([{ action: "adjust", reason: "customer asked to settle the latest invoice" }]);
  });

  it("lists the overdue customers from the open items (an old paid invoice is not overdue)", async () => {
    const overdue = await loadOverdueCustomerBalances();
    const cu = overdue.find((row) => row.id === ids.CU);
    expect(cu).toMatchObject({
      net_balance: "50.00",
      overdue_amount: "50.00",
      due_date: daysAgo(15),
      days_overdue: 15,
    });
    expect(overdue.find((row) => row.id === ids.CU2)).toBeUndefined();
  });

  it("releases the rows of a deleted invoice and lists the unapplied credit", async () => {
    await pool.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [ids.INV1]);
    const before = await agingRow("customer", ids.CU);
    expect(before.row.balance).toBe("-50.00");
    const run = await agent.post("/api/open-items/allocate").send({ kind: "customer" });
    expect(run.status).toBe(200);
    const released = await pool.query(
      `SELECT release_reason FROM party_open_item_allocations WHERE invoice_voucher_id = $1`,
      [ids.INV1]
    );
    expect(released.rows).toEqual([{ release_reason: "source_changed" }]);
    const { row, report } = await agingRow("customer", ids.CU);
    expect(row.buckets).toMatchObject({ unappliedCredit: "-50.00", days1to30: "0.00", notDue: "0.00" });
    expect(row.unappliedCredits).toEqual([expect.objectContaining({ voucherId: ids.REC, unapplied: "50.00" })]);
    expect(report.controlTieOut).toMatchObject({ tied: true });
  });
});

describe("4: employees on the engine", () => {
  it("ages employees, reads balances from the engine and lists the stale cache", async () => {
    const { row, report } = await agingRow("employee", ids.EMP);
    // Owed 80, paid 30 (the 7.00 line names a ledger account: the ledger's).
    expect(row.balance).toBe("50.00");
    expect(row.buckets).toMatchObject({ days1to30: "50.00" });
    expect(report.controlTieOut.tied).toBe(true);

    const list = await agent.get("/api/employees");
    const emp = list.body.find((e: { id: number }) => e.id === ids.EMP);
    expect(emp).toMatchObject({ currentBalance: "50.00", calculatedBalance: "50.00", cachedBalance: "0.00" });
    const one = await agent.get(`/api/employees/${ids.EMP}/balance`);
    expect(one.body).toMatchObject({ balance: "50.00", balanceBasis: "ledger" });

    const diagnostics = await agent.get("/api/open-items/diagnostics");
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body.employeeBalanceCache.employees).toEqual(
      expect.arrayContaining([expect.objectContaining({ employeeId: ids.EMP, engineOwed: "50.00" })])
    );
    expect(diagnostics.body.bookAmountColumn.bookColumns).toBe("debit_amount/credit_amount");
  });
});

describe("5: statements on owned lines", () => {
  it("lists only the bank's and the employee's own lines", async () => {
    const bank = await agent.get(`/api/accounts/bank/${ids.BANK}/transactions`);
    expect(bank.status).toBe(200);
    expect(bank.body.transactions.map((t: { debitAmount: string }) => t.debitAmount)).toEqual(["15.00"]);
    const paged = await agent.get(`/api/accounts/bank/${ids.BANK}/transactions?pagination=1&page=1&limit=50`);
    expect(paged.body.transactions.map((t: { debitAmount: string }) => t.debitAmount)).toEqual(["15.00"]);
    const employee = await agent.get(`/api/accounts/employee/${ids.EMP}/transactions`);
    const amounts = employee.body.transactions.map((t: { debitAmount: string; creditAmount: string }) =>
      t.debitAmount === "0.00" ? `-${t.creditAmount}` : t.debitAmount
    );
    expect(amounts.sort()).toEqual(["-80.00", "30.00"]);
  });
});

describe("6: credit notes against an invoice", () => {
  it("credits the customer, restocks at the original cost, allocates to the invoice", async () => {
    const stockItemId = ctx.stockItemIds[0];
    ids.CU3 = await insertId(
      `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
       VALUES ($1, $2, $3, 0, 'Dr') RETURNING id`,
      [ctx.companyId, `${PREFIX}-CU3`, `${PREFIX} returning customer`]
    );
    ids.SALE = await voucher(
      daysAgo(6),
      [
        { customer: ids.CU3, debit: "60.00" },
        { ledger: ctx.salesAccountId, credit: "60.00" },
      ],
      "Sales"
    );
    await pool.query(
      `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, value_moved)
       VALUES ($1, $2, 3, 20, 8, 60, 24, 36, 24)`,
      [ids.SALE, stockItemId]
    );
    const tooMany = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: today,
      customerId: ids.CU3,
      invoiceVoucherId: ids.SALE,
      items: [{ stockItemId, locationId: ctx.locationId, quantity: "4", refundRate: "20", inventoryCost: "15" }],
    });
    expect(tooMany.status).toBe(409);
    const noInvoice = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: today,
      customerId: ids.CU3,
      items: [{ stockItemId, locationId: ctx.locationId, quantity: "1", refundRate: "20" }],
    });
    expect(noInvoice.status).toBe(400);

    const created = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: today,
      customerId: ids.CU3,
      invoiceVoucherId: ids.SALE,
      items: [{ stockItemId, locationId: ctx.locationId, quantity: "1", refundRate: "20", inventoryCost: "15" }],
    });
    expect(created.status).toBe(200);
    const noteId = created.body.voucherId;
    const lines = await pool.query(
      `SELECT customer_id, ledger_account_id, debit_amount::text AS debit, credit_amount::text AS credit, narration
         FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [noteId]
    );
    expect(lines.rows[0]).toMatchObject({ customer_id: ids.CU3, credit: "20.00", debit: "0.00" });
    expect(lines.rows.some((l) => l.narration.startsWith("Inventory restored") && l.debit === "8.00")).toBe(true);
    const item = await pool.query(`SELECT inventory_cost::text AS cost FROM credit_note_items WHERE voucher_id = $1`, [
      noteId,
    ]);
    expect(Number(item.rows[0].cost)).toBe(8);
    const allocation = await pool.query(
      `SELECT invoice_voucher_id, amount::text AS amount, method FROM party_open_item_allocations WHERE payment_voucher_id = $1`,
      [noteId]
    );
    expect(allocation.rows).toEqual([{ invoice_voucher_id: ids.SALE, amount: "20.00", method: "note" }]);
    const party = await getPartyBalance(db, { companyId: ctx.companyId, kind: "customer", id: ids.CU3 });
    expect(party?.closing).toBe("40.00");

    const edit = await agent.patch(`/api/credit-notes/${noteId}`).send({ voucherDate: today, items: [] });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("NOTE_REFERENCES_INVOICE_REVERSE_INSTEAD");
  });
});

describe("7–9: factory supplier opening side, customer statement, SP supplier definition", () => {
  it("counts a Dr factory supplier opening as a debit", async () => {
    const party = await getPartyBalance(db, { companyId: ctx.companyId, kind: "factorySupplier", id: ids.FS });
    expect(party).toMatchObject({ masterOpening: "70.00", closing: "70.00", openingSideAssumed: false });
    const { row } = await agingRow("factorySupplier", ids.FS);
    expect(row.buckets.unappliedCredit).toBe("-70.00");
  });

  it("serves the customer statement from the ledger with the cache as a memo", async () => {
    const response = await agent.get(`/api/customers/${ids.CU2}/statement`);
    expect(response.status).toBe(200);
    expect(response.body.basis).toBe("ledger");
    expect(response.body.transactions).toHaveLength(3);
    expect(response.body.operationalMemo.label).toMatch(/memo/);
  });

  it("does not count supplier-partner payable evidence in the unified supplier balance", async () => {
    const supplierId = await insertId(
      `INSERT INTO suppliers (code, legal_name, email, opening_balance, company_id)
       VALUES ($1, $2, '', 0, $3) RETURNING id`,
      [`${PREFIX.toUpperCase()}-SUP-${ctx.companyId}`, `${PREFIX} supplier`, ctx.companyId]
    );
    await voucher(daysAgo(2), [
      { ledger: ids.SALEXP, debit: "25.00" },
      { supplier: supplierId, credit: "25.00" },
    ]);
    // Payable evidence: a supplier-tagged line on a ledger account (the account's line).
    await voucher(daysAgo(1), [
      { ledger: ids.SALEXP, debit: "40.00" },
      { ledger: ctx.cashAccountId, supplier: supplierId, credit: "40.00" },
    ]);
    const original = await pool.query(`SELECT company_type FROM companies WHERE id = $1`, [ctx.companyId]);
    await pool.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [ctx.companyId]);
    try {
      const rows = await buildUnifiedSupplierLedger({ supplierId, companyIds: [ctx.companyId] });
      const evidence = rows.filter((row) => row.spPayableEvidence);
      expect(evidence).toHaveLength(1);
      expect(rows.at(-1)?.balance).toBe(25);
    } finally {
      await pool.query(`UPDATE companies SET company_type = $2 WHERE id = $1`, [
        ctx.companyId,
        original.rows[0].company_type,
      ]);
    }
  });
});

describe("10: chat aging and the overdue reminder on the aging service", () => {
  it("answers the chat customer aging from the aging report", async () => {
    const result = await agingChatResult({
      companyId: ctx.companyId,
      kind: "customer",
      rowLimit: 50,
      fmt: (n) => n.toFixed(2),
    });
    expect(result.table?.headers.slice(0, 3)).toEqual(["Customer", "Total", "Not due"]);
    const row = result.table?.rows.find((cells) => cells[0] === `${PREFIX} paid customer`);
    expect(row?.slice(0, 3)).toEqual([`${PREFIX} paid customer`, "40.00", "40.00"]);
  });

  it("writes the reminder in the company's currency from exact amounts", () => {
    const text = formatOverdueReminder([
      {
        id: 1,
        legal_name: "Acme",
        payment_terms_days: 30,
        company_id: 1,
        net_balance: "1234567.5",
        overdue_amount: "0.1",
        earliest_invoice_date: "2026-01-01",
        due_date: "2026-01-31",
        days_overdue: 9,
        currency: "XOF",
      },
    ]);
    expect(text).toContain("• Acme: XOF 0.10 overdue of XOF 1,234,567.50 — due 2026-01-31 (9d overdue)");
    expect(text).not.toContain("$");
  });
});
