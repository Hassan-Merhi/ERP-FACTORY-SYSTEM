/**
 * Factory Net Position historical date filter, against a real PostgreSQL
 * schema (CI's database service). One factory company in Asia/Beirut
 * (UTC+3 in October 2026) with dated events on Oct 18-21; the clock is
 * fixed at Oct 23 so Oct 19/20/21/22 are all past dates.
 *
 * Every `created_at` is UTC-naive, as the application writes it. Each
 * scenario states the figure the source rows prove for each day; none is
 * derived from the report under test.
 */
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { ensureCustomerOrderBaleScanAudit } from "../server/customerOrderBaleScanAuditBridge.mjs";
import { registerEmployeeNetPositionRoutes } from "../server/routes/factory/employee-pos/employeeNetPositionRoutes";
import { registerEmployeeAttendanceRoutes } from "../server/routes/factory/employee-pos/employeeAttendanceRoutes";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

type Row = { name: string; code: string; value: number; category: string };
type Report = {
  asOf: string;
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  forUs: { total: number; breakdown: { name: string; value: number }[]; accounts: Row[] };
  onUs: { total: number; breakdown: { name: string; value: number }[]; accounts: Row[] };
  inventoryValue: number;
  rawMaterialValue: number;
  balanceOnTableValue: number;
  stockOtwValue?: number;
  verifiedTotal: number;
  loadingTotal: number;
  pendingTotal: number;
  supplierLiabilities: number;
  payrollPayable: number;
  historyCompleteness?: string;
  historyCoverage?: { gaps: { code: string; records: number }[] } | null;
  [key: string]: unknown;
};

const handlers = new Map<string, (req: unknown, res: unknown) => Promise<unknown>>();
const app = { get: (path: string, ...h: any[]) => handlers.set(path, h.at(-1)) };
registerEmployeeNetPositionRoutes(app as any);
registerEmployeeAttendanceRoutes(app as any);

async function call(path: string, companyId: number, query: Record<string, string>) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  await handlers.get(path)!({ session: { factoryCompanyId: companyId }, query } as any, res);
  return res as { statusCode: number; body: any };
}

async function report(companyId: number, asOf?: string, valuationMode: "cost" | "selling" = "cost"): Promise<Report> {
  const res = await call("/api/factory/net-position", companyId, { ...(asOf ? { asOf } : {}), valuationMode });
  if (res.statusCode !== 200)
    throw new Error(`net-position ${asOf ?? "today"} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
  return res.body as Report;
}

const row = (r: Report, side: "forUs" | "onUs", code: string) =>
  r[side].accounts.filter((a) => a.code === code).reduce((s, a) => s + a.value, 0);
const named = (r: Report, side: "forUs" | "onUs", name: string) =>
  r[side].accounts.find((a) => a.name === name)?.value ?? 0;
const cents = (n: number) => Math.round(n * 100);

/** Fields only the dated contract adds; everything else must equal today's figure. */
const METADATA = [
  "asOf",
  "businessToday",
  "timeZone",
  "historyBasis",
  "historyCoverage",
  "historyCompleteness",
  "historyWarnings",
  "inventoryHistoryWarnings",
  "companyId",
];
const figures = (r: Report) => {
  const copy: Record<string, unknown> = { ...r };
  for (const key of METADATA) delete copy[key];
  // Breakdown order and account order only follow values; compare as sets.
  for (const side of ["forUs", "onUs"] as const) {
    const s = copy[side] as Report["forUs"];
    copy[side] = {
      total: s.total,
      breakdown: [...s.breakdown].sort((a, b) => a.name.localeCompare(b.name)),
      accounts: [...s.accounts]
        .map((a) => ({ ...a }))
        .sort((a, b) => `${a.code}${a.name}`.localeCompare(`${b.code}${b.name}`)),
    };
  }
  return copy;
};

databaseDescribe("Factory Net Position historical date filter (database)", () => {
  const suffix = `${process.pid}${Date.now() % 100000}`;
  let companyId = 0;
  const ids: Record<string, number> = {};

  const one = async (query: ReturnType<typeof sql>) => {
    const result: any = await db.execute(query);
    return Number(result.rows[0]?.id);
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-23T09:00:00Z") });
    // The scan-audit columns come from the startup preload, which CI's
    // migration boot does not run. Same idempotent DDL as production.
    await ensureCustomerOrderBaleScanAudit();

    companyId = await one(sql`INSERT INTO companies (code, name, company_type, created_at)
      VALUES (${"NPH" + suffix}, ${"NP history " + suffix}, 'factory', '2026-10-01 00:00') RETURNING id`);
    await db.execute(sql`INSERT INTO company_settings (company_id, timezone) VALUES (${companyId}, 'Asia/Beirut')`);

    // ── Manual FX: EUR 1.10 known since Oct 1; an Oct 19 rate of 1.20 was
    //    only entered on Oct 21, so Oct 19/20 must still use 1.10.
    await db.execute(sql`INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source, created_at) VALUES
      (${companyId}, 'EUR', 1.10, '2026-10-01', 'manual', '2026-10-01 08:00'),
      (${companyId}, 'EUR', 1.20, '2026-10-19', 'manual', '2026-10-21 08:00')`);

    // ── Ledger.
    const account = (code: string, name: string, type: string) =>
      one(sql`
      INSERT INTO ledger_accounts (company_id, code, name, account_type, created_at)
      VALUES (${companyId}, ${code + suffix}, ${name}, ${type}, '2026-10-01 00:00') RETURNING id`);
    ids.cash = await account("CASH", "Operating Cash", "Asset");
    ids.loan = await account("LOAN", "Bank Loan", "Liability");
    ids.deposit = await account("DEP", "Customer Deposits Held", "Liability");
    ids.sales = await account("SALES", "Sales", "Income");
    ids.salary = await account("SAL", "Salary Expense", "Expense");
    ids.custLedger = await account("CUST", "Customer One Ledger", "Asset");
    // An account opened only on Oct 21 must not exist on Oct 19/20.
    ids.lateLoan = await account("LATE", "Late Loan", "Liability");
    await db.execute(sql`UPDATE ledger_accounts SET created_at = '2026-10-21 07:00' WHERE id = ${ids.lateLoan}`);

    const voucher = async (
      n: string,
      date: string,
      createdAt: string,
      lines: Array<{ account?: number; employee?: number; dr?: number; cr?: number; createdAt?: string }>
    ) => {
      // One transaction per voucher: the deferred balance guard checks the
      // voucher once all its lines are in.
      return db.transaction(async (tx) => {
        const created: any = await tx.execute(sql`
          INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, created_at)
          VALUES (${companyId}, ${n + suffix}, 'Journal', ${date}, ${lines.reduce((s, l) => s + (l.dr ?? 0), 0)}, false, ${createdAt})
          RETURNING id`);
        const id = Number(created.rows[0].id);
        for (const l of lines) {
          await tx.execute(sql`INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, employee_id, debit_amount, credit_amount, created_at)
            VALUES (${id}, ${companyId}, ${l.account ?? null}, ${l.employee ?? null}, ${l.dr ?? 0}, ${l.cr ?? 0}, ${l.createdAt ?? createdAt})`);
        }
        return id;
      });
    };
    // Oct 18: borrowed 1,000 into cash.
    await voucher("V1-", "2026-10-18", "2026-10-18 09:00", [
      { account: ids.cash, dr: 1000 },
      { account: ids.loan, cr: 1000 },
    ]);
    // Entered Oct 21 but dated Oct 19: invisible on Oct 19 and 20.
    await voucher("V2-", "2026-10-19", "2026-10-21 10:00", [
      { account: ids.cash, dr: 500 },
      { account: ids.loan, cr: 500 },
    ]);
    // 21:30 UTC on Oct 19 is 00:30 on Oct 20 in Beirut: first counts Oct 20.
    await voucher("V3-", "2026-10-19", "2026-10-19 21:30", [
      { account: ids.cash, dr: 50 },
      { account: ids.loan, cr: 50 },
    ]);
    // Recorded Oct 18, every line re-inserted by an edit on Oct 21.
    await voucher("V4-", "2026-10-18", "2026-10-18 10:00", [
      { account: ids.cash, dr: 200, createdAt: "2026-10-21 12:00" },
      { account: ids.deposit, cr: 200, createdAt: "2026-10-21 12:00" },
    ]);
    // Recorded Oct 21 on the late account.
    await voucher("V5-", "2026-10-21", "2026-10-21 07:30", [
      { account: ids.cash, dr: 40 },
      { account: ids.lateLoan, cr: 40 },
    ]);

    // ── Customer: invoiced 300 on Oct 21 with an Oct 19 date.
    ids.customer = await one(sql`INSERT INTO customers (company_id, code, legal_name, ledger_account_id, created_at)
      VALUES (${companyId}, ${"C1" + suffix}, 'Customer One', ${ids.custLedger}, '2026-10-01 00:00') RETURNING id`);
    await voucher("INV-", "2026-10-19", "2026-10-21 11:00", [
      { account: ids.custLedger, dr: 300 },
      { account: ids.sales, cr: 300 },
    ]);

    // ── Employee: 300 salary accrued Oct 18; 100 paid, entered Oct 21 dated Oct 20.
    ids.employee =
      await one(sql`INSERT INTO employees (company_id, code, first_name, last_name, join_date, employee_type, active, current_balance, opening_balance, created_at)
      VALUES (${companyId}, ${"E1" + suffix}, 'Pat', 'Payroll', '2026-01-01', 'Employee', true, 200, 0, '2026-10-01 00:00') RETURNING id`);
    await voucher("PAYR-", "2026-10-18", "2026-10-18 12:00", [
      { account: ids.salary, dr: 300 },
      { employee: ids.employee, cr: 300 },
    ]);
    await voucher("PAY-", "2026-10-20", "2026-10-21 13:00", [
      { employee: ids.employee, dr: 100 },
      { account: ids.cash, cr: 100 },
    ]);

    // ── Worker advance 100 (Oct 19), repaid 20 (Oct 20) and 30 (Oct 21).
    ids.worker = await one(sql`INSERT INTO factory_workers (company_id, full_name, created_at)
      VALUES (${companyId}, 'Worker One', '2026-10-01 00:00') RETURNING id`);
    ids.advance =
      await one(sql`INSERT INTO factory_worker_advances (company_id, worker_id, advance_date, amount, remaining_balance, created_at)
      VALUES (${companyId}, ${ids.worker}, '2026-10-19', 100, 50, '2026-10-19 08:00') RETURNING id`);
    await db.execute(sql`INSERT INTO factory_advance_repayments (company_id, advance_id, worker_id, repayment_date, amount, created_at) VALUES
      (${companyId}, ${ids.advance}, ${ids.worker}, '2026-10-20', 20, '2026-10-20 08:00'),
      (${companyId}, ${ids.advance}, ${ids.worker}, '2026-10-21', 30, '2026-10-21 08:00')`);

    // ── Supplier with two containers.
    ids.supplier =
      await one(sql`INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd, created_at)
      VALUES (${companyId}, ${"Supplier " + suffix}, 0.5, '2026-10-01 00:00') RETURNING id`);
    // A: 10,000 kg at 0.50 USD plus 300 freight, ARRIVED until 4,000 kg were
    // received on Oct 20 and 6,000 kg on Oct 21. The offload rewrote its
    // final payable and charges; the pre-offload snapshot keeps the 300.
    ids.containerA =
      await one(sql`INSERT INTO factory_containers (company_id, container_number, supplier_id, status, pre_offload_status,
        total_kg, rate_per_kg, currency_code, final_payable_amount, freight, pre_offload_freight, pre_offload_freight_currency_code,
        pre_offload_other_charges, pre_offload_commission_amount, created_at, updated_at)
      VALUES (${companyId}, ${"A" + suffix}, ${ids.supplier}, 'OFFLOADED', 'ARRIVED', 10000, 0.5, 'USD', 5000, 0, 300, 'USD', 0, 0,
        '2026-10-15 08:00', '2026-10-21 09:00') RETURNING id`);
    // B: 1,000 EUR in transit the whole time.
    ids.containerB =
      await one(sql`INSERT INTO factory_containers (company_id, container_number, supplier_id, status, total_kg, rate_per_kg,
        currency_code, created_at, updated_at)
      VALUES (${companyId}, ${"B" + suffix}, ${ids.supplier}, 'IN_TRANSIT', 1000, 1, 'EUR', '2026-10-18 08:00', '2026-10-18 08:00') RETURNING id`);
    await db.execute(sql`INSERT INTO factory_container_receipts (company_id, container_id, receipt_date, received_kg, cumulative_received_kg,
        fixed_cost_per_kg, fixed_cost_per_kg_usd, currency_code, created_at) VALUES
      (${companyId}, ${ids.containerA}, '2026-10-20', 4000, 4000, 0.5, 0.5, 'USD', '2026-10-20 09:00'),
      (${companyId}, ${ids.containerA}, '2026-10-21', 6000, 10000, 0.5, 0.5, 'USD', '2026-10-21 09:00')`);
    await db.execute(sql`INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd, offloaded_at, created_at)
      VALUES (${companyId}, ${ids.containerA}, 10000, 250, 0.5, 0.5, '2026-10-20 09:00', '2026-10-20 09:00')`);
    // A supplier payment of 500 entered Oct 21 dated Oct 19.
    await db.execute(sql`INSERT INTO factory_supplier_payments (company_id, supplier_id, date, amount, amount_usd, currency_code, created_at)
      VALUES (${companyId}, ${ids.supplier}, '2026-10-19', 500, 500, 'USD', '2026-10-21 14:00')`);

    // ── Production: an Oct 20 mix batch consumes 250 kg (125 USD); one
    //    100 kg bale is pressed from it on Oct 21.
    ids.batch =
      await one(sql`INSERT INTO factory_mix_batches (company_id, batch_code, batch_date, total_weight_kg, total_cost, cost_per_kg, status, created_at, updated_at)
      VALUES (${companyId}, ${"MB" + suffix}, '2026-10-20', 250, 125, 0.5, 'OPEN', '2026-10-20 10:00', '2026-10-20 10:00') RETURNING id`);
    // Legacy rows like this one name a different supplier than the container
    // they drew from (the owner trigger now refuses new ones). The 250 kg
    // still left container A, so it is consumed from container A's supplier.
    ids.otherSupplier = await one(sql`INSERT INTO factory_suppliers (company_id, name, created_at)
      VALUES (${companyId}, ${"Other supplier " + suffix}, '2026-10-01 00:00') RETURNING id`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE factory_mix_batch_sources DISABLE TRIGGER USER`);
      await tx.execute(sql`INSERT INTO factory_mix_batch_sources (mix_batch_id, container_id, supplier_id, inventory_supplier_id, weight_kg, cost_per_kg, total_cost, created_at)
        VALUES (${ids.batch}, ${ids.containerA}, ${ids.otherSupplier}, ${ids.otherSupplier}, 250, 0.5, 125, '2026-10-20 10:00')`);
      await tx.execute(sql`ALTER TABLE factory_mix_batch_sources ENABLE TRIGGER USER`);
    });

    ids.product =
      await one(sql`INSERT INTO factory_bale_products (company_id, code, name, production_price, selling_price)
      VALUES (${companyId}, ${"P" + suffix}, 'Mixed bale', 40, 60) RETURNING id`);
    const bale = (code: string, status: string, weight: number, created: string, updated: string) =>
      one(sql`
      INSERT INTO factory_bales (company_id, bale_code, reference_number, product_id, weight_kg, status, finalized_at, stock_entry_date, created_at, updated_at)
      VALUES (${companyId}, ${code + suffix}, ${code + suffix}, ${ids.product}, ${weight}, ${status}, ${created}, ${created.slice(0, 10)}, ${created}, ${updated})
      RETURNING id`);
    ids.bale1 = await bale("B1-", "IN_STOCK", 0, "2026-10-10 08:00", "2026-10-10 08:00"); // in stock throughout
    ids.bale2 = await bale("B2-", "IN_STOCK", 100, "2026-10-21 15:00", "2026-10-21 15:00"); // pressed Oct 21
    ids.bale3 = await bale("B3-", "RESERVED_FOR_ORDER", 0, "2026-10-10 08:00", "2026-10-21 16:00"); // scanned Oct 21
    ids.bale4 = await bale("B4-", "SOLD", 0, "2026-10-10 08:00", "2026-10-21 17:00"); // scanned Oct 12, verified Oct 21
    ids.bale5 = await bale("B5-", "SOLD", 0, "2026-10-05 08:00", "2026-10-21 18:00"); // legacy untimed scan, invoiced Oct 21

    // ── Rent: a FACTORY shop contract from Oct 1 with 100 due on Oct 1; the
    //    tenant's 60, dated Oct 15, was only entered and posted on Oct 20.
    ids.unit =
      await one(sql`INSERT INTO property_units (company_id, module, unit_type, location_group, unit_number, active, created_at)
      VALUES (${companyId}, 'FACTORY', 'SHOP', 'Front', ${"U" + suffix}, true, '2026-10-01 00:00') RETURNING id`);
    ids.contract =
      await one(sql`INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, created_at)
      VALUES (${companyId}, 'FACTORY', ${ids.unit}, 'Tenant One', 100, '2026-10-01', 'ACTIVE', '2026-10-01 00:00') RETURNING id`);
    await db.execute(sql`INSERT INTO property_monthly_ledger (company_id, module, contract_id, unit_id, year, month, expected_amount, created_at)
      VALUES (${companyId}, 'FACTORY', ${ids.contract}, ${ids.unit}, 2026, 10, 100, '2026-10-01 00:00')`);
    await db.execute(sql`INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
        posting_status, posted_at, created_at)
      VALUES (${companyId}, 'FACTORY', ${ids.contract}, ${ids.unit}, 60, '2026-10-15', 2026, 10, 'POSTED', '2026-10-20 08:00', '2026-10-20 08:00')`);

    ids.location = await one(
      sql`INSERT INTO locations (company_id, code, name) VALUES (${companyId}, ${"L" + suffix}, 'Warehouse') RETURNING id`
    );

    // ── Orders. O1 has loaded since Oct 15; bale 3 was scanned into it on Oct 21.
    ids.order1 =
      await one(sql`INSERT INTO customer_orders (company_id, customer_id, order_date, status, grand_total, total_qty_bales,
        loading_started_at, created_at, updated_at)
      VALUES (${companyId}, ${ids.customer}, '2026-10-15', 'LOADING', 60, 1, '2026-10-15 08:00', '2026-10-15 08:00', '2026-10-21 16:00') RETURNING id`);
    // O2 scanned bale 4 on Oct 12; its loading was submitted on Oct 21 with
    // a chosen verification date of Oct 19.
    ids.order2 =
      await one(sql`INSERT INTO customer_orders (company_id, customer_id, order_date, status, grand_total, total_qty_bales,
        loading_started_at, verified_at, loading_finalized_at, created_at, updated_at)
      VALUES (${companyId}, ${ids.customer}, '2026-10-12', 'VERIFIED', 70, 1, '2026-10-12 08:00', '2026-10-19 12:00', '2026-10-19 12:00',
        '2026-10-12 08:00', '2026-10-21 17:00') RETURNING id`);
    await db.execute(sql`INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, scanned_at) VALUES
      (${ids.order1}, ${ids.bale3}, 'B3', ${ids.location}, 0, 60, '2026-10-21 16:00+00'),
      (${ids.order2}, ${ids.bale4}, 'B4', ${ids.location}, 0, 70, '2026-10-12 08:00+00')`);
    // O3 predates scan-time tracking (the company's first timed scan is
    // Oct 12): verified Oct 7 with an untimed scan, invoiced only Oct 21.
    ids.order3 =
      await one(sql`INSERT INTO customer_orders (company_id, customer_id, order_date, status, grand_total, total_qty_bales,
        loading_started_at, verified_at, finalized_at, created_at, updated_at)
      VALUES (${companyId}, ${ids.customer}, '2026-10-05', 'FINALIZED', 95, 1, '2026-10-05 08:00', '2026-10-07 08:00', '2026-10-21 18:00',
        '2026-10-05 08:00', '2026-10-21 18:00') RETURNING id`);
    await db.execute(sql`INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used) VALUES
      (${ids.order3}, ${ids.bale5}, 'B5', ${ids.location}, 0, 90)`);
    await db.execute(sql`INSERT INTO factory_daybook_entries (company_id, tx_date, tx_type, description, reference_id, reference_table, created_at) VALUES
      (${companyId}, '2026-10-07', 'ORDER_VERIFIED', 'Order verified', ${ids.order3}, 'customer_orders', '2026-10-07 08:00'),
      (${companyId}, '2026-10-19', 'LOADING_SUBMITTED', 'Loading submitted', ${ids.order2}, 'customer_orders', '2026-10-21 17:00'),
      (${companyId}, '2026-10-19', 'ORDER_VERIFIED', 'Order verified', ${ids.order2}, 'customer_orders', '2026-10-21 17:00')`);
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (!companyId) return;
    await db.execute(
      sql`DELETE FROM customer_order_bales WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = ${companyId})`
    );
    await db.execute(
      sql`DELETE FROM factory_mix_batch_sources WHERE mix_batch_id IN (SELECT id FROM factory_mix_batches WHERE company_id = ${companyId})`
    );
    await db.execute(sql`DELETE FROM factory_mix_batches WHERE company_id = ${companyId}`);
    for (const table of [
      "factory_daybook_entries",
      "customer_orders",
      "factory_bales",
      "factory_bale_products",
      "factory_supplier_payments",
      "factory_raw_stock",
      "factory_container_receipts",
      "factory_containers",
      "factory_suppliers",
      "factory_advance_repayments",
      "factory_worker_advances",
      "factory_workers",
      "voucher_entries",
      "vouchers",
      "employees",
      "customers",
      "ledger_accounts",
      "factory_fx_rates",
      "locations",
      "property_payments",
      "property_monthly_ledger",
      "property_contracts",
      "property_units",
      "company_settings",
    ]) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE company_id = ${companyId}`);
    }
    await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
  });

  it("rebuilds each category from what was recorded by the company-local end of Oct 19, 20 and 21", async () => {
    const [d19, d20, d21] = [
      await report(companyId, "2026-10-19"),
      await report(companyId, "2026-10-20"),
      await report(companyId, "2026-10-21"),
    ];

    // Cash: V1 1,000; V3 (00:30 Oct 20 local) +50; V4 edited later but recorded Oct 18 +200;
    // V2 and V5 and the employee payment were only entered on Oct 21.
    expect([
      named(d19, "forUs", "Operating Cash"),
      named(d20, "forUs", "Operating Cash"),
      named(d21, "forUs", "Operating Cash"),
    ]).toEqual([1200, 1250, 1250 + 500 + 40 - 100]);
    expect([named(d19, "onUs", "Bank Loan"), named(d20, "onUs", "Bank Loan"), named(d21, "onUs", "Bank Loan")]).toEqual(
      [1000, 1050, 1550]
    );
    expect(named(d19, "onUs", "Customer Deposits Held")).toBe(200);
    expect([named(d19, "onUs", "Late Loan"), named(d20, "onUs", "Late Loan"), named(d21, "onUs", "Late Loan")]).toEqual(
      [0, 0, 40]
    );
    expect(d20.onUs.accounts.some((a) => a.name === "Late Loan")).toBe(false);

    // Customer invoice entered Oct 21 with an Oct 19 date, plus O3's
    // unposted invoice of 95, finalized on Oct 21.
    expect([
      row(d19, "forUs", "CUSTOMER_DR"),
      row(d20, "forUs", "CUSTOMER_DR"),
      row(d21, "forUs", "CUSTOMER_DR"),
    ]).toEqual([0, 0, 300 + 95]);

    // Payroll payable: 300 accrued Oct 18; 100 paid (entered Oct 21).
    expect([d19.payrollPayable, d20.payrollPayable, d21.payrollPayable]).toEqual([300, 300, 200]);

    // Rent: |100 due - 60 posted|, the payment known from Oct 20.
    expect([
      row(d19, "forUs", "PREPAID_RENT"),
      row(d20, "forUs", "PREPAID_RENT"),
      row(d21, "forUs", "PREPAID_RENT"),
    ]).toEqual([100, 40, 40]);

    // Worker advance 100 - 20 (Oct 20) - 30 (Oct 21).
    expect([
      row(d19, "forUs", "WORKER_ADVANCES"),
      row(d20, "forUs", "WORKER_ADVANCES"),
      row(d21, "forUs", "WORKER_ADVANCES"),
    ]).toEqual([100, 80, 50]);

    // OTW: A (5,000 + 300 freight) until its first receipt on Oct 20, then
    // never again (today's rule); B 1,000 EUR at the EUR rate known that day.
    expect([d19.stockOtwValue, d20.stockOtwValue, d21.stockOtwValue]).toEqual([5300 + 1100, 1100, 1200]);

    // Raw material: received kg minus the 250 kg consumed Oct 20, at 0.50.
    expect([d19.rawMaterialValue, d20.rawMaterialValue, d21.rawMaterialValue]).toEqual([
      0,
      (4000 - 250) * 0.5,
      (10000 - 250) * 0.5,
    ]);
    expect(d21.inventoryHistoryWarnings).toContain("HISTORICAL_RAW_SOURCE_OWNER_CONFLICT");

    // Balance on Table: 250 kg mixed Oct 20; 100 kg pressed out Oct 21.
    expect([d19.balanceOnTableValue, d20.balanceOnTableValue, d21.balanceOnTableValue]).toEqual([0, 125, 75]);

    // Stock in hand at catalogue cost 40: bales 1 and 3 (3 is scanned Oct 21),
    // then bales 1 and 2. Bale 4 has been on an order since Oct 12, bale 5
    // (untimed legacy scan) since before scan times were recorded.
    expect([d19.inventoryValue, d20.inventoryValue, d21.inventoryValue]).toEqual([80, 80, 80]);

    // O2 was submitted (verified) only on Oct 21, although dated Oct 19:
    // it is a loading order before then, valued by its recorded scans.
    // O3 is verified until its Oct 21 invoice, valued by its legacy scan.
    expect([d19.verifiedTotal, d20.verifiedTotal, d21.verifiedTotal]).toEqual([90, 90, 70]);
    expect([d19.loadingTotal, d20.loadingTotal, d21.loadingTotal]).toEqual([70, 70, 60]);

    // The 500 payment entered Oct 21 lowers the supplier only from Oct 21,
    // when container B's 1,000 EUR is also revalued from 1.10 to 1.20 (+100).
    expect(cents(d19.supplierLiabilities)).toBe(cents(d20.supplierLiabilities));
    expect(cents(d20.supplierLiabilities - d21.supplierLiabilities)).toBe(50000 - 10000);

    for (const r of [d19, d20, d21]) {
      expect(r.historyCompleteness).toBe("partial");
    }
    expect(d19.historyCoverage?.gaps.find((g) => g.code === "HISTORICAL_COVERAGE_VOUCHER_EDITED_LATER")?.records).toBe(
      1
    );
  }, 60_000);

  it("keeps every header, category and row in the same cents for both valuation modes", async () => {
    for (const asOf of ["2026-10-19", "2026-10-20", "2026-10-21", undefined]) {
      for (const mode of ["cost", "selling"] as const) {
        const r = await report(companyId, asOf, mode);
        const sum = (rows: Row[]) => rows.reduce((s, a) => s + cents(a.value), 0);
        expect(cents(r.forUsTotal)).toBe(sum(r.forUs.accounts));
        expect(cents(r.onUsTotal)).toBe(sum(r.onUs.accounts));
        expect(cents(r.netPosition)).toBe(cents(r.forUsTotal) - cents(r.onUsTotal));
        if (asOf) {
          for (const side of ["forUs", "onUs"] as const) {
            for (const group of r[side].breakdown) {
              const category = side === "onUs" && group.name === "Suppliers" ? "Supplier" : group.name;
              expect(cents(group.value)).toBe(
                sum(r[side].accounts.filter((a) => (a.category || "Other") === category))
              );
            }
          }
        }
      }
    }
    // Only Stock in Hand changes with the valuation mode (catalogue 40 vs 60).
    const cost = await report(companyId, "2026-10-20", "cost");
    const selling = await report(companyId, "2026-10-20", "selling");
    expect([cost.inventoryValue, selling.inventoryValue]).toEqual([80, 120]);
    expect(selling.rawMaterialValue).toBe(cost.rawMaterialValue);
    expect(selling.balanceOnTableValue).toBe(cost.balanceOnTableValue);
    expect(cents(selling.forUsTotal - cost.forUsTotal)).toBe(4000);
    expect(selling.onUsTotal).toBe(cost.onUsTotal);
  }, 60_000);

  it("shows yesterday exactly as today when nothing was recorded since", async () => {
    // Nothing in the fixture is recorded after Oct 21, so Oct 22 must equal
    // the live figure (Oct 23) in every amount, for both modes.
    for (const mode of ["cost", "selling"] as const) {
      const today = await report(companyId, undefined, mode);
      const yesterday = await report(companyId, "2026-10-22", mode);
      expect(today.historyCompleteness).toBe("current");
      if (process.env.NP_FIXTURE_DIFF)
        fs.writeFileSync(
          `${process.env.NP_FIXTURE_DIFF}.${mode}.json`,
          JSON.stringify({ today: figures(today), yesterday: figures(yesterday) }, null, 1)
        );
      expect(figures(yesterday)).toEqual(figures(today));
      if (process.env.NP_FIXTURE_DUMP)
        fs.writeFileSync(`${process.env.NP_FIXTURE_DUMP}.${mode}.json`, JSON.stringify(today, null, 1));
    }
  }, 60_000);

  it("splits Payroll Payable into the employee rows of the same company and date", async () => {
    for (const asOf of ["2026-10-19", "2026-10-21"]) {
      const parent = await report(companyId, asOf);
      const breakdown = await call("/api/factory/net-position/payroll-breakdown", companyId, { asOf });
      expect(breakdown.statusCode).toBe(200);
      expect(breakdown.body.companyId).toBe(companyId);
      expect(breakdown.body.asOf).toBe(asOf);
      expect(cents(breakdown.body.employees.reduce((s: number, e: { balance: number }) => s + e.balance, 0))).toBe(
        cents(parent.payrollPayable)
      );
    }
  }, 60_000);

  it("rejects a future date and an impossible date instead of guessing", async () => {
    expect((await call("/api/factory/net-position", companyId, { asOf: "2026-10-24" })).statusCode).toBe(400);
    expect((await call("/api/factory/net-position", companyId, { asOf: "2026-02-30" })).statusCode).toBe(400);
  });
});
