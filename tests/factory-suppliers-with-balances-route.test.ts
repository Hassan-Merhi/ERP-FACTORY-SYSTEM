/**
 * Behavioural coverage for `GET /api/factory/suppliers/with-balances`
 * (`server/routes/factory/suppliers/balance/with-balances.ts`).
 *
 * This is the read model behind the supplier list: what each supplier is owed,
 * what has been paid, and the resulting balance. It was 0.37% covered. It
 * aggregates from four independent sources — containers, direct supplier
 * payments, voucher entries tagged to a factory supplier, and post-offload
 * charges — and every one of them has a rule about what must NOT be counted.
 *
 * The properties worth holding:
 *
 *   - **Nothing is double-counted.** `FACTORY-PAY-*` vouchers are generated
 *     from the supplier-payment rows, so counting both would report a supplier
 *     as paid twice.
 *   - **Provisional vouchers do not move a balance.** An `optional` voucher is
 *     a draft; letting it settle a supplier would understate what is owed.
 *   - **An unresolvable rate is excluded and flagged, never guessed at 1.**
 *     A payment in an unresolved currency is left out of the total and the
 *     supplier is marked `fxUnresolved`, so the UI can say "incomplete" rather
 *     than show a confidently wrong number.
 *   - **A charge belongs to a supplier only when it names one.** Post-offload
 *     charges posted to a ledger account carry `supplier_id = NULL` and must
 *     not land on anybody's balance.
 *   - **The list is company-scoped** and excludes soft-deleted containers.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "fswb";

/**
 * The route serialises its numbers as fixed-precision strings. `totalValue` is
 * the supplier's BALANCE (what is still owed), while `totalPaid` counts only
 * direct `factory_supplier_payments` rows — a voucher-based payment moves the
 * balance without appearing in `totalPaid`, which the tests below pin.
 */
interface SupplierBalance {
  id: number;
  name: string;
  totalPaid: string;
  totalValue: string;
  totalContainers: number;
  receivedContainers: number;
  fxUnresolved: boolean;
}

/** Balance owed, as a number. */
function balanceOf(row: SupplierBalance): number {
  return Number(row.totalValue);
}

function paidOf(row: SupplierBalance): number {
  return Number(row.totalPaid);
}

let ctx: TestContext;
let agent: request.SuperAgentTest;
let seq = 0;

async function makeSupplier(name: string): Promise<number> {
  const row = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} ${name}`]
  );
  return row.rows[0].id;
}

/** An offloaded, USD, fully-resolved container worth ratePerKg * receivedKg. */
async function makeContainer(
  supplierId: number,
  options: { ratePerKg?: string; receivedKg?: string; status?: string; deleted?: boolean } = {}
): Promise<number> {
  seq += 1;
  const row = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, total_kg, actual_received_kg, status, arrival_date,
        duty_status, freight, other_charges, commission_amount, deleted_at)
     VALUES ($1, $2, $3, 'USD', '1', true, 'manual', $4, $5, $5, $6, '2026-06-08',
             'NONE', '0', '0', '0', $7)
     RETURNING id`,
    [
      ctx.companyId,
      `${TEST_PREFIX}-C${seq}`,
      supplierId,
      options.ratePerKg ?? "2.000000",
      options.receivedKg ?? "100.000",
      options.status ?? "OFFLOADED",
      options.deleted ? new Date() : null,
    ]
  );
  return row.rows[0].id;
}

/** A voucher carrying a debit against a factory supplier — a payment. */
async function makeSupplierVoucher(
  supplierId: number,
  options: { amount: string; voucherNumber: string; optional?: boolean; currency?: string; exchangeRate?: string }
) {
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency, exchange_rate, optional)
     VALUES ($1, 'Payment', $2, '2026-06-10', $3, $4, $5, $6) RETURNING id`,
    [
      ctx.companyId,
      `${TEST_PREFIX}-${options.voucherNumber}`,
      options.amount,
      options.currency ?? "USD",
      options.exchangeRate ?? null,
      options.optional ?? false,
    ]
  );
  await pool.query(
    `INSERT INTO voucher_entries (voucher_id, factory_supplier_id, debit_amount, credit_amount)
     VALUES ($1, $2, $3, '0')`,
    [voucher.rows[0].id, supplierId, options.amount]
  );
  return voucher.rows[0].id;
}

async function fetchBalances(query = ""): Promise<SupplierBalance[]> {
  const response = await agent.get(`/api/factory/suppliers/with-balances${query}`);
  expect(response.status).toBe(200);
  return response.body as SupplierBalance[];
}

function findSupplier(rows: SupplierBalance[], id: number): SupplierBalance {
  const row = rows.find((entry) => entry.id === id);
  expect(row, `supplier ${id} missing from the balance list`).toBeDefined();
  return row!;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  // factory_supplier_payments holds a restricting FK to factory_suppliers, which
  // cleanupTestData deletes by company — clear the payments first.
  await pool.query(`DELETE FROM factory_supplier_payments WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("GET /api/factory/suppliers/with-balances", () => {
  it("owes a supplier the value of its received containers", async () => {
    const supplierId = await makeSupplier("Owed");
    await makeContainer(supplierId, { ratePerKg: "2.000000", receivedKg: "100.000" });
    await makeContainer(supplierId, { ratePerKg: "3.000000", receivedKg: "50.000" });

    const supplier = findSupplier(await fetchBalances(), supplierId);

    // 100 kg * 2.00 = 200, plus 50 kg * 3.00 = 150 → 350 owed, nothing paid.
    expect(balanceOf(supplier)).toBeCloseTo(350, 2);
    expect(paidOf(supplier)).toBeCloseTo(0, 2);
    expect(supplier.receivedContainers).toBe(2);
    expect(supplier.fxUnresolved).toBe(false);
  });

  it("counts a direct supplier payment against the balance", async () => {
    const supplierId = await makeSupplier("Paid");
    await makeContainer(supplierId);
    await pool.query(
      `INSERT INTO factory_supplier_payments
         (company_id, supplier_id, amount, currency_code, fx_rate_to_usd, amount_usd, date)
       VALUES ($1, $2, '75', 'USD', '1', '75', '2026-06-11')`,
      [ctx.companyId, supplierId]
    );

    const supplier = findSupplier(await fetchBalances(), supplierId);

    expect(paidOf(supplier)).toBeCloseTo(75, 2);
    expect(balanceOf(supplier)).toBeCloseTo(125, 2);
  });

  it("counts a supplier-tagged voucher payment", async () => {
    const supplierId = await makeSupplier("VoucherPaid");
    await makeContainer(supplierId);
    await makeSupplierVoucher(supplierId, { amount: "60", voucherNumber: "JV1" });

    const supplier = findSupplier(await fetchBalances(), supplierId);

    // A voucher payment settles the balance but is not part of `totalPaid`,
    // which reports direct supplier-payment rows only.
    expect(balanceOf(supplier)).toBeCloseTo(140, 2);
    expect(paidOf(supplier)).toBeCloseTo(0, 2);
  });

  it("does not double-count a FACTORY-PAY voucher that mirrors a supplier payment", async () => {
    const supplierId = await makeSupplier("NoDouble");
    await makeContainer(supplierId);
    await pool.query(
      `INSERT INTO factory_supplier_payments
         (company_id, supplier_id, amount, currency_code, fx_rate_to_usd, amount_usd, date)
       VALUES ($1, $2, '80', 'USD', '1', '80', '2026-06-11')`,
      [ctx.companyId, supplierId]
    );
    // The auto-generated mirror of that same payment.
    const mirror = await pool.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount, currency)
       VALUES ($1, 'Payment', $2, '2026-06-11', '80', 'USD') RETURNING id`,
      [ctx.companyId, `FACTORY-PAY-${supplierId}-1`]
    );
    await pool.query(
      `INSERT INTO voucher_entries (voucher_id, factory_supplier_id, debit_amount, credit_amount)
       VALUES ($1, $2, '80', '0')`,
      [mirror.rows[0].id, supplierId]
    );

    const supplier = findSupplier(await fetchBalances(), supplierId);

    // Counted once, not twice: the balance falls by 80, not 160.
    expect(paidOf(supplier)).toBeCloseTo(80, 2);
    expect(balanceOf(supplier)).toBeCloseTo(120, 2);
  });

  it("ignores a provisional voucher entirely", async () => {
    const supplierId = await makeSupplier("Provisional");
    await makeContainer(supplierId);
    await makeSupplierVoucher(supplierId, { amount: "90", voucherNumber: "DRAFT1", optional: true });

    const supplier = findSupplier(await fetchBalances(), supplierId);

    // A draft must not settle anything.
    expect(paidOf(supplier)).toBeCloseTo(0, 2);
    expect(balanceOf(supplier)).toBeCloseTo(200, 2);
    expect(supplier.fxUnresolved).toBe(false);
  });

  it("excludes an unresolvable-currency payment and flags the supplier instead of guessing", async () => {
    const supplierId = await makeSupplier("UnresolvedFx");
    await makeContainer(supplierId);
    // Non-USD voucher with no usable stored rate: counting it at 1 would wrongly
    // settle 100 of the 200 owed.
    await makeSupplierVoucher(supplierId, {
      amount: "100",
      voucherNumber: "AUDPAY",
      currency: "AUD",
      exchangeRate: null as unknown as string,
    });

    const supplier = findSupplier(await fetchBalances(), supplierId);

    expect(paidOf(supplier)).toBeCloseTo(0, 2);
    expect(balanceOf(supplier)).toBeCloseTo(200, 2);
    expect(supplier.fxUnresolved).toBe(true);
  });

  it("puts a post-offload charge on the supplier only when the charge names one", async () => {
    const namedSupplier = await makeSupplier("ChargeNamed");
    const unnamedSupplier = await makeSupplier("ChargeUnnamed");
    const namedContainer = await makeContainer(namedSupplier);
    const unnamedContainer = await makeContainer(unnamedSupplier);

    await pool.query(
      `INSERT INTO factory_offload_additional_charges
         (company_id, container_id, supplier_id, description, amount, currency_code, fx_rate_to_usd, fx_rate_date)
       VALUES ($1, $2, $3, 'Named charge', '40', 'USD', '1', '2026-06-12')`,
      [ctx.companyId, namedContainer, namedSupplier]
    );
    // supplier_id NULL — posted to a ledger account, belongs to nobody's balance.
    await pool.query(
      `INSERT INTO factory_offload_additional_charges
         (company_id, container_id, supplier_id, description, amount, currency_code, fx_rate_to_usd, fx_rate_date)
       VALUES ($1, $2, NULL, 'Ledger charge', '40', 'USD', '1', '2026-06-12')`,
      [ctx.companyId, unnamedContainer]
    );

    const rows = await fetchBalances();
    const named = findSupplier(rows, namedSupplier);
    const unnamed = findSupplier(rows, unnamedSupplier);

    expect(balanceOf(named)).toBeCloseTo(240, 2);
    expect(balanceOf(unnamed)).toBeCloseTo(200, 2);
  });

  it("ignores soft-deleted containers", async () => {
    const supplierId = await makeSupplier("Deleted");
    await makeContainer(supplierId);
    await makeContainer(supplierId, { deleted: true });

    const supplier = findSupplier(await fetchBalances(), supplierId);

    expect(supplier.totalContainers).toBe(1);
    expect(balanceOf(supplier)).toBeCloseTo(200, 2);
  });

  it("only counts not-yet-arrived containers when includeOtw is asked for", async () => {
    // Note the flag is spelled "includeOtw" but the statuses it admits are
    // PENDING and IN_TRANSIT — there is no status literally named OTW here.
    const supplierId = await makeSupplier("Otw");
    await makeContainer(supplierId, { status: "OFFLOADED" });
    await makeContainer(supplierId, { status: "IN_TRANSIT", ratePerKg: "1.000000", receivedKg: "50.000" });

    const without = findSupplier(await fetchBalances(), supplierId);
    const withOtw = findSupplier(await fetchBalances("?includeOtw=true"), supplierId);

    // The in-transit container is invisible by default and adds its 50.00 when asked for.
    expect(balanceOf(without)).toBeCloseTo(200, 2);
    expect(balanceOf(withOtw)).toBeCloseTo(250, 2);
    expect(without.totalContainers).toBe(2);
  });

  it("treats a PENDING container the same way as an in-transit one", async () => {
    const supplierId = await makeSupplier("Pending");
    await makeContainer(supplierId, { status: "PENDING", ratePerKg: "4.000000", receivedKg: "25.000" });

    expect(balanceOf(findSupplier(await fetchBalances(), supplierId))).toBeCloseTo(0, 2);
    expect(balanceOf(findSupplier(await fetchBalances("?includeOtw=true"), supplierId))).toBeCloseTo(100, 2);
  });

  it("does not list another company's suppliers", async () => {
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, base_currency, company_type)
       VALUES ($1, $2, 'USD', 'factory') RETURNING id`,
      [`${TEST_PREFIX.slice(0, 4).toUpperCase()}FGN`, `${TEST_PREFIX}_ForeignCompany`]
    );
    const foreignCompanyId = foreign.rows[0].id;
    const foreignSupplier = await pool.query<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
      [foreignCompanyId, `${TEST_PREFIX} Foreign Supplier`]
    );

    try {
      const rows = await fetchBalances();
      expect(rows.some((row) => row.id === foreignSupplier.rows[0].id)).toBe(false);
    } finally {
      await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [foreignCompanyId]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
    }
  });
});
