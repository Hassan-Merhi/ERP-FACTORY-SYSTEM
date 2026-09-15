import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const ERP_PREFIX = "phase33write";
const FACTORY_PREFIX = "facimp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = 2_147_483_000;
const REQUEST_TIMEOUT_MS = 10_000;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(auth|debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(^|\/)(run|apply|execute|trigger|sync)(\/|$)/i,
  /(export|download|template|upload|import)/i,
  /\.(xlsx|pdf|csv|zip)$/i,
  /(whatsapp|email|openai|gemini|ai-validation|track|trace|webhook)/i,
];

interface SweptWriteRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
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

function missingValueFor(name: string): string {
  const key = name.toLowerCase();
  if (key.includes("year")) return "2026";
  if (key.includes("month")) return "9";
  if (key.includes("date")) return "2026-09-15";
  if (key.includes("currency")) return "USD";
  if (key.includes("status")) return "active";
  if (key.includes("code")) return "PHASE33-MISSING";
  if (key.includes("type")) return "all";
  if (key.includes("name")) return "phase33-missing";
  return String(MISSING_ID);
}

export function materializeMissingWritePath(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    encodeURIComponent(missingValueFor(name)),
  );
}

export function selectParameterizedWriteRoutes(manifest: SerializedRouteManifest): SweptWriteRoute[] {
  const seen = new Set<string>();
  const selected: SweptWriteRoute[] = [];

  for (const entry of manifest.routes) {
    const [rawMethod, routePath] = entry.split(" ");
    if (!routePath?.startsWith("/api/")) continue;
    if (!routePath.includes(":")) continue;
    if (routePath.includes("*")) continue;
    if (!(["POST", "PUT", "PATCH", "DELETE"] as string[]).includes(rawMethod)) {
      continue;
    }
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;

    const method = rawMethod as SweptWriteRoute["method"];
    const key = `${method} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    selected.push({
      method,
      manifestPath: routePath,
      requestPath: materializeMissingWritePath(routePath),
      fixture: fixtureFor(routePath),
    });
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

function issueWrite(agent: request.SuperAgentTest, route: SweptWriteRoute, ctx: TestContext): request.Test {
  const test =
    route.method === "POST"
      ? agent.post(route.requestPath)
      : route.method === "PUT"
        ? agent.put(route.requestPath)
        : route.method === "PATCH"
          ? agent.patch(route.requestPath)
          : agent.delete(route.requestPath);

  return test.send({
    id: MISSING_ID,
    companyId: ctx.companyId,
    locationId: MISSING_ID,
    stockItemId: MISSING_ID,
    accountId: MISSING_ID,
    customerId: MISSING_ID,
    supplierId: MISSING_ID,
    employeeId: MISSING_ID,
    quantity: 1,
    amount: 1,
    version: 1,
    reason: "Phase 33 coverage probe",
    name: "Phase 33 missing record",
  });
}

describe("parameterized backend write/error-path sweep", () => {
  let erpCtx: TestContext;
  let factoryCtx: TestContext;
  let erpAgent: request.SuperAgentTest;
  let factoryAgent: request.SuperAgentTest;
  let routes: SweptWriteRoute[] = [];

  beforeAll(async () => {
    erpCtx = await seedTestData(ERP_PREFIX);
    factoryCtx = await seedTestData(FACTORY_PREFIX);
    erpAgent = await authenticatedAgent(erpCtx, ERP_PREFIX);
    factoryAgent = await authenticatedAgent(factoryCtx, FACTORY_PREFIX);
    routes = selectParameterizedWriteRoutes(loadManifest());
  }, 120_000);

  afterAll(async () => {
    await cleanupTestData(ERP_PREFIX);
    await cleanupTestData(FACTORY_PREFIX);
    await closeTestServer();
  }, 120_000);

  it("executes safe missing-record write paths without hanging or escaping HTTP", async () => {
    expect(routes.length).toBeGreaterThan(20);

    const timeouts: Array<{ method: string; route: string; detail: string }> = [];

    for (const route of routes) {
      const ctx = route.fixture === "factory" ? factoryCtx : erpCtx;
      const agent = route.fixture === "factory" ? factoryAgent : erpAgent;

      try {
        const response = await issueWrite(agent, route, ctx).timeout({
          response: REQUEST_TIMEOUT_MS,
          deadline: REQUEST_TIMEOUT_MS,
        });
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(600);
      } catch (error) {
        timeouts.push({
          method: route.method,
          route: route.manifestPath,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    expect(timeouts, JSON.stringify(timeouts, null, 2)).toEqual([]);
  }, 300_000);
});
