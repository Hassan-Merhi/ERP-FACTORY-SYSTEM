/**
 * Backend coverage — maintenance/reconciliation failure workflows.
 *
 * Broad liveness suites intentionally skip repair, recalculation, migration,
 * cutover and backfill endpoints. Those handlers contain substantial validation
 * and safety logic, so this suite exercises them only inside disposable test
 * tenants with dry-run/invalid-confirmation input and guaranteed-missing ids.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type Mode = "erp" | "factory" | "properties" | "supplier_partner";
type Method = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
type Manifest = { routes: string[] };
type RouteCase = { mode: Mode; method: Method; template: string; concrete: string };
type Failure = { route: string; status: number; detail: string };

const TEST_PREFIX = "covmaint";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = "2147483647";
const MAINTENANCE =
  /(repair|recalc|recalculate|migration|migrate|cutover|backfill|rebuild|reconciliation|diagnose|diagnostic)/i;
const EXCLUDED = /(whatsapp|email|openai|ai-|carrier|tracking|backup|restore|upload|import-excel)/i;

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companies: Record<Mode, number>;
let routes: RouteCase[] = [];
let before: Record<Mode, Record<string, string>>;
let sequence = 0;

function isSupportedMethod(value: string): value is Method {
  return value === "DELETE" || value === "GET" || value === "PATCH" || value === "POST" || value === "PUT";
}

function modeForPath(routePath: string): Mode {
  if (routePath.startsWith("/api/factory/") || routePath.startsWith("/api/factory-")) return "factory";
  if (routePath.startsWith("/api/sp/") || routePath.startsWith("/api/sp-migration/")) return "supplier_partner";
  if (routePath.startsWith("/api/properties/") || routePath.startsWith("/api/rental/")) return "properties";
  return "erp";
}

function concretePath(routePath: string): string | null {
  if (routePath.includes("*")) return null;
  return routePath.replace(/:[A-Za-z][A-Za-z0-9_]*/g, MISSING_ID);
}

export function selectMaintenanceFailureWorkflows(manifest: Manifest): RouteCase[] {
  const seen = new Set<string>();
  const selected: RouteCase[] = [];

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (!isSupportedMethod(method) || !routePath?.startsWith("/api/")) continue;
    if (!MAINTENANCE.test(routePath) || EXCLUDED.test(routePath)) continue;
    if (/^\/api\/(admin|debug|system)(\/|$)/i.test(routePath)) continue;
    const concrete = concretePath(routePath);
    if (!concrete) continue;

    const mode = modeForPath(routePath);
    const key = `${mode} ${method} ${concrete}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ mode, method, template: routePath, concrete });
  }

  return selected;
}

async function createCompany(mode: Exclude<Mode, "erp">): Promise<number> {
  sequence += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, $3, $4, true, 'USD') RETURNING id`,
    [`CMNT-${mode.slice(0, 3)}-${sequence}`, `${TEST_PREFIX}_${mode}_${sequence}`, mode, ctx.companyId]
  );
  const companyId = rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, 'Developer', true, true)`,
    [ctx.userId, companyId]
  );
  await pool.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     SELECT user_id, $2, permission, granted_by FROM user_security_permissions
     WHERE user_id = $1 AND company_id = $3
     ON CONFLICT (user_id, company_id, permission) DO NOTHING`,
    [ctx.userId, companyId, ctx.companyId]
  );
  return companyId;
}

async function fingerprint(companyId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS vouchers,
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS entries,
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS debit,
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS credit,
       (SELECT COUNT(*)::text FROM inventory WHERE company_id = $1) AS inventory_rows,
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS inventory_qty,
       (SELECT COUNT(*)::text FROM factory_raw_stock WHERE company_id = $1 AND deleted_at IS NULL) AS raw_stock,
       (SELECT COUNT(*)::text FROM factory_bales WHERE company_id = $1) AS bales,
       (SELECT COUNT(*)::text FROM sp_sales WHERE company_id = $1) AS sp_sales,
       (SELECT COUNT(*)::text FROM property_payments WHERE company_id = $1) AS property_payments`,
    [companyId]
  );
  return rows[0];
}

function requestFor(route: RouteCase) {
  switch (route.method) {
    case "DELETE":
      return agent.delete(route.concrete);
    case "GET":
      return agent.get(route.concrete);
    case "PATCH":
      return agent.patch(route.concrete);
    case "POST":
      return agent.post(route.concrete);
    case "PUT":
      return agent.put(route.concrete);
  }
}

async function exercise(route: RouteCase): Promise<Failure | null> {
  try {
    let req = requestFor(route)
      .set("x-client-date", "2026-09-14")
      .query({ dryRun: "true", apply: "false", confirm: "false", targetCompanyId: MISSING_ID })
      .timeout({ response: 20000, deadline: 20000 });
    if (route.method !== "GET") {
      req = req.send({
        dryRun: true,
        apply: false,
        execute: false,
        force: false,
        confirm: false,
        confirmed: false,
        confirmation: "__COVERAGE_INVALID__",
        confirmationToken: "__COVERAGE_INVALID__",
        ids: [],
        rows: [],
        items: [],
      });
    }
    const response = await req;
    if (response.status >= 500) {
      const body = response.body as { message?: string; error?: string } | undefined;
      return {
        route: `${route.method} ${route.template}`,
        status: response.status,
        detail: body?.message || body?.error || response.text?.slice(0, 180) || "",
      };
    }
    return null;
  } catch (error) {
    const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
    return {
      route: `${route.method} ${route.template}`,
      status: timedOut ? 598 : 599,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await pool.query(
    `UPDATE user_company_roles SET role = 'Developer', can_delete_records = true, can_sell_negative_stock = true
     WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId]
  );
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);

  companies = {
    erp: ctx.companyId,
    factory: await createCompany("factory"),
    properties: await createCompany("properties"),
    supplier_partner: await createCompany("supplier_partner"),
  };
  routes = selectMaintenanceFailureWorkflows(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest);
  before = {
    erp: await fingerprint(companies.erp),
    factory: await fingerprint(companies.factory),
    properties: await fingerprint(companies.properties),
    supplier_partner: await fingerprint(companies.supplier_partner),
  };
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe("maintenance and reconciliation failure coverage", () => {
  it("executes guarded maintenance paths without unhandled errors", async () => {
    expect(routes.length).toBeGreaterThan(20);
    const failures: Failure[] = [];

    for (const mode of ["erp", "factory", "properties", "supplier_partner"] as Mode[]) {
      const selected = await agent.post("/api/auth/set-company").send({ companyId: companies[mode] });
      expect(selected.status, `set-company ${mode}`).toBe(200);
      for (const route of routes.filter((candidate) => candidate.mode === mode)) {
        const failure = await exercise(route);
        if (failure) failures.push(failure);
      }
    }

    const report = failures
      .map((failure) => `  ${failure.status} ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} maintenance route(s) failed:\n${report}`).toEqual([]);
  }, 300000);

  it("does not mutate accounting, stock, SP sales or rental payments", async () => {
    for (const [mode, companyId] of Object.entries(companies) as [Mode, number][]) {
      expect(await fingerprint(companyId), `${mode} changed during maintenance probes`).toEqual(before[mode]);
    }
  });
});
