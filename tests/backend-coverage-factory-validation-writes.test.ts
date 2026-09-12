/**
 * Phase 1 backend coverage — Factory write validation matrix.
 *
 * Sensitive ledger/stock writes already have their own authenticated safety
 * sweep. Factory still has a large set of non-sensitive or differently
 * classified write handlers whose validation/error branches are barely
 * exercised. This suite invokes parameterless Factory writes inside a dedicated
 * empty tenant with poison/dry-run input, rejects any 5xx, and proves the calls
 * cannot create financial or inventory state.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type HttpMethod = "DELETE" | "PATCH" | "POST" | "PUT";
type Manifest = { routes: string[] };
type Route = { method: HttpMethod; path: string };
type Fingerprint = {
  vouchers: string;
  entries: string;
  inventory_rows: string;
  inventory_qty: string;
  raw_stock_rows: string;
  bale_rows: string;
};

const TEST_PREFIX = "prodblk";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 15000;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(import|upload|excel|template|export|download|whatsapp|pdf)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge|backfill)/i,
  /(^|\/)(refresh|track|sync|send|print)(\/|$)/i,
  /^\/api\/factory\/container-doc-types$/i,
  /^\/api\/factory\/waste$/i,
  /^\/api\/factory\/status-builder\/metrics$/i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
let emptyFactoryCompanyId: number;
let routes: Route[] = [];
let before: Fingerprint;

function isWriteMethod(value: string): value is HttpMethod {
  return value === "DELETE" || value === "PATCH" || value === "POST" || value === "PUT";
}

export function selectFactoryValidationWrites(manifest: Manifest): Route[] {
  const seen = new Set<string>();
  const selected: Route[] = [];
  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (!isWriteMethod(method) || !routePath?.startsWith("/api/factory/")) continue;
    if (routePath.includes(":") || routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;
    const key = `${method} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ method, path: routePath });
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

function poisonBody() {
  return {
    companyId: emptyFactoryCompanyId,
    confirm: false,
    confirmed: false,
    confirmation: "__PHASE1_DO_NOT_APPLY__",
    confirmationToken: "__INVALID__",
    dryRun: true,
    apply: false,
    execute: false,
    force: false,
    ids: [],
    supplierIds: [],
    containerIds: [],
    voucherIds: [],
    rows: [],
    items: [],
    lines: [],
    charges: [],
    bales: [],
    transfers: [],
    amount: "",
    quantity: "",
    name: "",
    code: "",
    date: "",
    startDate: "",
    endDate: "",
  };
}

async function fingerprint(companyId: number): Promise<Fingerprint> {
  const result = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS vouchers,
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS entries,
       (SELECT COUNT(*)::text FROM inventory WHERE company_id = $1) AS inventory_rows,
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS inventory_qty,
       (SELECT COUNT(*)::text FROM factory_raw_stock WHERE company_id = $1 AND deleted_at IS NULL) AS raw_stock_rows,
       (SELECT COUNT(*)::text FROM factory_bales WHERE company_id = $1) AS bale_rows`,
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

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, 'factory', $3, true, 'USD') RETURNING id`,
    [`${TEST_PREFIX}-COV-EMPTY`, `${TEST_PREFIX}_CoverageEmptyFactory`, ctx.companyId]
  );
  emptyFactoryCompanyId = company.rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, 'Developer', true, true)`,
    [ctx.userId, emptyFactoryCompanyId]
  );
  await pool.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     SELECT user_id, $2, permission, granted_by
       FROM user_security_permissions
      WHERE user_id = $1 AND company_id = $3
     ON CONFLICT (user_id, company_id, permission) DO NOTHING`,
    [ctx.userId, emptyFactoryCompanyId, ctx.companyId]
  );
  const switched = await agent.post("/api/auth/set-company").send({ companyId: emptyFactoryCompanyId });
  if (switched.status !== 200) throw new Error(`Company selection failed: ${switched.status} ${switched.text}`);

  routes = selectFactoryValidationWrites(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest);
  before = await fingerprint(emptyFactoryCompanyId);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 1 Factory write validation matrix", () => {
  it("exercises broad validation paths without unhandled server errors", async () => {
    expect(routes.length).toBeGreaterThan(20);
    const failures: Array<{ route: string; status: number; detail: string }> = [];

    for (const route of routes) {
      try {
        const response = await requestFor(route)
          .set("x-client-date", "2026-08-08")
          .send(poisonBody())
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        if (response.status >= 500) {
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
    expect(failures, `${failures.length} Factory validation write(s) failed:\n${report}`).toEqual([]);
  }, 180000);

  it("leaves the isolated tenant financially and operationally empty", async () => {
    expect(await fingerprint(emptyFactoryCompanyId)).toEqual(before);
  });
});
