import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const ERP_PREFIX = "phase33reports";
const FACTORY_PREFIX = "facimp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = 2_147_482_800;
const REQUEST_TIMEOUT_MS = 15_000;

const REPORT_PATTERN = /(report|statement|export|download|template|excel|pdf|summary|history)/i;
const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(^|\/)(run|apply|execute|trigger|sync|refresh)(\/|$)/i,
  /(whatsapp|email|openai|gemini|ai-validation|track|trace|webhook)/i,
  /\/api\/screen-feed\/live\//i,
];

interface SweptReadRoute {
  manifestPath: string;
  requestPath: string;
  fixture: "erp" | "factory";
}

function loadManifest(): SerializedRouteManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
}

function replacementFor(name: string, ctx: TestContext): string {
  const key = name.toLowerCase();
  if (key.includes("company")) return String(ctx.companyId);
  if (key.includes("location")) return String(ctx.locationId);
  if (key.includes("stockitem") || key === "itemid" || key === "productid") return String(ctx.stockItemIds[0]);
  if (key.includes("stockgroup") || key === "groupid") return String(ctx.stockGroupId);
  if (key.includes("cashaccount")) return String(ctx.cashAccountId);
  if (key.includes("salesaccount") || key === "accountid" || key === "ledgeraccountid") {
    return String(ctx.salesAccountId);
  }
  if (key.includes("userid") || key === "user") return encodeURIComponent(ctx.userId);
  if (key.includes("year")) return "2026";
  if (key.includes("month")) return "9";
  if (key.includes("date")) return "2026-09-15";
  if (key.includes("currency")) return "USD";
  if (key.includes("status")) return "active";
  if (key.includes("code")) return "PHASE33";
  if (key.includes("type")) return "all";
  return String(MISSING_ID);
}

function materialize(routePath: string, ctx: TestContext): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    encodeURIComponent(replacementFor(name, ctx))
  );
}

function selectRoutes(manifest: SerializedRouteManifest, erpCtx: TestContext, factoryCtx: TestContext): SweptReadRoute[] {
  const selected: SweptReadRoute[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "GET") continue;
    if (!routePath?.startsWith("/api/") || routePath.includes("*")) continue;
    if (!REPORT_PATTERN.test(routePath)) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;
    if (seen.has(routePath)) continue;
    seen.add(routePath);

    const fixture = routePath.startsWith("/api/factory/") ? "factory" : "erp";
    const ctx = fixture === "factory" ? factoryCtx : erpCtx;
    selected.push({ manifestPath: routePath, requestPath: materialize(routePath, ctx), fixture });
  }

  return selected;
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

describe("Phase 33 report/export/statement read-surface sweep", () => {
  let erpCtx: TestContext;
  let factoryCtx: TestContext;
  let erpAgent: request.SuperAgentTest;
  let factoryAgent: request.SuperAgentTest;
  let routes: SweptReadRoute[] = [];

  beforeAll(async () => {
    erpCtx = await seedTestData(ERP_PREFIX);
    factoryCtx = await seedTestData(FACTORY_PREFIX);
    erpAgent = await authenticatedAgent(erpCtx, ERP_PREFIX);
    factoryAgent = await authenticatedAgent(factoryCtx, FACTORY_PREFIX);
    routes = selectRoutes(loadManifest(), erpCtx, factoryCtx);
  }, 120_000);

  afterAll(async () => {
    await cleanupTestData(ERP_PREFIX);
    await cleanupTestData(FACTORY_PREFIX);
    await closeTestServer();
  }, 120_000);

  it("executes the excluded reporting surface with realistic date/query inputs", async () => {
    expect(routes.length).toBeGreaterThan(75);

    const failures: Array<{ route: string; requestPath: string; detail: string }> = [];

    for (const route of routes) {
      const agent = route.fixture === "factory" ? factoryAgent : erpAgent;
      try {
        const response = await agent
          .get(route.requestPath)
          .query({
            limit: 1,
            page: 1,
            year: 2026,
            month: 9,
            fromDate: "2026-09-01",
            toDate: "2026-09-15",
            startDate: "2026-09-01",
            endDate: "2026-09-15",
            currency: "USD",
          })
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(600);
      } catch (error) {
        failures.push({
          route: route.manifestPath,
          requestPath: route.requestPath,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  }, 600_000);
});
