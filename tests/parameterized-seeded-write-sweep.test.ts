import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { closeTestServer, seedTestData, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const ERP_PREFIX = "phase33pwrite";
const FACTORY_PREFIX = "phase33pfactory";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = 2_147_482_500;
const REQUEST_TIMEOUT_MS = 12_000;

type WriteMethod = "POST" | "PUT" | "PATCH";

interface SweptWriteRoute {
  method: WriteMethod;
  manifestPath: string;
  requestPath: string;
  fixture: "erp" | "factory";
}

const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(auth|debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(import|upload|export|download|template)/i,
  /(whatsapp|email|openai|gemini|ai-validation|track|trace|webhook)/i,
  /(delete|remove|reverse|cancel|void|merge|offload)/i,
  /(^|\/)(run|apply|execute|trigger|sync|refresh|send)(\/|$)/i,
  /(payroll\/generate|stock-entry)/i,
];

function loadManifest(): SerializedRouteManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
}

function fixtureFor(routePath: string): "erp" | "factory" {
  return routePath.startsWith("/api/factory/") ? "factory" : "erp";
}

function parameterValue(routePath: string, name: string, ctx: TestContext): string {
  const key = name.toLowerCase();
  const lowerPath = routePath.toLowerCase();

  if (key.includes("company")) return String(ctx.companyId);
  if (key.includes("fromlocation") || key.includes("sourceLocation".toLowerCase())) return String(ctx.locationId);
  if (key.includes("tolocation") || key.includes("destinationlocation")) return String(ctx.location2Id);
  if (key.includes("location")) return String(ctx.locationId);
  if (key.includes("stockitem") || key === "itemid" || key === "productid") return String(ctx.stockItemIds[0]);
  if (key.includes("stockgroup") || key === "groupid") return String(ctx.stockGroupId);
  if (key.includes("cashaccount")) return String(ctx.cashAccountId);
  if (key.includes("account")) return String(ctx.salesAccountId);
  if (key.includes("user")) return encodeURIComponent(ctx.userId);
  if (key.includes("year")) return "2026";
  if (key.includes("month")) return "9";
  if (key.includes("date")) return "2026-09-15";
  if (key.includes("currency")) return "USD";
  if (key.includes("status")) return "active";
  if (key.includes("code")) return "PHASE33";
  if (key.includes("type")) return "standard";

  if (key === "id") {
    if (/stock[-_/]?items?/.test(lowerPath)) return String(ctx.stockItemIds[0]);
    if (/locations?/.test(lowerPath)) return String(ctx.locationId);
    if (/stock[-_/]?groups?/.test(lowerPath)) return String(ctx.stockGroupId);
    if (/ledger|accounts?/.test(lowerPath)) return String(ctx.salesAccountId);
    if (/companies?/.test(lowerPath)) return String(ctx.companyId);
    if (/users?/.test(lowerPath)) return encodeURIComponent(ctx.userId);
  }

  return String(MISSING_ID);
}

function materialize(routePath: string, ctx: TestContext): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    encodeURIComponent(parameterValue(routePath, name, ctx))
  );
}

function selectRoutes(
  manifest: SerializedRouteManifest,
  erpCtx: TestContext,
  factoryCtx: TestContext
): SweptWriteRoute[] {
  const routes: SweptWriteRoute[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.routes) {
    const [rawMethod, routePath] = entry.split(" ");
    if (!routePath?.startsWith("/api/") || routePath.includes("*")) continue;
    if (!routePath.includes(":")) continue;
    if (!(["POST", "PUT", "PATCH"] as string[]).includes(rawMethod)) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;

    const key = `${rawMethod} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fixture = fixtureFor(routePath);
    const ctx = fixture === "factory" ? factoryCtx : erpCtx;
    routes.push({
      method: rawMethod as WriteMethod,
      manifestPath: routePath,
      requestPath: materialize(routePath, ctx),
      fixture,
    });
  }

  return routes;
}

async function authenticatedAgent(ctx: TestContext, prefix: string): Promise<request.SuperAgentTest> {
  const agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${prefix}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  const company = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(company.status).toBe(200);
  return agent;
}

function issue(agent: request.SuperAgentTest, route: SweptWriteRoute): request.Test {
  if (route.method === "POST") return agent.post(route.requestPath);
  if (route.method === "PUT") return agent.put(route.requestPath);
  return agent.patch(route.requestPath);
}

function seededPayload(ctx: TestContext, sequence: number, alternate: boolean): Record<string, unknown> {
  const stockItemId = ctx.stockItemIds[alternate && ctx.stockItemIds.length > 1 ? 1 : 0];
  const unique = `PH33-PW-${sequence}-${alternate ? "B" : "A"}`;
  const item = {
    stockItemId,
    itemId: stockItemId,
    productId: stockItemId,
    locationId: alternate ? ctx.location2Id : ctx.locationId,
    quantity: alternate ? 2 : 1,
    qty: alternate ? 2 : 1,
    rate: alternate ? 2 : 1,
    price: alternate ? 2 : 1,
    unitPrice: alternate ? 2 : 1,
    amount: alternate ? 4 : 1,
  };

  return {
    id: MISSING_ID,
    companyId: ctx.companyId,
    locationId: alternate ? ctx.location2Id : ctx.locationId,
    fromLocationId: ctx.locationId,
    toLocationId: ctx.location2Id,
    sourceLocationId: ctx.locationId,
    destinationLocationId: ctx.location2Id,
    stockItemId,
    itemId: stockItemId,
    productId: stockItemId,
    stockItemIds: [stockItemId],
    stockGroupId: ctx.stockGroupId,
    groupId: ctx.stockGroupId,
    accountId: alternate ? ctx.cashAccountId : ctx.salesAccountId,
    salesAccountId: ctx.salesAccountId,
    cashAccountId: ctx.cashAccountId,
    debitAccountId: ctx.salesAccountId,
    creditAccountId: ctx.cashAccountId,
    userId: ctx.userId,
    quantity: alternate ? 2 : 1,
    qty: alternate ? 2 : 1,
    amount: alternate ? 4 : 1,
    rate: alternate ? 2 : 1,
    cost: alternate ? 2 : 1,
    price: alternate ? 2 : 1,
    unitPrice: alternate ? 2 : 1,
    currency: alternate ? "CDF" : "USD",
    exchangeRate: alternate ? 2800 : 1,
    date: alternate ? "2026-09-16" : "2026-09-15",
    transactionDate: alternate ? "2026-09-16" : "2026-09-15",
    effectiveDate: alternate ? "2026-09-16" : "2026-09-15",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
    status: alternate ? "pending" : "active",
    type: alternate ? "manual" : "standard",
    name: `Phase 33 ${unique}`,
    code: unique,
    reference: unique,
    description: alternate ? "Phase 33 alternate seeded write" : "Phase 33 seeded write",
    notes: "Phase 33 seeded parameterized coverage probe",
    reason: "Phase 33 seeded parameterized coverage probe",
    active: !alternate,
    isActive: !alternate,
    approved: alternate,
    dryRun: true,
    preview: true,
    items: [item],
    lines: [item],
    entries: [
      { accountId: ctx.salesAccountId, debit: 1, credit: 0, description: unique },
      { accountId: ctx.cashAccountId, debit: 0, credit: 1, description: unique },
    ],
  };
}

describe("Phase 33 seeded parameterized write sweep", () => {
  let erpCtx: TestContext;
  let factoryCtx: TestContext;
  let erpAgent: request.SuperAgentTest;
  let factoryAgent: request.SuperAgentTest;
  let routes: SweptWriteRoute[] = [];

  beforeAll(async () => {
    erpCtx = await seedTestData(ERP_PREFIX);
    factoryCtx = await seedTestData(FACTORY_PREFIX);

    // seedTestData intentionally defaults unknown prefixes to ERP. Turn this
    // dedicated disposable tenant into a factory tenant without broadening the
    // shared fixture prefix registry, then restore the ERP parent-company pin.
    await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [factoryCtx.companyId]);
    await pool.query(
      "UPDATE system_settings SET value = $1, updated_at = now() WHERE key = 'parentCompanyId'",
      [String(erpCtx.companyId)]
    );

    erpAgent = await authenticatedAgent(erpCtx, ERP_PREFIX);
    factoryAgent = await authenticatedAgent(factoryCtx, FACTORY_PREFIX);
    routes = selectRoutes(loadManifest(), erpCtx, factoryCtx);
  }, 120_000);

  afterAll(async () => {
    // The matrix deliberately exercises unrelated successful write handlers.
    // Its tenants are unique and the CI shard database is disposable; trying to
    // generically delete every possible persisted child graph is less safe than
    // discarding the isolated database after the shard finishes.
    await closeTestServer();
  }, 120_000);

  it("drives real-reference parameterized writes across primary and alternate business branches", async () => {
    expect(routes.length).toBeGreaterThan(40);
    const failures: Array<{ method: string; route: string; variant: string; detail: string }> = [];

    for (const [index, route] of routes.entries()) {
      const ctx = route.fixture === "factory" ? factoryCtx : erpCtx;
      const agent = route.fixture === "factory" ? factoryAgent : erpAgent;

      for (const alternate of [false, true]) {
        try {
          const response = await issue(agent, route)
            .query({
              dryRun: true,
              preview: true,
              page: alternate ? 2 : 1,
              limit: alternate ? 1 : 10,
              locationId: alternate ? ctx.location2Id : ctx.locationId,
            })
            .send(seededPayload(ctx, index, alternate))
            .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
          expect(response.status).toBeGreaterThanOrEqual(200);
          expect(response.status).toBeLessThan(600);
        } catch (error) {
          failures.push({
            method: route.method,
            route: route.manifestPath,
            variant: alternate ? "alternate" : "primary",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  }, 600_000);
});
