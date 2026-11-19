import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const ERP_PREFIX = "phase33imports";
const FACTORY_PREFIX = "facimp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = 2_147_482_700;
const REQUEST_TIMEOUT_MS = 12_000;

const IMPORT_PATTERN = /(import|upload|preview|validate-import)/i;
const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(auth|debug)(\/|$)/i,
  /(migration|migrate|cutover|repair|recalc|backup|restore|reset|seed|rebuild|purge)/i,
  /(whatsapp|email|openai|gemini|ai-validation|track|trace|webhook)/i,
  /(^|\/)(run|execute|trigger)(\/|$)/i,
];

type ImportMethod = "POST" | "PUT" | "PATCH";

interface ImportRoute {
  method: ImportMethod;
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
  if (key.includes("stockitem") || key === "itemid") return String(ctx.stockItemIds[0]);
  if (key.includes("stockgroup") || key === "groupid") return String(ctx.stockGroupId);
  if (key.includes("account")) return String(ctx.salesAccountId);
  if (key.includes("user")) return encodeURIComponent(ctx.userId);
  if (key.includes("year")) return "2026";
  if (key.includes("month")) return "9";
  if (key.includes("date")) return "2026-09-15";
  if (key.includes("type")) return "all";
  return String(MISSING_ID);
}

function materialize(routePath: string, ctx: TestContext): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    encodeURIComponent(replacementFor(name, ctx))
  );
}

function selectImportRoutes(
  manifest: SerializedRouteManifest,
  erpCtx: TestContext,
  factoryCtx: TestContext
): ImportRoute[] {
  const seen = new Set<string>();
  const routes: ImportRoute[] = [];

  for (const entry of manifest.routes) {
    const [rawMethod, routePath] = entry.split(" ");
    if (!routePath?.startsWith("/api/") || routePath.includes("*")) continue;
    if (!(["POST", "PUT", "PATCH"] as string[]).includes(rawMethod)) continue;
    if (!IMPORT_PATTERN.test(routePath)) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;

    const key = `${rawMethod} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fixture = routePath.startsWith("/api/factory/") ? "factory" : "erp";
    const ctx = fixture === "factory" ? factoryCtx : erpCtx;
    routes.push({
      method: rawMethod as ImportMethod,
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

function issue(agent: request.SuperAgentTest, route: ImportRoute): request.Test {
  if (route.method === "POST") return agent.post(route.requestPath);
  if (route.method === "PUT") return agent.put(route.requestPath);
  return agent.patch(route.requestPath);
}

describe("Phase 33 import/upload validation sweep", () => {
  let erpCtx: TestContext;
  let factoryCtx: TestContext;
  let erpAgent: request.SuperAgentTest;
  let factoryAgent: request.SuperAgentTest;
  let routes: ImportRoute[] = [];

  beforeAll(async () => {
    erpCtx = await seedTestData(ERP_PREFIX);
    factoryCtx = await seedTestData(FACTORY_PREFIX);
    erpAgent = await authenticatedAgent(erpCtx, ERP_PREFIX);
    factoryAgent = await authenticatedAgent(factoryCtx, FACTORY_PREFIX);
    routes = selectImportRoutes(loadManifest(), erpCtx, factoryCtx);
  }, 120_000);

  afterAll(async () => {
    await cleanupTestData(ERP_PREFIX);
    await cleanupTestData(FACTORY_PREFIX);
    await closeTestServer();
  }, 120_000);

  it("executes safe import endpoints through missing-file, malformed-body and malformed-file branches", async () => {
    expect(routes.length).toBeGreaterThan(20);
    const failures: Array<{ route: string; variant: string; detail: string }> = [];

    for (const route of routes) {
      const agent = route.fixture === "factory" ? factoryAgent : erpAgent;
      const variants: Array<{ name: string; run: () => request.Test }> = [
        {
          name: "empty-json",
          run: () => issue(agent, route).send({}),
        },
        {
          name: "malformed-json",
          run: () =>
            issue(agent, route).send({
              rows: [{ id: "not-an-id", quantity: "not-a-number", amount: "invalid" }],
              data: [{ code: "PHASE33-BAD", value: null }],
              dryRun: true,
              preview: true,
            }),
        },
        {
          name: "malformed-file",
          run: () =>
            issue(agent, route)
              .field("dryRun", "true")
              .attach("file", Buffer.from("not,a,valid,spreadsheet\nphase33,bad,data"), "phase33-invalid.csv"),
        },
      ];

      for (const variant of variants) {
        try {
          const response = await variant.run().timeout({
            response: REQUEST_TIMEOUT_MS,
            deadline: REQUEST_TIMEOUT_MS,
          });
          expect(response.status).toBeGreaterThanOrEqual(200);
          expect(response.status).toBeLessThan(600);
        } catch (error) {
          failures.push({
            route: route.manifestPath,
            variant: variant.name,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  }, 600_000);
});
