/**
 * Behavioural coverage for `PATCH /api/factory/containers/:id`
 * (`server/routes/factory/containers/update.ts`).
 *
 * This route was 0.5% covered. It is the single edit path for a factory
 * container, and almost everything expensive about a container is decided here:
 * which FX rate its landed cost is computed at, whether its commission is
 * convertible, and who is on the hook for its freight.
 *
 * The properties worth holding:
 *
 *   - **A partial PATCH is partial.** The handler rebuilds the row from a
 *     whitelist, so any field the request omits must keep its stored value. The
 *     dangerous failure is a date-only edit (the CSV ETA import sends exactly
 *     that) silently clearing freight or re-resolving FX.
 *   - **FX is never silently guessed.** `auto` fetches and marks the rate
 *     confirmed; `manual` trusts a rate supplied in the request, otherwise
 *     carries forward an already-confirmed one, and refuses outright rather
 *     than defaulting to 1 when neither exists.
 *   - **Commission FX resolves against the right currency.** USD is 1;
 *     a commission in the container's own currency rides the container rate,
 *     and is refused when that rate is not set; zeroing the commission clears
 *     the FX fields rather than leaving them stale.
 *   - **Freight payer fields are canonical.** Switching own ↔ supplier must
 *     never leave a value in the opposing field, and zero freight clears both.
 *   - **Containers are company-scoped.** Another tenant's container is not
 *     found, not edited.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "fcupd";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let freightAccountId: number;
let ownAccountId: number;
let seq = 0;

interface ContainerSeed {
  currencyCode?: string;
  fxRateToUsd?: string | null;
  fxRateConfirmed?: boolean;
  ratePerKg?: string | null;
  freight?: string;
  freightPaidBy?: string | null;
  freightSupplierId?: number | null;
  freightOwnAccountId?: number | null;
  freightAccountId?: number | null;
  commissionAmount?: string;
  commissionCurrencyCode?: string | null;
  supplierId?: number | null;
  companyId?: number;
}

async function seedContainer(overrides: ContainerSeed = {}) {
  seq += 1;
  const row = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, status, arrival_date, freight, freight_paid_by,
        freight_supplier_id, freight_own_account_id, freight_account_id,
        commission_amount, commission_currency_code)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, 'PENDING', '2026-06-08', $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      overrides.companyId ?? ctx.companyId,
      `${TEST_PREFIX}-C${seq}`,
      overrides.supplierId === undefined ? supplierId : overrides.supplierId,
      overrides.currencyCode ?? "USD",
      overrides.fxRateToUsd === undefined ? "1" : overrides.fxRateToUsd,
      overrides.fxRateConfirmed ?? true,
      overrides.ratePerKg ?? "2.000000",
      overrides.freight ?? "0",
      overrides.freightPaidBy ?? "supplier",
      overrides.freightSupplierId ?? null,
      overrides.freightOwnAccountId ?? null,
      overrides.freightAccountId ?? null,
      overrides.commissionAmount ?? "0",
      overrides.commissionCurrencyCode ?? null,
    ]
  );
  return row.rows[0].id;
}

/** Postgres date columns arrive as Date objects; compare them as ISO days. */
function isoDate(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
}

async function containerRow(id: number) {
  const result = await pool.query(`SELECT * FROM factory_containers WHERE id = $1`, [id]);
  return result.rows[0];
}

async function patchContainer(id: number, body: Record<string, unknown>) {
  return agent.patch(`/api/factory/containers/${id}`).send(body);
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

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name, is_active)
     VALUES ($1, $2, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Supplier`]
  );
  supplierId = supplier.rows[0].id;

  const accounts = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, $3, 'Expense', '0', 'Dr', true), ($1, $4, $5, 'Cash', '0', 'Dr', true)
     RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}_FRT`, `${TEST_PREFIX} Freight`, `${TEST_PREFIX}_OWNCASH`, `${TEST_PREFIX} Own Cash`]
  );
  freightAccountId = accounts.rows[0].id;
  ownAccountId = accounts.rows[1].id;

  // A manual FX row takes priority in getOrFetchFxRateToUsd, so the auto path
  // resolves deterministically without reaching for a network rate provider.
  await pool.query(
    `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
     VALUES ($1, 'EUR', '1.20000000', '2026-06-08', 'manual')`,
    [ctx.companyId]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_fx_rates WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("PATCH /api/factory/containers/:id — scoping and validation", () => {
  it("rejects a non-numeric id", async () => {
    const response = await agent.patch("/api/factory/containers/not-a-number").send({ notes: "x" });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Invalid id/i);
  });

  it("does not find, or edit, a container belonging to another company", async () => {
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, base_currency, company_type)
       VALUES ($1, $2, 'USD', 'factory') RETURNING id`,
      [`${TEST_PREFIX.slice(0, 4).toUpperCase()}FGN`, `${TEST_PREFIX}_ForeignCompany`]
    );
    const foreignCompanyId = foreign.rows[0].id;
    const foreignContainer = await seedContainer({ companyId: foreignCompanyId, supplierId: null });

    try {
      const response = await patchContainer(foreignContainer, { notes: "cross-tenant edit" });
      expect(response.status).toBe(404);

      const after = await containerRow(foreignContainer);
      expect(after.notes).toBeNull();
    } finally {
      await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [foreignCompanyId]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
    }
  });

  it("returns 404 for a container that does not exist", async () => {
    expect((await patchContainer(99999999, { notes: "x" })).status).toBe(404);
  });
});

describe("PATCH /api/factory/containers/:id — partial updates", () => {
  it("leaves every omitted field untouched on a notes-only edit", async () => {
    const id = await seedContainer({
      freight: "500",
      freightPaidBy: "supplier",
      freightSupplierId: supplierId,
      freightAccountId,
      ratePerKg: "3.000000",
    });
    const before = await containerRow(id);

    const response = await patchContainer(id, { notes: "just a note" });
    expect(response.status).toBe(200);

    const after = await containerRow(id);
    expect(after.notes).toBe("just a note");
    // The fields the request never mentioned are exactly as they were.
    expect(after.freight).toBe(before.freight);
    expect(after.freight_paid_by).toBe(before.freight_paid_by);
    expect(after.freight_supplier_id).toBe(before.freight_supplier_id);
    expect(after.rate_per_kg).toBe(before.rate_per_kg);
    expect(after.currency_code).toBe(before.currency_code);
    expect(after.fx_rate_to_usd).toBe(before.fx_rate_to_usd);
  });

  it("does not re-resolve FX for a date-only edit", async () => {
    // The CSV ETA import sends only arrivalDate. On a EUR container with
    // freight but no confirmed rate, re-resolving here used to 400 the import.
    const id = await seedContainer({
      currencyCode: "EUR",
      fxRateToUsd: "1",
      fxRateConfirmed: false,
      freight: "250",
      freightPaidBy: "supplier",
      freightSupplierId: supplierId,
      freightAccountId,
    });

    const response = await patchContainer(id, { arrivalDate: "2026-07-01" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(isoDate(after.arrival_date)).toBe("2026-07-01");
    expect(after.fx_rate_confirmed).toBe(false);
    expect(after.freight).toBe("250.00");
  });

  it("accepts clearing an ETA with JSON null without storing the string null", async () => {
    const id = await seedContainer();

    const response = await patchContainer(id, { arrivalDate: null });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(after.arrival_date).toBeNull();
  });

  it("coerces empty strings to null rather than storing them", async () => {
    const id = await seedContainer();

    const response = await patchContainer(id, { origin: "", destination: "Beirut", notes: "" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(after.origin).toBeNull();
    expect(after.notes).toBeNull();
    expect(after.destination).toBe("Beirut");
  });
});

describe("PATCH /api/factory/containers/:id — exchange rates", () => {
  it("auto mode resolves the rate, marks it confirmed, and converts the per-kg rate", async () => {
    const id = await seedContainer({ currencyCode: "USD", ratePerKg: "2.000000" });

    const response = await patchContainer(id, {
      currencyCode: "EUR",
      fxRateSource: "auto",
      ratePerKg: "2.5",
      arrivalDate: "2026-06-08",
    });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(after.currency_code).toBe("EUR");
    expect(Number(after.fx_rate_to_usd)).toBeCloseTo(1.2, 8);
    expect(Number(after.fx_rate_to_usd_import)).toBeCloseTo(1.2, 8);
    expect(isoDate(after.fx_rate_date_import)).toBe("2026-06-08");
    expect(after.fx_rate_source).toBe("auto");
    // An actual fetch, not a default — the flag is what other code trusts.
    expect(after.fx_rate_confirmed).toBe(true);
    // 2.5 EUR/kg at 1.2 USD per EUR = 3.00 USD/kg.
    expect(Number(after.rate_per_kg_usd)).toBeCloseTo(3, 6);
  });

  it("manual mode trusts a rate supplied in the request and marks it confirmed", async () => {
    const id = await seedContainer({ currencyCode: "USD", fxRateConfirmed: false, ratePerKg: "4.000000" });
    // Phase 19 C (M2): a manual rate is accepted where a recorded dated AUD rate exists.
    await pool.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source)
       VALUES ($1, 'AUD', '0.66000000', '2020-01-01', 'manual')`,
      [ctx.companyId]
    );

    const response = await patchContainer(id, {
      currencyCode: "AUD",
      fxRateSource: "manual",
      fxRateToUsd: "0.65",
      ratePerKg: "4",
    });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(Number(after.fx_rate_to_usd)).toBeCloseTo(0.65, 8);
    expect(after.fx_rate_source).toBe("manual");
    expect(after.fx_rate_confirmed).toBe(true);
    expect(Number(after.rate_per_kg_usd)).toBeCloseTo(2.6, 6);
  });

  it("manual mode refuses rather than defaulting to 1 when no rate is available", async () => {
    const id = await seedContainer({ currencyCode: "USD", fxRateToUsd: "1", fxRateConfirmed: false });

    const response = await patchContainer(id, { currencyCode: "AUD", fxRateSource: "manual", ratePerKg: "4" });

    expect(response.status).toBe(400);
    const after = await containerRow(id);
    // Nothing was written — the container is still USD.
    expect(after.currency_code).toBe("USD");
    expect(after.rate_per_kg_usd).toBeNull();
  });

  it("manual mode carries forward an already-confirmed stored rate", async () => {
    const id = await seedContainer({
      currencyCode: "AUD",
      fxRateToUsd: "0.70000000",
      fxRateConfirmed: true,
      ratePerKg: "10.000000",
    });

    // Resubmitting unchanged goods fields is a deliberate no-op (#2322), so
    // change the rate to make the route reprice with the carried-forward FX.
    const response = await patchContainer(id, { fxRateSource: "manual", ratePerKg: "12" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(Number(after.fx_rate_to_usd)).toBeCloseTo(0.7, 8);
    expect(Number(after.rate_per_kg_usd)).toBeCloseTo(8.4, 6);
  });
});

describe("PATCH /api/factory/containers/:id — commission FX", () => {
  it("resolves a USD commission at parity", async () => {
    const id = await seedContainer();

    const response = await patchContainer(id, { commissionAmount: "150", commissionCurrencyCode: "USD" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(Number(after.commission_fx_rate_to_usd)).toBeCloseTo(1, 8);
    expect(after.commission_fx_rate_confirmed).toBe(true);
  });

  it("rides the container's own rate when the commission shares its currency", async () => {
    const id = await seedContainer({ currencyCode: "AUD", fxRateToUsd: "0.66000000", fxRateConfirmed: true });

    const response = await patchContainer(id, { commissionAmount: "200", commissionCurrencyCode: "AUD" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(Number(after.commission_fx_rate_to_usd)).toBeCloseTo(0.66, 8);
  });

  it("refuses a same-currency commission when the container rate is zero", async () => {
    const id = await seedContainer({ currencyCode: "AUD", fxRateToUsd: "0", fxRateConfirmed: false });

    const response = await patchContainer(id, { commissionAmount: "200", commissionCurrencyCode: "AUD" });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Cannot resolve commission FX/i);
    const after = await containerRow(id);
    // Refused before any write — the commission is still zero.
    expect(Number(after.commission_amount)).toBe(0);
  });

  it("accepts a same-currency commission on an UNCONFIRMED container rate — see note", async () => {
    // Documented gap, pinned deliberately rather than asserted as desirable.
    //
    // The guard reads `if (!containerFxNum || containerFxNum <= 0)` but its
    // message says "container FX rate is not confirmed". It tests the *value*,
    // not `fx_rate_confirmed`. `fx_rate_to_usd` is NOT NULL and defaults to
    // '1', so an unresolved AUD container carries a placeholder 1 that passes
    // this check — and the commission converts 1:1 in silence, while the
    // container's own FX path (resolveStoredFxRate, which does consult
    // fx_rate_confirmed) would refuse the very same row.
    //
    // Change the guard to check fx_rate_confirmed and this test should be
    // updated to expect 400.
    const id = await seedContainer({ currencyCode: "AUD", fxRateToUsd: "1", fxRateConfirmed: false });

    const response = await patchContainer(id, { commissionAmount: "200", commissionCurrencyCode: "AUD" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(Number(after.commission_fx_rate_to_usd)).toBeCloseTo(1, 8);
    // The container itself is still an unconfirmed rate.
    expect(after.fx_rate_confirmed).toBe(false);
  });

  it("clears the commission FX fields when the commission is zeroed out", async () => {
    const id = await seedContainer();
    expect((await patchContainer(id, { commissionAmount: "90", commissionCurrencyCode: "USD" })).status).toBe(200);
    expect(Number((await containerRow(id)).commission_fx_rate_to_usd)).toBeCloseTo(1, 8);

    const response = await patchContainer(id, { commissionAmount: "0" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(after.commission_fx_rate_to_usd).toBeNull();
    expect(after.commission_fx_rate_confirmed).toBe(false);
    expect(after.commission_fx_rate_date).toBeNull();
  });
});

describe("PATCH /api/factory/containers/:id — freight payer canonicalisation", () => {
  it("clears both payer fields when freight goes to zero", async () => {
    const id = await seedContainer({
      freight: "300",
      freightPaidBy: "supplier",
      freightSupplierId: supplierId,
      freightAccountId,
    });

    const response = await patchContainer(id, { freight: "0" });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(after.freight_supplier_id).toBeNull();
    expect(after.freight_own_account_id).toBeNull();
  });

  it("requires an own account for own-paid freight, and clears the supplier link once given", async () => {
    const id = await seedContainer({
      freight: "0",
      freightPaidBy: "supplier",
      freightSupplierId: supplierId,
      freightAccountId,
    });

    const refused = await patchContainer(id, { freight: "400", freightPaidBy: "own" });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/freightOwnAccountId is required/i);

    const accepted = await patchContainer(id, {
      freight: "400",
      freightPaidBy: "own",
      freightOwnAccountId: ownAccountId,
      freightAccountId,
    });
    expect(accepted.status).toBe(200);

    const after = await containerRow(id);
    expect(after.freight_own_account_id).toBe(ownAccountId);
    // Switching to own must not leave the opposing field populated.
    expect(after.freight_supplier_id).toBeNull();
  });

  it("requires an explicit freight supplier for supplier-paid freight and never defaults to the goods supplier", async () => {
    // #2245: freight is owed to its own chosen payee, never to the goods
    // supplier by fallback.
    const withSupplier = await seedContainer({
      freight: "0",
      freightPaidBy: "own",
      freightOwnAccountId: ownAccountId,
      freightAccountId,
    });
    const refused = await patchContainer(withSupplier, { freight: "200", freightPaidBy: "supplier", freightAccountId });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/select the freight supplier/i);

    const accepted = await patchContainer(withSupplier, {
      freight: "200",
      freightPaidBy: "supplier",
      freightSupplierId: supplierId,
      freightAccountId,
    });
    expect(accepted.status).toBe(200);

    const after = await containerRow(withSupplier);
    expect(after.freight_supplier_id).toBe(supplierId);
    expect(after.freight_own_account_id).toBeNull();
  });

  it("creates a freight ledger account when freight is added without one", async () => {
    const id = await seedContainer({ freight: "0", freightAccountId: null });

    const response = await patchContainer(id, {
      freight: "125",
      freightPaidBy: "supplier",
      freightCurrencyCode: "USD",
      freightSupplierId: supplierId,
    });

    expect(response.status).toBe(200);
    const after = await containerRow(id);
    expect(after.freight_account_id).not.toBeNull();

    const account = await pool.query<{ code: string; company_id: number }>(
      `SELECT code, company_id FROM ledger_accounts WHERE id = $1`,
      [after.freight_account_id]
    );
    expect(account.rows[0].company_id).toBe(ctx.companyId);
    expect(account.rows[0].code).toBe("FREIGHT");
  });
});

describe("container goods value is exact", () => {
  // 1000.5 kg at 0.35 is 350.175; the float product 350.17499999999995 was
  // stored as 350.17 in the import voucher and the daybook.
  async function importVoucherTotal(containerId: number): Promise<string> {
    const voucher = await pool.query<{ total_amount: string }>(
      `SELECT total_amount FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2`,
      [ctx.companyId, `FACTORY-IMPORT-${containerId}-%`]
    );
    return voucher.rows[0]?.total_amount;
  }
  async function importDaybookAmount(containerId: number): Promise<string> {
    const entry = await pool.query<{ amount_currency: string }>(
      `SELECT amount_currency FROM factory_daybook_entries
       WHERE company_id = $1 AND tx_type = 'CONTAINER_IMPORT' AND reference_id = $2`,
      [ctx.companyId, containerId]
    );
    return entry.rows[0]?.amount_currency;
  }

  it("answers promptly for a rate with an out-of-range exponent", async () => {
    // Formatting "1e-500000000" with toFixed() wrote out hundreds of millions of
    // zeros and hung the process; the bounded parse reads it as 0.
    seq += 1;
    const started = Date.now();
    const response = await agent.post("/api/factory/containers").send({
      containerNumber: `${TEST_PREFIX}-EXP${seq}`,
      supplierId,
      currencyCode: "USD",
      totalKg: "1000",
      ratePerKg: "1e-500000000",
      arrivalDate: "2026-06-08",
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(10000);
  }, 20000);

  it("posts the import voucher and daybook entry at the exact cents on create", async () => {
    seq += 1;
    const response = await agent.post("/api/factory/containers").send({
      containerNumber: `${TEST_PREFIX}-EXACT${seq}`,
      supplierId,
      currencyCode: "USD",
      totalKg: "1000.500",
      ratePerKg: "0.35",
      arrivalDate: "2026-06-08",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(await importVoucherTotal(response.body.id)).toBe("350.18");
    expect(await importDaybookAmount(response.body.id)).toBe("350.18");
  });

  it("re-syncs the import daybook entry at the exact cents on edit", async () => {
    seq += 1;
    const created = await agent.post("/api/factory/containers").send({
      containerNumber: `${TEST_PREFIX}-EXACT${seq}`,
      supplierId,
      currencyCode: "USD",
      totalKg: "1000",
      ratePerKg: "0.35",
      arrivalDate: "2026-06-08",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const response = await patchContainer(created.body.id, { totalKg: "1000.500" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await importDaybookAmount(created.body.id)).toBe("350.18");
  });

  it("keeps the import credit on the goods supplier when freight is owed to another supplier", async () => {
    const freightPayee = (
      await pool.query<{ id: number }>(
        `INSERT INTO factory_suppliers (company_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
        [ctx.companyId, `${TEST_PREFIX} Freight Payee`]
      )
    ).rows[0].id;
    seq += 1;
    const created = await agent.post("/api/factory/containers").send({
      containerNumber: `${TEST_PREFIX}-EXACT${seq}`,
      supplierId,
      currencyCode: "USD",
      totalKg: "1000",
      ratePerKg: "0.35",
      arrivalDate: "2026-06-08",
      freight: "90",
      freightPaidBy: "supplier",
      freightSupplierId: freightPayee,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const response = await patchContainer(created.body.id, { totalKg: "1000.500" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const credit = await pool.query<{ factory_supplier_id: number; credit_amount: string }>(
      `SELECT ve.factory_supplier_id, ve.credit_amount FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND ve.credit_amount > 0`,
      [ctx.companyId, `FACTORY-IMPORT-${created.body.id}-%`]
    );
    expect(credit.rows).toEqual([{ factory_supplier_id: supplierId, credit_amount: "350.18" }]);
  });
});

describe("PATCH /api/factory/containers/:id — legacy missing goods-import journals", () => {
  it("saves an unrelated change when the form resubmits identical goods fields", async () => {
    const id = await seedContainer({ ratePerKg: "2.500000", supplierId });
    await pool.query("UPDATE factory_containers SET total_kg = '1200.500' WHERE id = $1", [id]);

    const response = await patchContainer(id, {
      notes: "Updated delivery instructions",
      supplierId,
      totalKg: "1200.5",
      ratePerKg: "2.5",
      currencyCode: "USD",
      fxRateSource: "manual",
      fxRateToUsd: "1",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await containerRow(id);
    expect(after.notes).toBe("Updated delivery instructions");
    expect(after.total_kg).toBe("1200.500");
    const journals = await pool.query("SELECT id FROM vouchers WHERE company_id = $1 AND voucher_number LIKE $2", [
      ctx.companyId,
      `FACTORY-IMPORT-${id}-%`,
    ]);
    expect(journals.rows).toHaveLength(0);
  });

  it("does not revalue historical FX for a full-form ETA-only edit", async () => {
    const id = await seedContainer({
      currencyCode: "EUR",
      ratePerKg: "3",
      fxRateToUsd: "1.17000000",
      fxRateConfirmed: true,
    });
    await pool.query("UPDATE factory_containers SET total_kg = '200', fx_rate_source = 'auto' WHERE id = $1", [id]);
    const response = await patchContainer(id, {
      arrivalDate: "2026-07-01",
      supplierId,
      totalKg: "200.000",
      ratePerKg: "3.000",
      currencyCode: "EUR",
      fxRateSource: "auto",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await containerRow(id);
    expect(isoDate(after.arrival_date)).toBe("2026-07-01");
    expect(after.fx_rate_to_usd).toBe("1.17000000");
  });

  it("does not silently create historical freight or commission payables from unchanged form fields", async () => {
    const id = await seedContainer({
      freight: "125",
      freightAccountId,
      freightPaidBy: "supplier",
      freightSupplierId: supplierId,
      commissionAmount: "75",
      commissionCurrencyCode: "USD",
    });
    const response = await patchContainer(id, {
      notes: "Port document received",
      supplierId,
      ratePerKg: "2",
      currencyCode: "USD",
      fxRateSource: "manual",
      fxRateToUsd: "1",
      freight: "125.00",
      freightCurrencyCode: "USD",
      freightAccountId,
      freightPaidBy: "supplier",
      freightSupplierId: supplierId,
      freightOwnAccountId: null,
      commissionAmount: "75.00",
      commissionCurrencyCode: "USD",
      commissionSupplierId: null,
      commissionAccountId: null,
      commissionNotes: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await containerRow(id)).notes).toBe("Port document received");
    const legacyJournals = await pool.query(
      "SELECT id FROM vouchers WHERE company_id = $1 AND (voucher_number LIKE $2 OR voucher_number LIKE $3)",
      [ctx.companyId, `FACTORY-FREIGHT-${id}%`, `FACTORY-COMM-${id}%`]
    );
    expect(legacyJournals.rows).toHaveLength(0);
  });

  it("still refuses an actual goods change without a reviewed original journal", async () => {
    const id = await seedContainer({ supplierId, ratePerKg: "2.500000" });
    await pool.query("UPDATE factory_containers SET total_kg = '1200' WHERE id = $1", [id]);
    const response = await patchContainer(id, {
      totalKg: "1300",
      supplierId,
      ratePerKg: "2.5",
      currencyCode: "USD",
      fxRateSource: "manual",
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no goods-import journal/i);
    const after = await containerRow(id);
    expect(after.total_kg).toBe("1200.000");
  });
});
