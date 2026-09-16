/**
 * Backend coverage — non-Factory validation/failure write paths.
 *
 * Parameterized writes and Factory parameterless writes already have broad
 * safety matrices. This closes the complementary ERP/Supplier Partner/
 * Properties gap. Requests carry an intentionally empty body in isolated
 * tenants, maintenance/external operations are excluded, and before/after
 * fingerprints prove rejected probes never create financial or operational rows.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type Mode = "erp" | "properties" | "supplier_partner";
type Method = "DELETE" | "PATCH" | "POST" | "PUT";
type Manifest = { routes: string[] };
type RouteCase = { mode: Mode; method: Method; path: string };
type Failure = { route: string; status: number; detail: string };
type Fingerprint = Record<string, string>;

const TEST_PREFIX = "covnonfw";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 15000;

const EXCLUDED: RegExp[] = [
  /^\/api\/(auth|admin|debug|sessions?|users?|companies?|system|health)(\/|$)/i,
  /^\/api\/factory(?:\/|-)/i,
  /(whatsapp|email|openai|ai-|carrier|tracking|track-now|refresh-eta)/i,
  /(import|upload|export|download|template|pdf|excel|xlsx|csv|print)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge|backfill)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /^\/api\/sp\/(golden-coast|setup|production)(\/|$)/i,
  /\/rental\/(run-monthly|accrue|re-accrue|payments\/post-scheduled)(\/|$)/i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companies: Record<Mode, number>;
let routes: RouteCase[] = [];
let before: Record<Mode, Fingerprint>;
let sequence = 0;

function isWriteMethod(value: string): value is Method {
  return value === "DELETE" || value === "PATCH" || value === "POST" || value === "PUT";
}

function modeForPath(routePath: string): Mode {
  if (routePath.startsWith("/api/sp/")) return "supplier_partner";
  if (routePath.startsWith("/api/properties/") || routePath.startsWith("/api/rental/")) return "properties";
  return "erp";
}

export function selectNonFactoryValidationWrites(manifest: Manifest): RouteCase[] {
  const seen = new Set<string>();
  const selected: RouteCase[] = [];

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (!isWriteMethod(method) || !routePath?.startsWith("/api/")) continue;
    if (routePath.includes(":") || routePath.includes("*")) continue;
    if (EXCLUDED.some((pattern) => pattern.test(routePath))) continue;

    const mode = modeForPath(routePath);
    const key = `${mode} ${method} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ mode, method, path: routePath });
  }

  return selected;
}

async function createCompany(mode: Exclude<Mode, "erp">): Promise<number> {
  sequence += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, $3, $4, true, 'USD') RETURNING id`,
    [`CNFW-${mode.slice(0, 3)}-${sequence}`, `${TEST_PREFIX}_${mode}_${sequence}`, mode, ctx.companyId]
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

async function fingerprint(companyId: number): Promise<Fingerprint> {
  const { rows } = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS vouchers,
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS entries,
       (SELECT COUNT(*)::text FROM inventory WHERE company_id = $1) AS inventory,
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS inventory_qty,
       (SELECT COUNT(*)::text FROM customers WHERE company_id = $1) AS customers,
       (SELECT COUNT(*)::text FROM suppliers WHERE company_id = $1) AS suppliers,
       (SELECT COUNT(*)::text FROM employees WHERE company_id = $1) AS employees,
       (SELECT COUNT(*)::text FROM stock_items WHERE company_id = $1) AS stock_items,
       (SELECT COUNT(*)::text FROM property_units WHERE company_id = $1) AS property_units,
       (SELECT COUNT(*)::text FROM property_contracts WHERE company_id = $1) AS property_contracts,
       (SELECT COUNT(*)::text FROM property_payments WHERE company_id = $1) AS property_payments,
       (SELECT COUNT(*)::text FROM sp_sales WHERE company_id = $1) AS sp_sales,
       (SELECT COUNT(*)::text FROM sp_stock_movements WHERE company_id = $1) AS sp_movements`,
    [companyId]
  );
  return rows[0];
}

function requestFor(route: RouteCase) {
  switch (route.method) {
    case "DELETE":
      return agent.delete(route.path);
    case "PATCH":
      return agent.patch(route.path);
    case "POST":
      return agent.post(route.path);
    case "PUT":
      return agent.put(route.path);
  }
}

async function exercise(route: RouteCase): Promise<Failure | null> {
  try {
    const response = await requestFor(route)
      .set("x-client-date", "2026-09-14")
      .send({})
      .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });

    if (response.status >= 500) {
      const body = response.body as { message?: string; error?: string } | undefined;
      return {
        route: `${route.method} ${route.path}`,
        status: response.status,
        detail: body?.message || body?.error || response.text?.slice(0, 200) || "",
      };
    }
    return null;
  } catch (error) {
    const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
    return {
      route: `${route.method} ${route.path}`,
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
    properties: await createCompany("properties"),
    supplier_partner: await createCompany("supplier_partner"),
  };
  routes = selectNonFactoryValidationWrites(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest);
  before = {
    erp: await fingerprint(companies.erp),
    properties: await fingerprint(companies.properties),
    supplier_partner: await fingerprint(companies.supplier_partner),
  };
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe("non-Factory validation write coverage", () => {
  it("rejects malformed write probes without unhandled server errors", async () => {
    expect(routes.length).toBeGreaterThan(40);
    const failures: Failure[] = [];

    for (const mode of ["erp", "properties", "supplier_partner"] as Mode[]) {
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
    expect(failures, `${failures.length} malformed write probe(s) failed unsafely:\n${report}`).toEqual([]);
  }, 300000);

  it("leaves every isolated tenant unchanged", async () => {
    for (const [mode, companyId] of Object.entries(companies) as [Mode, number][]) {
      expect(await fingerprint(companyId), `${mode} changed during validation sweep`).toEqual(before[mode]);
    }
  });
});
