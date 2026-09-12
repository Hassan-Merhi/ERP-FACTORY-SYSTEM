/**
 * Phase 1 backend coverage — company-mode read sweep.
 *
 * The repository-wide API smoke sweep runs under an ERP company. That proves
 * route liveness but leaves many Factory, Supplier Partner and Properties
 * handlers behind their company-mode guards. This companion repeats the safe,
 * parameterless read surface while actively selecting the matching company
 * mode so the real queries and read models execute.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type CompanyMode = "factory" | "properties" | "supplier_partner";
type Manifest = { routes: string[] };
type SweptRoute = { mode: CompanyMode; path: string };
type Fingerprint = {
  vouchers: string;
  entries: string;
  inventoryRows: string;
  inventoryQty: string;
  rawStockRows: string;
  baleRows: string;
};

const TEST_PREFIX = "covmode";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 15000;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge|backfill)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /(export|download|template|whatsapp|tracking-refresh)/i,
  /\.(xlsx|pdf|csv|zip)$/i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companies: Record<CompanyMode, number>;
let before: Record<CompanyMode, Fingerprint>;
let routes: SweptRoute[] = [];
let companySequence = 0;

function modeForPath(routePath: string): CompanyMode | null {
  if (
    routePath.startsWith("/api/factory/") ||
    routePath.startsWith("/api/factory-") ||
    routePath.startsWith("/api/factory-workers/")
  ) {
    return "factory";
  }
  if (routePath.startsWith("/api/sp/") || routePath.startsWith("/api/sp-migration/")) {
    return "supplier_partner";
  }
  if (routePath.startsWith("/api/properties/") || routePath.startsWith("/api/rental/")) {
    return "properties";
  }
  return null;
}

export function selectCompanyModeReadRoutes(manifest: Manifest): SweptRoute[] {
  const seen = new Set<string>();
  const selected: SweptRoute[] = [];

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET" || !routePath?.startsWith("/api/")) continue;
    if (routePath.includes(":") || routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;
    const mode = modeForPath(routePath);
    if (!mode) continue;
    const key = `${mode} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ mode, path: routePath });
  }

  return selected;
}

async function createCompany(mode: CompanyMode): Promise<number> {
  companySequence += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, $3, $4, true, 'USD') RETURNING id`,
    [
      `${TEST_PREFIX}-${mode}-${companySequence}`.slice(0, 50),
      `${TEST_PREFIX}_${mode}_${companySequence}`,
      mode,
      ctx.companyId,
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

async function fingerprint(companyId: number): Promise<Fingerprint> {
  const result = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS vouchers,
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS entries,
       (SELECT COUNT(*)::text FROM inventory WHERE company_id = $1) AS "inventoryRows",
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS "inventoryQty",
       (SELECT COUNT(*)::text FROM factory_raw_stock WHERE company_id = $1 AND deleted_at IS NULL) AS "rawStockRows",
       (SELECT COUNT(*)::text FROM factory_bales WHERE company_id = $1) AS "baleRows"`,
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
    factory: await createCompany("factory"),
    properties: await createCompany("properties"),
    supplier_partner: await createCompany("supplier_partner"),
  };
  routes = selectCompanyModeReadRoutes(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest);
  before = {
    factory: await fingerprint(companies.factory),
    properties: await fingerprint(companies.properties),
    supplier_partner: await fingerprint(companies.supplier_partner),
  };
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 1 company-mode read sweep", () => {
  it("executes parameterless reads inside their actual company modes", async () => {
    expect(routes.length).toBeGreaterThan(100);
    const failures: Array<{ route: string; status: number; detail: string }> = [];
    let activeMode: CompanyMode | null = null;

    for (const route of routes) {
      if (activeMode !== route.mode) {
        const switched = await agent.post("/api/auth/set-company").send({ companyId: companies[route.mode] });
        expect(switched.status, `set-company ${route.mode}`).toBe(200);
        activeMode = route.mode;
      }

      try {
        const response = await agent
          .get(route.path)
          .set("x-client-date", "2026-08-08")
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        if (response.status >= 500 || response.status === 401) {
          const body = response.body as { message?: string; error?: string } | undefined;
          failures.push({
            route: `${route.mode} GET ${route.path}`,
            status: response.status,
            detail: body?.message || body?.error || response.text?.slice(0, 200) || "",
          });
        }
      } catch (error) {
        const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
        failures.push({
          route: `${route.mode} GET ${route.path}`,
          status: timedOut ? 598 : 599,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const report = failures
      .map((failure) => `  ${failure.status} ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} mode-correct read(s) failed:\n${report}`).toEqual([]);
  }, 300000);

  it("keeps every company-mode fixture read-only", async () => {
    for (const [mode, companyId] of Object.entries(companies) as [CompanyMode, number][]) {
      expect(await fingerprint(companyId), `${mode} state changed during GET sweep`).toEqual(before[mode]);
    }
  });
});
