/**
 * Factory-mode JSONCargo ETA Tracking — unit + integration tests.
 *
 * Mirrors tests/jsoncargo-eta-tracking.test.ts but targets factory_containers
 * (arrivalDate as the ETA field, no etaSource column) and the
 * /api/factory/containers/... routes. All JSONCargo HTTP calls are mocked via
 * vi.stubGlobal("fetch", ...); no real network requests or API key are needed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import { eq } from "drizzle-orm";
import * as schema from "../shared/schema";
import { factoryContainers, factorySuppliers } from "../shared/schema/factory";
import {
  refreshFactoryContainerEta,
  refreshMultipleFactoryContainerEtas,
} from "../server/services/factoryJsonCargoTrackingService";

const TEST_PREFIX = "factjcargo";

let erpCtx: TestContext;
let factoryCompanyId: number;
let supplierId: number;
let agent: request.SuperAgentTest;
let managerAgent: request.SuperAgentTest;

function mockFetchOnce(response: { status: number; body?: any; throwError?: Error }) {
  return vi.fn(async () => {
    if (response.throwError) throw response.throwError;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body ?? {},
    } as any;
  });
}

async function makeFactoryContainer(overrides: Partial<typeof factoryContainers.$inferInsert> = {}) {
  const [row] = await db
    .insert(factoryContainers)
    .values({
      companyId: factoryCompanyId,
      containerNumber: overrides.containerNumber ?? `MSCU${Math.floor(1000000 + Math.random() * 8999999)}`,
      supplierId,
      status: "PENDING",
      trackingCarrierHint: "MSC",
      trackingEnabled: true,
      ...overrides,
    } as any)
    .returning();
  return row;
}

async function cleanupFactoryTables() {
  await pool.query("DELETE FROM factory_containers WHERE company_id = $1", [factoryCompanyId]);
  await pool.query("DELETE FROM factory_suppliers WHERE company_id = $1", [factoryCompanyId]);
}

beforeAll(async () => {
  // Purge any leftovers from a previous failed run before deleting parent companies.
  await pool.query("DELETE FROM factory_containers WHERE company_id IN (SELECT id FROM companies WHERE name LIKE $1)", [
    `%${TEST_PREFIX}%`,
  ]);
  await pool.query("DELETE FROM factory_suppliers WHERE company_id IN (SELECT id FROM companies WHERE name LIKE $1)", [
    `%${TEST_PREFIX}%`,
  ]);

  // Seed a minimal ERP context just to spin up the shared app server.
  erpCtx = await seedTestData(TEST_PREFIX);
  const app = erpCtx.app;

  const bcrypt = await import("bcryptjs");
  const hashedPw = await bcrypt.hash("testpassword123", 10);

  const [factoryUser] = await db
    .insert(schema.users)
    .values({ username: `${TEST_PREFIX}_factuser`, password: hashedPw })
    .returning();

  const [factoryCompany] = await db
    .insert(schema.companies)
    .values({
      code: "FACTJC",
      name: `${TEST_PREFIX}_FactoryCompany`,
      baseCurrency: "USD",
      companyType: "factory",
    })
    .returning();
  factoryCompanyId = factoryCompany.id;

  await db.insert(schema.userCompanyRoles).values({
    userId: factoryUser.id,
    companyId: factoryCompanyId,
    role: "Admin",
  });

  const [supplier] = await db
    .insert(factorySuppliers)
    .values({
      companyId: factoryCompanyId,
      name: `${TEST_PREFIX}_Supplier`,
    })
    .returning();
  supplierId = supplier.id;

  agent = request.agent(app);
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_factuser`, password: "testpassword123" });
  if (loginRes.status !== 200) {
    throw new Error(`login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  await agent.post("/api/auth/set-company").send({ companyId: factoryCompanyId });

  // A second, non-admin user for role-gating checks on the bulk route.
  const [managerUser] = await db
    .insert(schema.users)
    .values({ username: `${TEST_PREFIX}_manager`, password: hashedPw })
    .returning();
  await db.insert(schema.userCompanyRoles).values({
    userId: managerUser.id,
    companyId: factoryCompanyId,
    role: "Manager",
  });
  managerAgent = request.agent(app);
  const mgrLogin = await managerAgent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_manager`, password: "testpassword123" });
  if (mgrLogin.status !== 200) {
    throw new Error(`manager login failed: ${mgrLogin.status} ${JSON.stringify(mgrLogin.body)}`);
  }
  await managerAgent.post("/api/auth/set-company").send({ companyId: factoryCompanyId });
});

afterAll(async () => {
  await pool.query("DELETE FROM login_history WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)", [
    `%${TEST_PREFIX}%`,
  ]);
  await cleanupFactoryTables();
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
});

beforeEach(() => {
  process.env.JSONCARGO_API_KEY = "test-key-not-real";
  process.env.JSONCARGO_REFRESH_HOURS = "168";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JSONCARGO_API_KEY;
  delete process.env.JSONCARGO_REFRESH_HOURS;
});

describe("refreshFactoryContainerEta (service, mocked HTTP)", () => {
  it("updates arrivalDate on a successful response", async () => {
    const container = await makeFactoryContainer();
    vi.stubGlobal("fetch", mockFetchOnce({ status: 200, body: { data: { eta_final_destination: "2026-09-15" } } }));
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("updated");
    expect(result.newEta).toBe("2026-09-15");

    const [updated] = await db.select().from(factoryContainers).where(eq(factoryContainers.id, container.id));
    expect(updated.arrivalDate).toBe("2026-09-15");
    expect(updated.jsonCargoTrackingStatus).toBe("SUCCESS");
  });

  it("never blanks an existing arrivalDate when the provider returns no ETA", async () => {
    const container = await makeFactoryContainer({ arrivalDate: "2026-05-01" });
    vi.stubGlobal("fetch", mockFetchOnce({ status: 200, body: { data: { eta_final_destination: null } } }));
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("no_eta");
    expect(result.newEta).toBe("2026-05-01");

    const [row] = await db.select().from(factoryContainers).where(eq(factoryContainers.id, container.id));
    expect(row.arrivalDate).toBe("2026-05-01");
    expect(row.jsonCargoTrackingStatus).toBe("NO_ETA");
  });

  it("never blanks an existing arrivalDate on not_found", async () => {
    const container = await makeFactoryContainer({ arrivalDate: "2026-05-01" });
    vi.stubGlobal("fetch", mockFetchOnce({ status: 404 }));
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("not_found");
    expect(result.newEta).toBe("2026-05-01");
  });

  it("never blanks an existing arrivalDate on a transient error", async () => {
    const container = await makeFactoryContainer({ arrivalDate: "2026-05-01" });
    vi.stubGlobal("fetch", mockFetchOnce({ status: 503 }));
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("error");
    expect(result.newEta).toBe("2026-05-01");
  });

  it("skips unsupported carriers without calling the API", async () => {
    const container = await makeFactoryContainer({ trackingCarrierHint: "Evergreen" });
    const fetchMock = mockFetchOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("unsupported_carrier");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips containers with no carrier hint at all", async () => {
    const container = await makeFactoryContainer({ trackingCarrierHint: null });
    const fetchMock = mockFetchOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("unsupported_carrier");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips inactive (offloaded) containers without calling the API", async () => {
    const container = await makeFactoryContainer({ status: "OFFLOADED" });
    const fetchMock = mockFetchOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("inactive");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips containers checked within the refresh window, without calling the API", async () => {
    const container = await makeFactoryContainer({ jsonCargoLastCheckedAt: new Date() as any });
    const fetchMock = mockFetchOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const result = await refreshFactoryContainerEta(container.id);
    expect(result.status).toBe("skipped_recent");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forceRefresh bypasses the weekly window and calls the API", async () => {
    const container = await makeFactoryContainer({ jsonCargoLastCheckedAt: new Date() as any });
    const fetchMock = mockFetchOnce({ status: 200, body: { data: { eta_final_destination: "2026-10-01" } } });
    vi.stubGlobal("fetch", fetchMock);
    const result = await refreshFactoryContainerEta(container.id, { forceRefresh: true });
    expect(result.status).toBe("updated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("refreshMultipleFactoryContainerEtas (bulk)", () => {
  it("dedupes ids and aggregates status counts without exceeding the batch", async () => {
    const c1 = await makeFactoryContainer();
    const c2 = await makeFactoryContainer({ trackingCarrierHint: "Evergreen" }); // unsupported
    const c3 = await makeFactoryContainer({ status: "OFFLOADED" }); // inactive
    vi.stubGlobal("fetch", mockFetchOnce({ status: 200, body: { data: { eta_final_destination: "2026-12-01" } } }));

    const summary = await refreshMultipleFactoryContainerEtas([c1.id, c1.id, c2.id, c3.id]);
    expect(summary.total).toBe(3); // deduped
    expect(summary.updated).toBe(1);
    expect(summary.unsupportedCarrier).toBe(1);
    expect(summary.inactive).toBe(1);
  });
});

describe("factory routes — permissions and company isolation", () => {
  it("rejects unauthenticated refresh-eta requests", async () => {
    const container = await makeFactoryContainer();
    const res = await request(erpCtx.app).post(`/api/factory/containers/${container.id}/refresh-eta`).send({});
    expect(res.status).toBe(401);
  });

  // Automated carrier tracking is disabled (66c6aa5): ETA refresh answers 410
  // for every role, single or bulk, before any lookup, and never calls a carrier.
  it("answers 410 for single and bulk ETA refresh without calling a carrier", async () => {
    const container = await makeFactoryContainer();
    const carrier = vi.fn();
    vi.stubGlobal("fetch", carrier);
    const attempts = [
      managerAgent.post(`/api/factory/containers/${container.id}/refresh-eta`).send({}),
      agent.post(`/api/factory/containers/${container.id}/refresh-eta`).send({}),
      managerAgent.post("/api/factory/containers/refresh-etas").send({}),
      agent.post("/api/factory/containers/refresh-etas").send({}),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(410);
    }
    expect(carrier).not.toHaveBeenCalled();
  });

  it("returns a safe summary with no secrets on GET eta-tracking-summary", async () => {
    const res = await agent.get("/api/factory/containers/eta-tracking-summary");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("configured");
    expect(res.body).toHaveProperty("supportedCarriers");
    expect(JSON.stringify(res.body)).not.toContain("test-key-not-real");
  });
});
