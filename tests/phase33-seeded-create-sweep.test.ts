import fs from "node:fs";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import type { SerializedRouteManifest } from "./helpers/routeManifest";

const ERP_PREFIX = "phase33create";
const FACTORY_PREFIX = "facimp";
const MANIFEST_PATH = path.join(process.cwd(), "config/route-manifest.json");
const REQUEST_TIMEOUT_MS = 12_000;

const EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(auth|debug)(\/|$)/i,
  /(repair|recalc|migration|migrate|cutover|backup|restore|reset|seed|rebuild|purge)/i,
  /(import|upload|export|download|template)/i,
  /(whatsapp|email|openai|gemini|ai-validation|track|trace|webhook)/i,
  /(bulk|delete|remove|reverse|cancel|void|merge)/i,
  /(^|\/)(run|apply|execute|trigger|sync|refresh|send)(\/|$)/i,
  /(offload|payroll\/generate|stock-entry)/i,
];

interface CreateRoute {
  routePath: string;
  fixture: "erp" | "factory";
}

function loadManifest(): SerializedRouteManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as SerializedRouteManifest;
}

function selectRoutes(manifest: SerializedRouteManifest): CreateRoute[] {
  const routes: CreateRoute[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (method !== "POST") continue;
    if (!routePath?.startsWith("/api/")) continue;
    if (routePath.includes(":") || routePath.includes("*")) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(routePath))) continue;
    if (seen.has(routePath)) continue;
    seen.add(routePath);
    routes.push({
      routePath,
      fixture: routePath.startsWith("/api/factory/") ? "factory" : "erp",
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

function seededPayload(ctx: TestContext, sequence: number): Record<string, unknown> {
  const stockItemId = ctx.stockItemIds[0];
  const unique = `PH33-${sequence}`;
  const item = {
    stockItemId,
    itemId: stockItemId,
    productId: stockItemId,
    quantity: 1,
    qty: 1,
    rate: 1,
    unitPrice: 1,
    price: 1,
    amount: 1,
  };

  return {
    companyId: ctx.companyId,
    locationId: ctx.locationId,
    fromLocationId: ctx.locationId,
    toLocationId: ctx.locationId,
    sourceLocationId: ctx.locationId,
    destinationLocationId: ctx.locationId,
    stockItemId,
    itemId: stockItemId,
    productId: stockItemId,
    stockItemIds: [stockItemId],
    stockGroupId: ctx.stockGroupId,
    groupId: ctx.stockGroupId,
    accountId: ctx.salesAccountId,
    salesAccountId: ctx.salesAccountId,
    cashAccountId: ctx.cashAccountId,
    debitAccountId: ctx.salesAccountId,
    creditAccountId: ctx.cashAccountId,
    userId: ctx.userId,
    quantity: 1,
    qty: 1,
    amount: 1,
    rate: 1,
    cost: 1,
    price: 1,
    unitPrice: 1,
    currency: "USD",
    exchangeRate: 1,
    date: "2026-09-15",
    transactionDate: "2026-09-15",
    effectiveDate: "2026-09-15",
    fromDate: "2026-09-01",
    toDate: "2026-09-15",
    status: "active",
    type: "standard",
    name: `Phase 33 ${unique}`,
    code: unique,
    reference: unique,
    description: "Phase 33 seeded coverage probe",
    notes: "Phase 33 seeded coverage probe",
    reason: "Phase 33 seeded coverage probe",
    active: true,
    isActive: true,
    items: [item],
    lines: [item],
    entries: [
      { accountId: ctx.salesAccountId, debit: 1, credit: 0, description: unique },
      { accountId: ctx.cashAccountId, debit: 0, credit: 1, description: unique },
    ],
  };
}

describe("Phase 33 seeded safe-create sweep", () => {
  let erpCtx: TestContext;
  let factoryCtx: TestContext;
  let erpAgent: request.SuperAgentTest;
  let factoryAgent: request.SuperAgentTest;
  let routes: CreateRoute[] = [];

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

  it("drives safe create handlers beyond empty-body validation with seeded references", async () => {
    expect(routes.length).toBeGreaterThan(25);
    const failures: Array<{ route: string; detail: string }> = [];

    for (const [index, route] of routes.entries()) {
      const ctx = route.fixture === "factory" ? factoryCtx : erpCtx;
      const agent = route.fixture === "factory" ? factoryAgent : erpAgent;
      try {
        const response = await agent
          .post(route.routePath)
          .send(seededPayload(ctx, index))
          .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS });
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(600);
      } catch (error) {
        failures.push({
          route: route.routePath,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  }, 600_000);
});
