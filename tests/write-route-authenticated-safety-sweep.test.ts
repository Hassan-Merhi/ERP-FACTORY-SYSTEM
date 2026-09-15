/**
 * Authenticated behavioural sweep over the sensitive write routes that were
 * previously covered only by the unauthenticated guard sweep.
 *
 * WRITE_ROUTE_AUTHENTICATED_SAFETY_SWEEP_V1
 *
 * Why this is behavioural coverage rather than another route-name sweep:
 * - every current guard-only sensitive route is invoked through the real app as
 *   an authenticated Developer in the correct company mode;
 * - parameterised routes receive a guaranteed-missing resource;
 * - parameterless routes receive a poison/dry-run body on an isolated company;
 * - every call must leave vouchers, inventory, raw stock, bales and ledger
 *   accounts unchanged, even when the route reports a validation/security error;
 * - after every call, every live voucher in the selected company must still be
 *   balanced;
 * - sentinel vouchers in untouched ERP, Factory, Properties and Supplier
 *   Partner companies must survive the entire sweep unchanged, catching
 *   cross-company leakage.
 *
 * Deep positive-path tests remain the source of truth for exact journal legs,
 * quantities and lifecycle transitions. This file closes the broad gap that
 * existed between "rejects anonymous callers" and "has any authenticated write
 * behaviour exercised at all" without making production data in the sweep.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { auditWriteRouteCoverage } from "../scripts/audit-write-route-coverage.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "wrsafe";
const MISSING_ID = "2147483646";
const MISSING_REFERENCE = `${TEST_PREFIX}-missing-reference`;

type CompanyMode = "erp" | "factory" | "properties" | "supplier_partner";
type WriteMethod = "DELETE" | "PATCH" | "POST" | "PUT";

type RouteUnderTest = {
  method: WriteMethod;
  path: string;
  owner: string | null;
  sensitiveTable: string | null;
};

type Fingerprint = {
  voucher_count: string;
  voucher_debits: string;
  voucher_credits: string;
  ledger_account_count: string;
  inventory_count: string;
  inventory_qty: string;
  inventory_value: string;
  raw_stock_count: string;
  raw_stock_received: string;
  raw_stock_used: string;
  bale_count: string;
  sales_item_count: string;
};

let ctx: TestContext;
let agent: request.SuperAgentTest;
let parentCompanyId: number;
let stableCompanies: Record<CompanyMode, number>;
let parameterlessCompanies: Record<CompanyMode, number>;
let controlCompanies: Record<CompanyMode, number>;
let controlBefore: Record<CompanyMode, Fingerprint>;
let companySequence = 0;

function modeForPath(path: string): CompanyMode {
  if (path.startsWith("/api/sp/")) return "supplier_partner";
  if (path.startsWith("/api/factory/")) return "factory";
  if (path.startsWith("/api/properties/")) return "properties";
  return "erp";
}

function hasPathParams(path: string): boolean {
  return /(^|\/)\:[^/]+/.test(path);
}

function materializePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    if (/reference/i.test(name)) return encodeURIComponent(MISSING_REFERENCE);
    if (/type/i.test(name)) return "bales";
    return MISSING_ID;
  });
}

function requestFor(method: WriteMethod, path: string) {
  switch (method) {
    case "DELETE":
      return agent.delete(path);
    case "PATCH":
      return agent.patch(path);
    case "POST":
      return agent.post(path);
    case "PUT":
      return agent.put(path);
  }
}

async function createCompany(mode: CompanyMode, label: string): Promise<number> {
  companySequence += 1;
  const code = `${TEST_PREFIX}-${label}-${companySequence}`.slice(0, 50);
  const name = `${TEST_PREFIX}_${label}_${companySequence}`;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, $3, $4, true, 'USD') RETURNING id`,
    [code, name, mode, mode === "erp" ? null : parentCompanyId || ctx.companyId]
  );
  const companyId = result.rows[0].id;

  await pool.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, 'Developer', true, true)`,
    [ctx.userId, companyId]
  );
  await pool.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     SELECT user_id, $2, permission, granted_by
       FROM user_security_permissions
      WHERE user_id = $1 AND company_id = $3
     ON CONFLICT (user_id, company_id, permission) DO NOTHING`,
    [ctx.userId, companyId, ctx.companyId]
  );
  return companyId;
}

async function selectCompany(companyId: number): Promise<void> {
  const response = await agent.post("/api/auth/set-company").send({ companyId });
  expect(response.status, `set-company ${companyId}`).toBe(200);
}

async function sensitiveFingerprint(companyId: number): Promise<Fingerprint> {
  const result = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers v WHERE v.company_id = $1) AS voucher_count,
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text
          FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = $1) AS voucher_debits,
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text
          FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = $1) AS voucher_credits,
       (SELECT COUNT(*)::text FROM ledger_accounts la WHERE la.company_id = $1) AS ledger_account_count,
       (SELECT COUNT(*)::text FROM inventory i WHERE i.company_id = $1) AS inventory_count,
       (SELECT COALESCE(SUM(i.quantity::numeric), 0)::text FROM inventory i WHERE i.company_id = $1) AS inventory_qty,
       (SELECT COALESCE(SUM(i.total_value::numeric), 0)::text FROM inventory i WHERE i.company_id = $1) AS inventory_value,
       (SELECT COUNT(*)::text FROM factory_raw_stock frs WHERE frs.company_id = $1 AND frs.deleted_at IS NULL) AS raw_stock_count,
       (SELECT COALESCE(SUM(frs.received_kg::numeric), 0)::text FROM factory_raw_stock frs WHERE frs.company_id = $1 AND frs.deleted_at IS NULL) AS raw_stock_received,
       (SELECT COALESCE(SUM(frs.used_kg::numeric), 0)::text FROM factory_raw_stock frs WHERE frs.company_id = $1 AND frs.deleted_at IS NULL) AS raw_stock_used,
       (SELECT COUNT(*)::text FROM factory_bales fb WHERE fb.company_id = $1) AS bale_count,
       (SELECT COUNT(*)::text
          FROM sales_items si JOIN vouchers v ON v.id = si.voucher_id
         WHERE v.company_id = $1) AS sales_item_count`,
    [companyId]
  );
  return result.rows[0];
}

async function expectBalancedVouchers(companyId: number, route: RouteUnderTest): Promise<void> {
  const unbalanced = await pool.query<{ id: number; imbalance: string }>(
    `SELECT v.id,
            (COALESCE(SUM(ve.debit_amount::numeric), 0) - COALESCE(SUM(ve.credit_amount::numeric), 0))::text AS imbalance
       FROM vouchers v
       LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
      GROUP BY v.id
     HAVING ABS(COALESCE(SUM(ve.debit_amount::numeric), 0) - COALESCE(SUM(ve.credit_amount::numeric), 0)) > 0.01`,
    [companyId]
  );
  expect(unbalanced.rows, `${route.method} ${route.path} left an unbalanced voucher`).toEqual([]);
}

async function seedControlVoucher(companyId: number, label: string): Promise<void> {
  const account = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, $3, 'Cash', '0', 'Dr', true) RETURNING id`,
    [companyId, `${TEST_PREFIX}-${label}-CTL`.slice(0, 50), `${TEST_PREFIX} ${label} control`]
  );
  const voucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers
       (company_id, voucher_number, voucher_type, voucher_date, description,
        total_amount, currency, source_module, optional)
     VALUES ($1, $2, 'Journal', '2026-08-08', $3, '1', 'USD', 'ERP', false)
     RETURNING id`,
    [companyId, `${TEST_PREFIX}-${label}-V`, `${TEST_PREFIX} isolation sentinel`]
  );
  await pool.query(
    `INSERT INTO voucher_entries
       (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, '1', '0', $3), ($1, $2, '0', '1', $3)`,
    [voucher.rows[0].id, account.rows[0].id, `${TEST_PREFIX} isolation sentinel`]
  );
}

function poisonBody(companyId: number) {
  return {
    companyId,
    // Some global settings treat an omitted value as an instruction to clear
    // it. Supplying a deliberately non-numeric value makes that path fail
    // validation instead of changing the repository-wide parent-company pin.
    parentCompanyId: "__INVALID__",
    confirm: false,
    confirmed: false,
    confirmation: "__WRITE_SAFETY_SWEEP_DO_NOT_APPLY__",
    confirmationToken: "__INVALID__",
    dryRun: true,
    apply: false,
    execute: false,
    force: false,
    ids: [],
    voucherIds: [],
    containerIds: [],
    rows: [],
    items: [],
    charges: [],
    bales: [],
    amount: "",
    date: "",
  };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  // Developer is the strongest application role: requireRole explicitly lets it
  // through every role-specific guard while still using the normal auth stack.
  await pool.query(
    `UPDATE user_company_roles
        SET role = 'Developer', can_delete_records = true, can_sell_negative_stock = true
      WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId]
  );

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  await selectCompany(ctx.companyId);

  // Keep inter-company side effects away from the ERP fixture used by the
  // sweep. Factory/SP routes that legitimately post against a parent resolve to
  // this dedicated parent instead.
  parentCompanyId = await createCompany("erp", "parent");
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('parentCompanyId', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(parentCompanyId)]
  );

  stableCompanies = {
    erp: ctx.companyId,
    factory: await createCompany("factory", "stable-factory"),
    properties: await createCompany("properties", "stable-properties"),
    supplier_partner: await createCompany("supplier_partner", "stable-sp"),
  };
  // Parameterless writes get their own isolated empty company so they cannot
  // contaminate the stable missing-resource fixtures. Reuse one per mode: the
  // sweep requires every call to leave the sensitive fingerprint unchanged, so
  // creating one company per route would add teardown cost without extra safety.
  parameterlessCompanies = {
    erp: await createCompany("erp", "parameterless-erp"),
    factory: await createCompany("factory", "parameterless-factory"),
    properties: await createCompany("properties", "parameterless-properties"),
    supplier_partner: await createCompany("supplier_partner", "parameterless-sp"),
  };
  controlCompanies = {
    erp: await createCompany("erp", "control-erp"),
    factory: await createCompany("factory", "control-factory"),
    properties: await createCompany("properties", "control-properties"),
    supplier_partner: await createCompany("supplier_partner", "control-sp"),
  };

  for (const [mode, companyId] of Object.entries(controlCompanies) as [CompanyMode, number][]) {
    await seedControlVoucher(companyId, mode);
  }
  controlBefore = {
    erp: await sensitiveFingerprint(controlCompanies.erp),
    factory: await sensitiveFingerprint(controlCompanies.factory),
    properties: await sensitiveFingerprint(controlCompanies.properties),
    supplier_partner: await sensitiveFingerprint(controlCompanies.supplier_partner),
  };
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe("authenticated sensitive write safety sweep", () => {
  it("exercises every route that would otherwise be guard-only without mutating sensitive state", async () => {
    // Disable recognition of this file while deriving the inventory it has to
    // execute; otherwise the audit would (correctly) report zero guard-only
    // routes after seeing the V1 marker above.
    const raw = auditWriteRouteCoverage({ includeAuthenticatedSafetySweep: false });
    const routes = raw.guardOnlySensitive as RouteUnderTest[];
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const mode = modeForPath(route.path);
      const parameterised = hasPathParams(route.path);
      const companyId = parameterised ? stableCompanies[mode] : parameterlessCompanies[mode];
      await selectCompany(companyId);

      const before = await sensitiveFingerprint(companyId);
      const concretePath = materializePath(route.path);
      const response = await requestFor(route.method, concretePath)
        .set("x-client-date", "2026-08-08")
        .send(poisonBody(companyId));

      expect(
        response.status,
        `${route.method} ${route.path} returned ${response.status}: ${response.text}`
      ).toBeLessThan(500);
      expect(response.status, `${route.method} ${route.path} lost its authenticated session`).not.toBe(401);

      const after = await sensitiveFingerprint(companyId);
      expect(after, `${route.method} ${route.path} mutated sensitive state during the safety sweep`).toEqual(before);
      await expectBalancedVouchers(companyId, route);
    }

    // A write in one company must never reach an unrelated tenant. The
    // sentinels cover every company mode exercised by the sweep.
    expect(await sensitiveFingerprint(controlCompanies.erp)).toEqual(controlBefore.erp);
    expect(await sensitiveFingerprint(controlCompanies.factory)).toEqual(controlBefore.factory);
    expect(await sensitiveFingerprint(controlCompanies.properties)).toEqual(controlBefore.properties);
    expect(await sensitiveFingerprint(controlCompanies.supplier_partner)).toEqual(controlBefore.supplier_partner);
  }, 300000);
});
