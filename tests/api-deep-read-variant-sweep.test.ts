import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const ERP_PREFIX = "phase33deep";
const FACTORY_PREFIX = "facimp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = 2_147_483_000;
const REQUEST_TIMEOUT_MS = 15_000;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /(export|download|template)/i,
  /\.(xlsx|pdf|csv|zip)$/i,
  /(whatsapp|email|openai|gemini|ai-validation|track|trace|webhook)/i,
  // Live screen feed requests intentionally keep the connection open. They are
  // not finite read handlers and would make this bounded coverage sweep timeout.
  /\/api\/screen-feed\/live\//i,
];

interface DeepReadRoute {
  manifestPath: string;
  requestPath: string;
  fixture: "erp" | "factory";
}

function loadManifest(): SerializedRouteManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
}

function fixtureFor(routePath: string): "erp" | "factory" {
  return routePath.startsWith("/api/factory/") ? "factory" : "erp";
}

function resourceAwareValue(routePath: string, name: string, ctx: TestContext): string {
  const key = name.toLowerCase();
  const lowerPath = routePath.toLowerCase();

  if (key.includes("company")) return String(ctx.companyId);
  if (key.includes("location")) return String(ctx.locationId);
  if (key.includes("stockitem")) return String(ctx.stockItemIds[0]);
  if (key.includes("stockgroup")) return String(ctx.stockGroupId);
  if (key.includes("cashaccount")) return String(ctx.cashAccountId);
  if (key.includes("salesaccount") || key.includes("ledgeraccount")) return String(ctx.salesAccountId);
  if (key.includes("userid") || key === "user") return encodeURIComponent(ctx.userId);
  if (key.includes("year")) return "2026";
  if (key.includes("month")) return "9";
  if (key.includes("date")) return "2026-09-15";
  if (key.includes("currency")) return "USD";
  if (key.includes("status")) return "active";
  if (key.includes("code")) return "PHASE33";
  if (key.includes("type")) return "all";

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

export function materializeDeepReadPath(routePath: string, ctx: TestContext): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    encodeURIComponent(resourceAwareValue(routePath, name, ctx)),
  );
}

export function selectDeepReadRoutes(
  manifest: SerializedRouteManifest,
  erpCtx: TestContext,
  factoryCtx: TestContext,
): DeepReadRoute[] {
  const seen = new Set<string>();
  const routes: DeepReadRoute[] = [];

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET") continue;
    if (!routePath?.startsWith("/api/")) continue;
    if (routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;
    if (seen.has(routePath)) continue;
    seen.add(routePath);

    const fixture = fixtureFor(routePath);
    const ctx = fixture === "factory" ? factoryCtx : erpCtx;
    routes.push({
      manifestPath: routePath,
      requestPath: materializeDeepReadPath(routePath, ctx),
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

function queryFor(ctx: TestContext): Record<string, string | number | boolean> {
  return {
    page: 1,
    limit: 10,
    offset: 0,
    year: 2026,
    month: 9,
    startDate: "2026-09-01",
    endDate: "2026-09-15",
    fromDate: "2026-09-01",
    toDate: "2026-09-15",
    asOfDate: "2026-09-15",
    date: "2026-09-15",
    locationId: ctx.locationId,
    stockItemId: ctx.stockItemIds[0],
    stockGroupId: ctx.stockGroupId,
    accountId: ctx.salesAccountId,
    companyId: ctx.companyId,
    search: "test",
    q: "test",
    status: "all",
    type: "all",
    currency: "USD",
    includeZero: true,
    includeInactive: true,
  };
}

describe("deep backend read/query variant sweep", () => {
  let erpCtx: TestContext;
  let factoryCtx: TestContext;
  let erpAgent: request.SuperAgentTest;
  let factoryAgent: request.SuperAgentTest;
  let routes: DeepReadRoute[] = [];

  beforeAll(async () => {
    erpCtx = await seedTestData(ERP_PREFIX);
    factoryCtx = await seedTestData(FACTORY_PREFIX);
    erpAgent = await authenticatedAgent(erpCtx, ERP_PREFIX);
    factoryAgent = await authenticatedAgent(factoryCtx, FACTORY_PREFIX);
    routes = selectDeepReadRoutes(loadManifest(), erpCtx, factoryCtx);
  }, 120_000);

  afterAll(async () => {
    await cleanupTestData(ERP_PREFIX);
    await cleanupTestData(FACTORY_PREFIX);
    await closeTestServer();
  }, 120_000);

  it("drives safe GET handlers with valid seeded resource ids and rich query parameters", async () => {
    expect(routes.length).toBeGreaterThan(100);
    const transportFailures: Array<{ route: string; detail: string }> = [];

    for (const route of routes) {
      const ctx = route.fixture === "factory" ? factoryCtx : erpCtx;
      const agent = route.fixture === "factory" ? factoryAgent : erpAgent;
      try {
        const response = await agent
          .get(route.requestPath)
          .query(queryFor(ctx))
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(600);
      } catch (error) {
        transportFailures.push({
          route: route.manifestPath,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    expect(transportFailures, JSON.stringify(transportFailures, null, 2)).toEqual([]);
  }, 300_000);
});
