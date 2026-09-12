/**
 * Phase 2 backend coverage — import/upload validation sweep.
 *
 * Import handlers were deliberately excluded from Phase 1 because they can be
 * expensive and mutation-heavy with real workbooks. Phase 2 executes their
 * authenticated validation edges with empty multipart/body payloads. A missing
 * file or empty batch must be rejected cleanly without creating financial or
 * inventory state, while still exercising upload middleware and parser guards.
 */
import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

type CompanyMode = "erp" | "factory" | "properties" | "supplier_partner";
type Manifest = { routes: string[] };
type RouteCase = { mode: CompanyMode; path: string; multipart: boolean };
type Fingerprint = {
  vouchers: string;
  entries: string;
  inventoryRows: string;
  inventoryQty: string;
  rawStockRows: string;
  baleRows: string;
};

const TEST_PREFIX = "phase2imp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 20000;
const CONCURRENCY = 6;
const IMPORT_PATTERN = /(import|upload|preview|validate)/i;
const MULTIPART_PATTERN = /(import|upload|excel|xlsx|csv|workbook|file)/i;
const EXCLUDED: RegExp[] = [
  /(whatsapp|email|openai|ai-|carrier|tracking)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge|backfill)/i,
  /(^|\/)(run|apply|execute|trigger|sync|refresh)(\/|$)/i,
];

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companies: Record<CompanyMode, number>;
let routes: RouteCase[] = [];
let before: Record<CompanyMode, Fingerprint>;
let sequence = 0;

function modeForPath(routePath: string): CompanyMode {
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
  return "erp";
}

export function selectPhase2ImportValidationRoutes(manifest: Manifest): RouteCase[] {
  const selected: RouteCase[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "POST" || !routePath?.startsWith("/api/")) continue;
    if (routePath.includes(":") || routePath.includes("*")) continue;
    if (!IMPORT_PATTERN.test(routePath) || EXCLUDED.some((pattern) => pattern.test(routePath))) continue;

    const mode = modeForPath(routePath);
    const key = `${mode} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ mode, path: routePath, multipart: MULTIPART_PATTERN.test(routePath) });
  }

  return selected;
}

async function createCompany(mode: Exclude<CompanyMode, "erp">): Promise<number> {
  sequence += 1;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, parent_company_id, active, base_currency)
     VALUES ($1, $2, $3, $4, true, 'USD') RETURNING id`,
    [`P2I${sequence}${mode.slice(0, 2)}`.slice(0, 50), `${TEST_PREFIX}_${mode}_${sequence}`, mode, ctx.companyId]
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

async function exercise(route: RouteCase): Promise<{ route: string; status: number; detail: string } | null> {
  try {
    let pending: request.Test;
    if (route.multipart) {
      pending = agent.post(route.path).field("phase2Validation", "true").field("mode", "preview");
    } else {
      pending = agent.post(route.path).send({
        rows: [],
        items: [],
        data: [],
        records: [],
        preview: true,
        dryRun: true,
      });
    }

    const response = await pending.timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
    if (response.status >= 500 || response.status === 401) {
      const body = response.body as { message?: string; error?: string } | undefined;
      return {
        route: `${route.mode} POST ${route.path}`,
        status: response.status,
        detail: body?.message || body?.error || response.text?.slice(0, 200) || "",
      };
    }
    return null;
  } catch (error) {
    const timedOut = Boolean((error as { timeout?: unknown } | undefined)?.timeout);
    return {
      route: `${route.mode} POST ${route.path}`,
      status: timedOut ? 598 : 599,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
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

  companies = {
    erp: ctx.companyId,
    factory: await createCompany("factory"),
    properties: await createCompany("properties"),
    supplier_partner: await createCompany("supplier_partner"),
  };
  routes = selectPhase2ImportValidationRoutes(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest);
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

describe.sequential("Phase 2 import/upload validation sweep", () => {
  it("rejects empty imports cleanly across every company mode", async () => {
    expect(routes.length).toBeGreaterThan(15);
    const failures: Array<{ route: string; status: number; detail: string }> = [];

    for (const mode of ["erp", "factory", "properties", "supplier_partner"] as CompanyMode[]) {
      const switched = await agent.post("/api/auth/set-company").send({ companyId: companies[mode] });
      expect(switched.status, `set-company ${mode}`).toBe(200);

      const modeRoutes = routes.filter((route) => route.mode === mode);
      for (let offset = 0; offset < modeRoutes.length; offset += CONCURRENCY) {
        const outcomes = await Promise.all(modeRoutes.slice(offset, offset + CONCURRENCY).map(exercise));
        failures.push(
          ...outcomes.filter(
            (outcome): outcome is { route: string; status: number; detail: string } => outcome !== null
          )
        );
      }
    }

    const report = failures
      .map((failure) => `  ${failure.status} ${failure.route}\n      ${failure.detail}`)
      .join("\n");
    expect(failures, `${failures.length} import validation route(s) failed:\n${report}`).toEqual([]);
  }, 300000);

  it("does not create accounting or inventory state from rejected imports", async () => {
    for (const [mode, companyId] of Object.entries(companies) as [CompanyMode, number][]) {
      expect(await fingerprint(companyId), `${mode} changed during rejected import sweep`).toEqual(before[mode]);
    }
  });
});
