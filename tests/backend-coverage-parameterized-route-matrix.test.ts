/**
 * Phase 1 backend coverage — parameterized route matrix.
 *
 * The existing API smoke sweep protects parameterless GET routes and the
 * authenticated write-safety sweep protects sensitive writes that would
 * otherwise be guard-only. The remaining broad blind spot is parameterized
 * routes: a route can register correctly and still throw as soon as its id,
 * reference, date, or other path parameter is parsed.
 *
 * This suite executes every parameterized /api route through the real Express
 * app as an authenticated Developer in the correct company mode. It uses
 * guaranteed-missing ids/references (and valid date-like parameters), so write
 * routes must reject without mutating accounting or inventory state. This is
 * deliberately behavioural coverage: requests pass through the real auth,
 * permission, tenant, parsing, query, and handler layers, and the test verifies
 * both liveness and state preservation.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type CompanyMode = "erp" | "factory" | "properties" | "supplier_partner";
type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

type Manifest = { routes: string[] };
type MatrixRoute = { method: HttpMethod; path: string };

type SensitiveFingerprint = {
  voucher_count: string;
  debit_total: string;
  credit_total: string;
  inventory_count: string;
  inventory_qty: string;
  inventory_value: string;
  raw_stock_count: string;
  raw_stock_received: string;
  raw_stock_used: string;
  bale_count: string;
};

const TEST_PREFIX = "covp1";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = "2147483001";
const MISSING_REFERENCE = `${TEST_PREFIX}-definitely-missing`;
const REQUEST_TIMEOUT_MS = 15000;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /(export|download|template)/i,
  /\.(xlsx|pdf|csv|zip)$/i,
  /^\/api\/auth\//i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
let parentCompanyId: number;
let companySequence = 0;
let companies: Record<CompanyMode, number>;
let routes: MatrixRoute[] = [];
let failures: Array<{ route: string; status: number; detail: string }> = [];
let beforeFingerprints: Record<CompanyMode, SensitiveFingerprint>;

function modeForPath(routePath: string): CompanyMode {
  if (routePath.startsWith("/api/sp/")) return "supplier_partner";
  if (routePath.startsWith("/api/factory/")) return "factory";
  if (routePath.startsWith("/api/properties/")) return "properties";
  return "erp";
}

function isHttpMethod(value: string): value is HttpMethod {
  return value === "DELETE" || value === "GET" || value === "PATCH" || value === "POST" || value === "PUT";
}

export function selectParameterizedApiRoutes(manifest: Manifest): MatrixRoute[] {
  const seen = new Set<string>();
  const selected: MatrixRoute[] = [];

  for (const entry of manifest.routes) {
    const firstSpace = entry.indexOf(" ");
    if (firstSpace <= 0) continue;
    const method = entry.slice(0, firstSpace);
    const routePath = entry.slice(firstSpace + 1);
    if (!isHttpMethod(method)) continue;
    if (!routePath.startsWith("/api/")) continue;
    if (!routePath.includes(":")) continue;
    if (routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;

    const key = `${method} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ method, path: routePath });
  }

  return selected;
}

export function materializeCoveragePath(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (name.includes("date")) return "2026-08-08";
    if (name.includes("year")) return "2026";
    if (name.includes("month")) return "8";
    if (name.includes("day")) return "8";
    if (name.includes("type")) return "unknown";
    if (name.includes("status")) return "unknown";
    if (name.includes("currency")) return "USD";
    if (name.includes("reference") || name.includes("ref") || name.includes("code") || name.includes("name")) {
      return encodeURIComponent(MISSING_REFERENCE);
    }
    return MISSING_ID;
  });
}

function requestFor(method: HttpMethod, routePath: string) {
  switch (method) {
    case "DELETE":
      return agent.delete(routePath);
    case "GET":
      return agent.get(routePath);
    case "PATCH":
      return agent.patch(routePath);
    case "POST":
      return agent.post(routePath);
    case "PUT":
      return agent.put(routePath);
  }
}

function poisonBody(companyId: number) {
  return {
    companyId,
    id: Number(MISSING_ID),
    parentCompanyId: "__INVALID__",
    confirm: false,
    confirmed: false,
    confirmation: "__PHASE1_COVERAGE_DO_NOT_APPLY__",
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
    quantity: "",
    date: "",
  };
}

async function createCompany(mode: CompanyMode, label: string): Promise<number> {
  companySequence += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, $3, $4, true, 'USD') RETURNING id`,
    [
      `${TEST_PREFIX}-${label}-${companySequence}`.slice(0, 50),
      `${TEST_PREFIX}_${label}_${companySequence}`,
      mode,
      mode === "erp" ? null : parentCompanyId || ctx.companyId,
    ]
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

async function sensitiveFingerprint(companyId: number): Promise<SensitiveFingerprint> {
  const result = await pool.query<SensitiveFingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers v WHERE v.company_id = $1) AS voucher_count,
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text
          FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = $1) AS debit_total,
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text
          FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = $1) AS credit_total,
       (SELECT COUNT(*)::text FROM inventory i WHERE i.company_id = $1) AS inventory_count,
       (SELECT COALESCE(SUM(i.quantity::numeric), 0)::text FROM inventory i WHERE i.company_id = $1) AS inventory_qty,
       (SELECT COALESCE(SUM(i.total_value::numeric), 0)::text FROM inventory i WHERE i.company_id = $1) AS inventory_value,
       (SELECT COUNT(*)::text FROM factory_raw_stock frs WHERE frs.company_id = $1 AND frs.deleted_at IS NULL) AS raw_stock_count,
       (SELECT COALESCE(SUM(frs.received_kg::numeric), 0)::text FROM factory_raw_stock frs WHERE frs.company_id = $1 AND frs.deleted_at IS NULL) AS raw_stock_received,
       (SELECT COALESCE(SUM(frs.used_kg::numeric), 0)::text FROM factory_raw_stock frs WHERE frs.company_id = $1 AND frs.deleted_at IS NULL) AS raw_stock_used,
       (SELECT COUNT(*)::text FROM factory_bales fb WHERE fb.company_id = $1) AS bale_count`,
    [companyId]
  );
  return result.rows[0];
}

async function assertAllVouchersBalanced(companyId: number): Promise<void> {
  const result = await pool.query<{ id: number; imbalance: string }>(
    `SELECT v.id,
            (COALESCE(SUM(ve.debit_amount::numeric), 0) - COALESCE(SUM(ve.credit_amount::numeric), 0))::text AS imbalance
       FROM vouchers v
       LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE v.company_id = $1 AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
      GROUP BY v.id
     HAVING ABS(COALESCE(SUM(ve.debit_amount::numeric), 0) - COALESCE(SUM(ve.credit_amount::numeric), 0)) > 0.01`,
    [companyId]
  );
  expect(result.rows, `company ${companyId} contains an unbalanced voucher after the route matrix`).toEqual([]);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

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

  parentCompanyId = await createCompany("erp", "parent");
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('parentCompanyId', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(parentCompanyId)]
  );

  companies = {
    erp: ctx.companyId,
    factory: await createCompany("factory", "factory"),
    properties: await createCompany("properties", "properties"),
    supplier_partner: await createCompany("supplier_partner", "supplier-partner"),
  };

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  routes = selectParameterizedApiRoutes(manifest);
  beforeFingerprints = {
    erp: await sensitiveFingerprint(companies.erp),
    factory: await sensitiveFingerprint(companies.factory),
    properties: await sensitiveFingerprint(companies.properties),
    supplier_partner: await sensitiveFingerprint(companies.supplier_partner),
  };
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 1 parameterized backend route matrix", () => {
  it("executes the broad parameterized API surface without unhandled server errors", async () => {
    expect(routes.length).toBeGreaterThan(250);

    let activeMode: CompanyMode | null = null;
    failures = [];

    for (const route of routes) {
      const mode = modeForPath(route.path);
      if (activeMode !== mode) {
        await selectCompany(companies[mode]);
        activeMode = mode;
      }

      const concretePath = materializeCoveragePath(route.path);
      try {
        const response = await requestFor(route.method, concretePath)
          .set("x-client-date", "2026-08-08")
          .send(poisonBody(companies[mode]))
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });

        if (response.status >= 500) {
          failures.push({
            route: `${route.method} ${route.path}`,
            status: response.status,
            detail:
              (response.body as { message?: string; error?: string } | undefined)?.message ||
              (response.body as { message?: string; error?: string } | undefined)?.error ||
              response.text?.slice(0, 200) ||
              "",
          });
        }
      } catch (error) {
        const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
        failures.push({
          route: `${route.method} ${route.path}`,
          status: timedOut ? 598 : 599,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const report = failures
      .map((failure) => `  ${failure.status} ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} parameterized route(s) failed the matrix:\n${report}`).toEqual([]);
  }, 300000);

  it("preserves accounting and inventory state across missing-resource write paths", async () => {
    for (const [mode, companyId] of Object.entries(companies) as [CompanyMode, number][]) {
      expect(await sensitiveFingerprint(companyId), `${mode} sensitive state changed`).toEqual(beforeFingerprints[mode]);
      await assertAllVouchersBalanced(companyId);
    }
  });
});
