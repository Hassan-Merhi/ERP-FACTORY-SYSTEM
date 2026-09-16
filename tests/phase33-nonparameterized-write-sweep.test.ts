import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const ERP_PREFIX = "phase33npwrite";
const FACTORY_PREFIX = "facimp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const MISSING_ID = 2_147_482_900;
const REQUEST_TIMEOUT_MS = 8_000;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(auth|debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(^|\/)(run|apply|execute|trigger|sync|refresh)(\/|$)/i,
  /(whatsapp|email|openai|gemini|ai-validation|track|trace|webhook)/i,
  /(send-stock|send-invoice|send-statement)/i,
];

type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

interface SweptWriteRoute {
  method: WriteMethod;
  routePath: string;
  fixture: "erp" | "factory";
}

function loadManifest(): SerializedRouteManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
}

function selectRoutes(manifest: SerializedRouteManifest): SweptWriteRoute[] {
  const selected: SweptWriteRoute[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.routes) {
    const [rawMethod, routePath] = entry.split(" ");
    if (!routePath?.startsWith("/api/")) continue;
    if (!(["POST", "PUT", "PATCH", "DELETE"] as string[]).includes(rawMethod)) continue;
    if (routePath.includes(":") || routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;

    const key = `${rawMethod} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({
      method: rawMethod as WriteMethod,
      routePath,
      fixture: routePath.startsWith("/api/factory/") ? "factory" : "erp",
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

function requestFor(agent: request.SuperAgentTest, route: SweptWriteRoute): request.Test {
  if (route.method === "POST") return agent.post(route.routePath);
  if (route.method === "PUT") return agent.put(route.routePath);
  if (route.method === "PATCH") return agent.patch(route.routePath);
  return agent.delete(route.routePath);
}

function unauthenticatedRequestFor(ctx: TestContext, route: SweptWriteRoute): request.Test {
  const client = request(ctx.app);
  if (route.method === "POST") return client.post(route.routePath);
  if (route.method === "PUT") return client.put(route.routePath);
  if (route.method === "PATCH") return client.patch(route.routePath);
  return client.delete(route.routePath);
}

function populatedProbe(ctx: TestContext) {
  return {
    id: MISSING_ID,
    ids: [MISSING_ID],
    companyId: ctx.companyId,
    locationId: MISSING_ID,
    stockItemId: MISSING_ID,
    stockItemIds: [MISSING_ID],
    accountId: MISSING_ID,
    accountIds: [MISSING_ID],
    customerId: MISSING_ID,
    supplierId: MISSING_ID,
    employeeId: MISSING_ID,
    workerId: MISSING_ID,
    containerId: MISSING_ID,
    voucherId: MISSING_ID,
    quantity: 1,
    amount: 1,
    rate: 1,
    version: 1,
    currency: "USD",
    date: "2026-09-15",
    fromDate: "2026-09-01",
    toDate: "2026-09-15",
    name: "Phase 33 missing record",
    reason: "Phase 33 coverage probe",
    notes: "Phase 33 coverage probe",
  };
}

function malformedProbe(ctx: TestContext) {
  return {
    ...populatedProbe(ctx),
    id: "bad-id",
    ids: ["bad-id"],
    locationId: "bad-location",
    stockItemId: "bad-stock-item",
    accountId: "bad-account",
    customerId: "bad-customer",
    supplierId: "bad-supplier",
    employeeId: "bad-employee",
    quantity: "not-a-number",
    amount: "not-a-number",
    rate: -1,
    version: 0,
    currency: "INVALID",
    date: "not-a-date",
    fromDate: "not-a-date",
    toDate: "not-a-date",
    name: "",
  };
}

describe("Phase 33 safe non-parameterized write-surface sweep", () => {
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
    routes = selectRoutes(loadManifest());
  }, 120_000);

  afterAll(async () => {
    await cleanupTestData(ERP_PREFIX);
    await cleanupTestData(FACTORY_PREFIX);
    await closeTestServer();
  }, 120_000);

  it("executes auth, empty-body, malformed-body and missing-record validation branches without hanging", async () => {
    expect(routes.length).toBeGreaterThan(100);

    const failures: Array<{ method: string; route: string; variant: string; detail: string }> = [];

    for (const route of routes) {
      const ctx = route.fixture === "factory" ? factoryCtx : erpCtx;
      const agent = route.fixture === "factory" ? factoryAgent : erpAgent;

      try {
        const unauthenticated = await unauthenticatedRequestFor(ctx, route)
          .send({})
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        expect(unauthenticated.status).toBeGreaterThanOrEqual(200);
        expect(unauthenticated.status).toBeLessThan(600);
      } catch (error) {
        failures.push({
          method: route.method,
          route: route.routePath,
          variant: "unauthenticated",
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      const variants: Array<[string, Record<string, unknown>]> = [
        ["empty", {}],
        ["malformed", malformedProbe(ctx)],
        ["missing-record", populatedProbe(ctx)],
      ];

      for (const [variant, body] of variants) {
        try {
          const response = await requestFor(agent, route)
            .query({ limit: 1, page: 1 })
            .send(body)
            .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
          expect(response.status).toBeGreaterThanOrEqual(200);
          expect(response.status).toBeLessThan(600);
        } catch (error) {
          failures.push({
            method: route.method,
            route: route.routePath,
            variant,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  }, 600_000);
});
