/**
 * Phase 1 backend coverage — ERP / Supplier Partner / Properties validation.
 *
 * These are parameterless write handlers outside the dedicated sensitive-write
 * safety inventory. They run against isolated tenants with deliberately invalid
 * dry-run input. The contract is intentionally broad for Phase 1: no unhandled
 * server errors, no lost auth, and no accounting/inventory side effects.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type CompanyMode = "erp" | "properties" | "supplier_partner";
type HttpMethod = "DELETE" | "PATCH" | "POST" | "PUT";
type Manifest = { routes: string[] };
type Route = { method: HttpMethod; path: string; mode: CompanyMode };
type Fingerprint = {
  vouchers: string;
  entries: string;
  inventory_rows: string;
  inventory_qty: string;
  sales_rows: string;
};

const TEST_PREFIX = "covwrt";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 15000;

const ERP_PREFIXES = [
  "/api/vouchers",
  "/api/stock",
  "/api/inventory",
  "/api/containers",
  "/api/customers",
  "/api/accounts",
  "/api/daybook",
  "/api/location",
  "/api/payroll",
  "/api/erp-payroll",
  "/api/transfers",
  "/api/transporters",
  "/api/suppliers",
  "/api/bales",
  "/api/production",
] as const;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(import|upload|excel|template|export|download|whatsapp|pdf)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge|backfill)/i,
  /(^|\/)(refresh|track|sync|send|print)(\/|$)/i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companies: Record<CompanyMode, number>;
let routes: Route[] = [];
let before: Record<CompanyMode, Fingerprint>;
let seq = 0;

function isWriteMethod(value: string): value is HttpMethod {
  return value === "DELETE" || value === "PATCH" || value === "POST" || value === "PUT";
}

function modeForPath(routePath: string): CompanyMode | null {
  if (routePath.startsWith("/api/sp/")) return "supplier_partner";
  if (routePath.startsWith("/api/properties/")) return "properties";
  if (ERP_PREFIXES.some((prefix) => routePath.startsWith(prefix))) return "erp";
  return null;
}

export function selectDomainValidationWrites(manifest: Manifest): Route[] {
  const seen = new Set<string>();
  const selected: Route[] = [];
  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (!isWriteMethod(method) || !routePath?.startsWith("/api/")) continue;
    if (routePath.startsWith("/api/factory/") || routePath.includes(":") || routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;
    const mode = modeForPath(routePath);
    if (!mode) continue;
    const key = `${method} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ method, path: routePath, mode });
  }
  return selected;
}

function requestFor(route: Route) {
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

async function createCompany(mode: CompanyMode): Promise<number> {
  seq += 1;
  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, $3, $4, true, 'USD') RETURNING id`,
    [
      `${TEST_PREFIX}-${mode}-${seq}`.slice(0, 50),
      `${TEST_PREFIX}_${mode}_${seq}`,
      mode,
      mode === "erp" ? null : ctx.companyId,
    ]
  );
  const companyId = company.rows[0].id;
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

function poisonBody(companyId: number) {
  return {
    companyId,
    confirm: false,
    confirmed: false,
    confirmation: "__PHASE1_DO_NOT_APPLY__",
    confirmationToken: "__INVALID__",
    dryRun: true,
    apply: false,
    execute: false,
    force: false,
    ids: [],
    voucherIds: [],
    itemIds: [],
    rows: [],
    entries: [],
    items: [],
    lines: [],
    charges: [],
    amount: "0",
    quantity: "0",
    name: "",
    code: "",
    date: "2026-08-08",
    startDate: "2026-08-01",
    endDate: "2026-08-08",
  };
}

async function fingerprint(companyId: number): Promise<Fingerprint> {
  const result = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS vouchers,
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS entries,
       (SELECT COUNT(*)::text FROM inventory WHERE company_id = $1) AS inventory_rows,
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS inventory_qty,
       (SELECT COUNT(*)::text FROM sales_items si JOIN vouchers v ON v.id = si.voucher_id WHERE v.company_id = $1) AS sales_rows`,
    [companyId]
  );
  return result.rows[0];
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
    erp: await createCompany("erp"),
    properties: await createCompany("properties"),
    supplier_partner: await createCompany("supplier_partner"),
  };
  routes = selectDomainValidationWrites(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest);
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

describe.sequential("Phase 1 ERP and partner write validation matrix", () => {
  it("executes domain validation paths without 5xx or lost authentication", async () => {
    expect(routes.length).toBeGreaterThan(30);
    const failures: Array<{ route: string; status: number; detail: string }> = [];
    let activeMode: CompanyMode | null = null;

    for (const route of routes) {
      if (activeMode !== route.mode) {
        const switched = await agent.post("/api/auth/set-company").send({ companyId: companies[route.mode] });
        expect(switched.status, `set-company ${route.mode}`).toBe(200);
        activeMode = route.mode;
      }
      try {
        const response = await requestFor(route)
          .set("x-client-date", "2026-08-08")
          .send(poisonBody(companies[route.mode]))
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        if (response.status >= 500 || response.status === 401) {
          const body = response.body as { message?: string; error?: string } | undefined;
          failures.push({
            route: `${route.method} ${route.path}`,
            status: response.status,
            detail: body?.message || body?.error || response.text?.slice(0, 200) || "",
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
    expect(failures, `${failures.length} ERP/partner validation write(s) failed:\n${report}`).toEqual([]);
  }, 240000);

  it("leaves every isolated tenant financially and operationally empty", async () => {
    for (const [mode, companyId] of Object.entries(companies) as [CompanyMode, number][]) {
      expect(await fingerprint(companyId), `${mode} state changed`).toEqual(before[mode]);
    }
  });
});
