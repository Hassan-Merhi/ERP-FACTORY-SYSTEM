/**
 * Phase 2 backend coverage — deep Factory read matrix.
 *
 * Phase 1 proved that the parameterized route surface rejects missing resources
 * safely. This suite goes the other direction: it creates real Factory
 * resources, substitutes them into parameterized GET routes, and exercises the
 * success-path query/report builders that a missing-id sweep cannot reach.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type Manifest = { routes: string[] };
type ResourceIds = {
  accountId: number;
  containerId: number;
  customerId: number;
  locationId: number;
  productId: number;
  stockItemId: number;
  supplierId: number;
};
type RouteCase = { template: string; concrete: string };
type Fingerprint = {
  voucherCount: string;
  debitTotal: string;
  creditTotal: string;
  inventoryQty: string;
  inventoryValue: string;
  rawStockCount: string;
  baleCount: string;
};

const TEST_PREFIX = "phase2cov";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 30000;
const CONCURRENCY = 4;

const EXCLUDED: RegExp[] = [
  /(whatsapp|email|openai|ai-|carrier)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge|backfill)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /(refresh-eta|tracking-refresh|track-now)/i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
let factoryCompanyId: number;
let ids: ResourceIds;
let routes: RouteCase[] = [];
let before: Fingerprint;

function replaceDates(value: string): string {
  return value
    .replace(/:(fromDate|startDate)\b/g, "2026-08-01")
    .replace(/:(toDate|endDate|date)\b/g, "2026-08-08")
    .replace(/:year\b/g, "2026")
    .replace(/:month\b/g, "8")
    .replace(/:day\b/g, "8");
}

function resolveFactoryRoute(routePath: string, resources: ResourceIds): string | null {
  let concrete = replaceDates(routePath)
    .replace(/:locationId\b/g, String(resources.locationId))
    .replace(/:accountId\b/g, String(resources.accountId))
    .replace(/:(supplierId|brokerId)\b/g, String(resources.supplierId))
    .replace(/:containerId\b/g, String(resources.containerId))
    .replace(/:customerId\b/g, String(resources.customerId))
    .replace(/:(productId|baleProductId)\b/g, String(resources.productId))
    .replace(/:stockItemId\b/g, String(resources.stockItemId));

  if (concrete.includes(":id")) {
    if (/\/customers\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.customerId));
    else if (/\/suppliers\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.supplierId));
    else if (/\/(containers|container-tracking)\/:id\b/.test(routePath)) {
      concrete = concrete.replace(/:id\b/g, String(resources.containerId));
    } else if (/\/bale-products\/:id\b/.test(routePath)) {
      concrete = concrete.replace(/:id\b/g, String(resources.productId));
    } else if (/\/accounts\/:id\b/.test(routePath)) {
      concrete = concrete.replace(/:id\b/g, String(resources.accountId));
    } else if (/\/stock-items\/:id\b/.test(routePath)) {
      concrete = concrete.replace(/:id\b/g, String(resources.stockItemId));
    }
  }

  return concrete.includes(":") || concrete.includes("*") ? null : concrete;
}

export function selectPhase2FactoryDeepReads(manifest: Manifest, resources: ResourceIds): RouteCase[] {
  const selected: RouteCase[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET" || !routePath?.startsWith("/api/factory/") || !routePath.includes(":")) continue;
    if (EXCLUDED.some((pattern) => pattern.test(routePath))) continue;

    const concrete = resolveFactoryRoute(routePath, resources);
    if (!concrete || seen.has(concrete)) continue;
    seen.add(concrete);
    selected.push({ template: routePath, concrete });
  }

  return selected;
}

async function fingerprint(companyId: number): Promise<Fingerprint> {
  const result = await pool.query<Fingerprint>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS "voucherCount",
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "debitTotal",
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "creditTotal",
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS "inventoryQty",
       (SELECT COALESCE(SUM(total_value::numeric), 0)::text FROM inventory WHERE company_id = $1) AS "inventoryValue",
       (SELECT COUNT(*)::text FROM factory_raw_stock WHERE company_id = $1 AND deleted_at IS NULL) AS "rawStockCount",
       (SELECT COUNT(*)::text FROM factory_bales WHERE company_id = $1) AS "baleCount"`,
    [companyId]
  );
  return result.rows[0];
}

async function executeBatch(batch: RouteCase[]): Promise<Array<{ route: string; status: number; detail: string }>> {
  const outcomes = await Promise.all(
    batch.map(async (route) => {
      try {
        const response = await agent
          .get(route.concrete)
          .set("x-client-date", "2026-08-08")
          .query({ startDate: "2026-08-01", endDate: "2026-08-08", date: "2026-08-08" })
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        if (response.status >= 500 || response.status === 401) {
          const body = response.body as { message?: string; error?: string } | undefined;
          return {
            route: route.template,
            status: response.status,
            detail: body?.message || body?.error || response.text?.slice(0, 200) || "",
          };
        }
        return null;
      } catch (error) {
        const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
        return {
          route: route.template,
          status: timedOut ? 598 : 599,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  return outcomes.filter((outcome): outcome is { route: string; status: number; detail: string } => outcome !== null);
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

  const factoryCompany = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, 'factory', $3, true, 'USD') RETURNING id`,
    [`P2COVF`, `${TEST_PREFIX}_FactoryCompany`, ctx.companyId]
  );
  factoryCompanyId = factoryCompany.rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, can_delete_records, can_sell_negative_stock)
     VALUES ($1, $2, 'Developer', true, true)`,
    [ctx.userId, factoryCompanyId]
  );
  await pool.query(
    `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
     SELECT user_id, $2, permission, granted_by
       FROM user_security_permissions
      WHERE user_id = $1 AND company_id = $3
     ON CONFLICT (user_id, company_id, permission) DO NOTHING`,
    [ctx.userId, factoryCompanyId, ctx.companyId]
  );

  const selected = await agent.post("/api/auth/set-company").send({ companyId: factoryCompanyId });
  if (selected.status !== 200) throw new Error(`Factory company selection failed: ${selected.status} ${selected.text}`);

  const location = await pool.query<{ id: number }>(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [factoryCompanyId, "P2COVF-WH", `${TEST_PREFIX}_FactoryWarehouse`]
  );
  const stockGroup = await pool.query<{ id: number }>(
    `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [factoryCompanyId, "P2COVF-GRP", `${TEST_PREFIX}_FactoryGroup`]
  );
  const stockItem = await pool.query<{ id: number }>(
    `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, active)
     VALUES ($1, $2, $3, 'PCS', $4, true) RETURNING id`,
    [factoryCompanyId, "P2COVF-ITEM", `${TEST_PREFIX}_FactoryItem`, stockGroup.rows[0].id]
  );
  const account = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts
       (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Cash', 'Cash', '0', 'Dr') RETURNING id`,
    [factoryCompanyId, "P2COVF-CASH", `${TEST_PREFIX}_FactoryCash`]
  );

  const supplier = await agent.post("/api/factory/suppliers").send({
    name: `${TEST_PREFIX}_supplier`,
    currencyCode: "USD",
  });
  if (supplier.status !== 200 || !supplier.body?.id) {
    throw new Error(`Supplier seed failed: ${supplier.status} ${supplier.text}`);
  }

  const customer = await agent.post("/api/factory/customers").send({
    legalName: `${TEST_PREFIX} Customer`,
    active: true,
  });
  if (customer.status !== 201 || !customer.body?.id) {
    throw new Error(`Customer seed failed: ${customer.status} ${customer.text}`);
  }

  const product = await agent.post("/api/factory/bale-products").send({
    name: `${TEST_PREFIX} Product`,
    grade: "#1",
    weightPerBaleKg: "45",
    sellingPrice: "12.50",
  });
  if (product.status !== 200 || !product.body?.id) {
    throw new Error(`Product seed failed: ${product.status} ${product.text}`);
  }

  const container = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, supplier_id, container_number, total_kg, rate_per_kg, currency_code, status)
     VALUES ($1, $2, $3, '1000.000', '2.500000', 'USD', 'PENDING')
     RETURNING id`,
    [factoryCompanyId, Number(supplier.body.id), `${TEST_PREFIX}-CONT`]
  );

  ids = {
    accountId: account.rows[0].id,
    containerId: container.rows[0].id,
    customerId: Number(customer.body.id),
    locationId: location.rows[0].id,
    productId: Number(product.body.id),
    stockItemId: stockItem.rows[0].id,
    supplierId: Number(supplier.body.id),
  };

  routes = selectPhase2FactoryDeepReads(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest, ids);
  before = await fingerprint(factoryCompanyId);
}, 120000);

afterAll(async () => {
  await pool.query("DELETE FROM factory_bale_products WHERE company_id = $1", [factoryCompanyId]).catch(() => undefined);
  await pool.query("DELETE FROM factory_production_plans WHERE company_id = $1", [factoryCompanyId]).catch(() => undefined);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 2 deep Factory reads", () => {
  it("executes real-resource parameterized reads and report builders without 5xx", async () => {
    expect(routes.length).toBeGreaterThan(25);
    const failures: Array<{ route: string; status: number; detail: string }> = [];

    for (let offset = 0; offset < routes.length; offset += CONCURRENCY) {
      failures.push(...(await executeBatch(routes.slice(offset, offset + CONCURRENCY))));
    }

    const report = failures
      .map((failure) => `  ${failure.status} GET ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} deep Factory read(s) failed:\n${report}`).toEqual([]);
  }, 300000);

  it("keeps accounting, inventory and raw stock unchanged", async () => {
    expect(await fingerprint(factoryCompanyId)).toEqual(before);
  });
});