/**
 * Phase 1 backend coverage — positive Factory read matrix.
 *
 * The broad missing-resource matrix reaches rejection branches. This companion
 * supplies real Factory resources for the route families that dominate the
 * remaining backend coverage debt: suppliers, containers, locations and
 * accounts. Requests still go through the real application stack, and every GET
 * must preserve accounting/inventory state.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type Manifest = { routes: string[] };
type ReadRoute = { path: string };
type Fingerprint = {
  voucher_count: string;
  debit_total: string;
  credit_total: string;
  inventory_qty: string;
  inventory_value: string;
  raw_stock_count: string;
  bale_count: string;
};

type ResourceIds = {
  locationId: number;
  accountId: number;
  supplierId: number;
  containerId: number;
};

const TEST_PREFIX = "charfact";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 15000;

let ctx: TestContext;
let agent: request.SuperAgentTest;
let resources: ResourceIds;
let before: Fingerprint;
let routes: Array<{ template: string; concrete: string }> = [];

const EXCLUDED_PATTERNS: RegExp[] = [
  /(export|download|template|whatsapp)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /\.(xlsx|pdf|csv|zip)$/i,
];

export function selectFactoryPositiveReadRoutes(
  manifest: Manifest,
  ids: ResourceIds
): Array<{
  template: string;
  concrete: string;
}> {
  const seen = new Set<string>();
  const selected: Array<{ template: string; concrete: string }> = [];

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET" || !routePath?.startsWith("/api/factory/") || !routePath.includes(":")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;

    let concrete = routePath
      .replace(/:locationId\b/g, String(ids.locationId))
      .replace(/:accountId\b/g, String(ids.accountId))
      .replace(/:(supplierId|brokerId)\b/g, String(ids.supplierId))
      .replace(/:containerId\b/g, String(ids.containerId));

    if (concrete.includes(":id")) {
      if (/\/suppliers\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(ids.supplierId));
      else if (/\/(containers|container-tracking)\/:id\b/.test(routePath)) {
        concrete = concrete.replace(/:id\b/g, String(ids.containerId));
      }
    }

    // Keep only routes for which this fixture can provide every path resource.
    if (concrete.includes(":")) continue;
    if (seen.has(concrete)) continue;
    seen.add(concrete);
    selected.push({ template: routePath, concrete });
  }

  return selected;
}

async function fingerprint(companyId: number): Promise<Fingerprint> {
  const result = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers v WHERE v.company_id = $1) AS voucher_count,
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS debit_total,
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS credit_total,
       (SELECT COALESCE(SUM(i.quantity::numeric), 0)::text FROM inventory i WHERE i.company_id = $1) AS inventory_qty,
       (SELECT COALESCE(SUM(i.total_value::numeric), 0)::text FROM inventory i WHERE i.company_id = $1) AS inventory_value,
       (SELECT COUNT(*)::text FROM factory_raw_stock frs WHERE frs.company_id = $1 AND frs.deleted_at IS NULL) AS raw_stock_count,
       (SELECT COUNT(*)::text FROM factory_bales fb WHERE fb.company_id = $1) AS bale_count`,
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
  const selectCompany = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selectCompany.status !== 200) throw new Error(`Company selection failed: ${selectCompany.status}`);

  const supplier = await agent.post("/api/factory/suppliers").send({
    name: `${TEST_PREFIX}_coverage_supplier`,
    currencyCode: "USD",
  });
  if (supplier.status !== 200 || !supplier.body?.id) {
    throw new Error(`Factory supplier seed failed: ${supplier.status} ${supplier.text}`);
  }

  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code, status)
     VALUES ($1, $2, $3, '1000.000', '2.500000', 'USD', 'PENDING')
     RETURNING id`,
    [ctx.companyId, supplier.body.id, `${TEST_PREFIX}-COV-CONT`]
  );

  resources = {
    locationId: ctx.locationId,
    accountId: ctx.salesAccountId,
    supplierId: Number(supplier.body.id),
    containerId: container.rows[0].id,
  };
  routes = selectFactoryPositiveReadRoutes(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest, resources);
  before = await fingerprint(ctx.companyId);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 1 positive Factory read matrix", () => {
  it("walks real supplier, container, location and account resources without 5xx", async () => {
    expect(routes.length).toBeGreaterThan(15);
    const failures: Array<{ route: string; status: number; detail: string }> = [];

    for (const route of routes) {
      try {
        const response = await agent
          .get(route.concrete)
          .set("x-client-date", "2026-08-08")
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        if (response.status >= 500) {
          const body = response.body as { message?: string; error?: string } | undefined;
          failures.push({
            route: route.template,
            status: response.status,
            detail: body?.message || body?.error || response.text?.slice(0, 200) || "",
          });
        }
      } catch (error) {
        const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
        failures.push({
          route: route.template,
          status: timedOut ? 598 : 599,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const report = failures
      .map((failure) => `  ${failure.status} ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} positive Factory read(s) failed:\n${report}`).toEqual([]);
  }, 180000);

  it("keeps the Factory financial and inventory fingerprint read-only", async () => {
    expect(await fingerprint(ctx.companyId)).toEqual(before);
  });
});
