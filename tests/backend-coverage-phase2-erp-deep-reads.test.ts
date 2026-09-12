/**
 * Phase 2 backend coverage — deep ERP read matrix.
 *
 * Phase 1 exercised broad route liveness and missing-resource rejection. This
 * suite materializes common ERP resources and walks parameterized GET routes
 * with valid ids so statements, history queries, detail serializers and report
 * builders execute their normal paths.
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
  companyId: number;
  customerId: number;
  employeeId: number;
  locationId: number;
  stockGroupId: number;
  stockItemId: number;
  supplierId: number;
  voucherId: number;
};
type RouteCase = { template: string; concrete: string };
type Fingerprint = {
  voucherCount: string;
  entryCount: string;
  debitTotal: string;
  creditTotal: string;
  inventoryQty: string;
  inventoryValue: string;
};

const TEST_PREFIX = "phase2erp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 30000;
const CONCURRENCY = 6;

const EXCLUDED: RegExp[] = [
  /^\/api\/factory\//i,
  /^\/api\/factory-/i,
  /^\/api\/sp\//i,
  /^\/api\/sp-migration\//i,
  /^\/api\/properties\//i,
  /^\/api\/rental\//i,
  /^\/api\/admin\//i,
  /(whatsapp|email|openai|ai-|carrier|scrape)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge|backfill)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /(refresh-eta|tracking-refresh|track-now)/i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
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

function resolveErpRoute(routePath: string, resources: ResourceIds): string | null {
  let concrete = replaceDates(routePath)
    .replace(/:companyId\b/g, String(resources.companyId))
    .replace(/:locationId\b/g, String(resources.locationId))
    .replace(/:accountId\b/g, String(resources.accountId))
    .replace(/:customerId\b/g, String(resources.customerId))
    .replace(/:supplierId\b/g, String(resources.supplierId))
    .replace(/:employeeId\b/g, String(resources.employeeId))
    .replace(/:voucherId\b/g, String(resources.voucherId))
    .replace(/:(stockItemId|itemId)\b/g, String(resources.stockItemId))
    .replace(/:(stockGroupId|groupId)\b/g, String(resources.stockGroupId));

  if (concrete.includes(":id")) {
    if (/\/customers\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.customerId));
    else if (/\/suppliers\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.supplierId));
    else if (/\/employees\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.employeeId));
    else if (/\/vouchers\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.voucherId));
    else if (/\/accounts\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.accountId));
    else if (/\/locations\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.locationId));
    else if (/\/stock-items\/:id\b/.test(routePath)) concrete = concrete.replace(/:id\b/g, String(resources.stockItemId));
    else if (/\/stock-groups\/:id\b/.test(routePath)) {
      concrete = concrete.replace(/:id\b/g, String(resources.stockGroupId));
    }
  }

  return concrete.includes(":") || concrete.includes("*") ? null : concrete;
}

export function selectPhase2ErpDeepReads(manifest: Manifest, resources: ResourceIds): RouteCase[] {
  const selected: RouteCase[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET" || !routePath?.startsWith("/api/") || !routePath.includes(":")) continue;
    if (EXCLUDED.some((pattern) => pattern.test(routePath))) continue;

    const concrete = resolveErpRoute(routePath, resources);
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
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "entryCount",
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "debitTotal",
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS "creditTotal",
       (SELECT COALESCE(SUM(quantity::numeric), 0)::text FROM inventory WHERE company_id = $1) AS "inventoryQty",
       (SELECT COALESCE(SUM(total_value::numeric), 0)::text FROM inventory WHERE company_id = $1) AS "inventoryValue"`,
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
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`Company selection failed: ${selected.status} ${selected.text}`);

  const customer = await agent.post("/api/customers").send({
    legalName: `${TEST_PREFIX} Customer`,
    active: true,
  });
  if (customer.status < 200 || customer.status >= 300 || !customer.body?.id) {
    throw new Error(`Customer seed failed: ${customer.status} ${customer.text}`);
  }

  const supplier = await agent.post("/api/suppliers").send({
    legalName: `${TEST_PREFIX} Supplier`,
    email: "",
    active: true,
  });
  if (supplier.status < 200 || supplier.status >= 300 || !supplier.body?.id) {
    throw new Error(`Supplier seed failed: ${supplier.status} ${supplier.text}`);
  }

  const employee = await agent.post("/api/employees").send({
    firstName: "Phase",
    lastName: "Two",
    joinDate: "2026-08-01",
    employeeType: "Employee",
    monthlySalary: "1000.00",
  });
  if (employee.status < 200 || employee.status >= 300 || !employee.body?.id) {
    throw new Error(`Employee seed failed: ${employee.status} ${employee.text}`);
  }

  const voucher = await agent.post("/api/vouchers/with-entries").send({
    voucher: {
      voucherNumber: `${TEST_PREFIX}-J1`,
      voucherType: "Journal",
      voucherDate: "2026-08-08",
      description: "Phase 2 deep read fixture",
      locationId: ctx.locationId,
    },
    entries: [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "100.00", creditAmount: "0", narration: "Debit" },
      { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "100.00", narration: "Credit" },
    ],
  });
  if (voucher.status !== 200 || !voucher.body?.voucher?.id) {
    throw new Error(`Voucher seed failed: ${voucher.status} ${voucher.text}`);
  }

  ids = {
    accountId: ctx.salesAccountId,
    companyId: ctx.companyId,
    customerId: Number(customer.body.id),
    employeeId: Number(employee.body.id),
    locationId: ctx.locationId,
    stockGroupId: ctx.stockGroupId,
    stockItemId: ctx.stockItemIds[0],
    supplierId: Number(supplier.body.id),
    voucherId: Number(voucher.body.voucher.id),
  };

  routes = selectPhase2ErpDeepReads(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest, ids);
  before = await fingerprint(ctx.companyId);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120000);

describe.sequential("Phase 2 deep ERP reads", () => {
  it("executes real-resource parameterized reads and statements without 5xx", async () => {
    expect(routes.length).toBeGreaterThan(20);
    const failures: Array<{ route: string; status: number; detail: string }> = [];

    for (let offset = 0; offset < routes.length; offset += CONCURRENCY) {
      failures.push(...(await executeBatch(routes.slice(offset, offset + CONCURRENCY))));
    }

    const report = failures
      .map((failure) => `  ${failure.status} GET ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} deep ERP read(s) failed:\n${report}`).toEqual([]);
  }, 300000);

  it("keeps the seeded financial and inventory state read-only", async () => {
    expect(await fingerprint(ctx.companyId)).toEqual(before);
  });
});
