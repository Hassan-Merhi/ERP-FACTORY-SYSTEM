import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "ctplan6";
const ARTICLE_A = "CTP6-A";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let planId: number | null = null;
let containerId = 0;
let baleSequence = 0;

async function addBales(quantity: number): Promise<void> {
  for (let index = 0; index < quantity; index += 1) {
    baleSequence += 1;
    const baleCode = `${TEST_PREFIX}-${String(baleSequence).padStart(3, "0")}`;
    await pool.query(
      `INSERT INTO factory_bales
         (company_id, bale_code, reference_number, article_code, product_name,
          erp_location_id, weight_kg, cost_per_kg, total_cost, status)
       VALUES ($1, $2, $2, $3, $4, $5, '25.000', '1.0000000', '25.0000000', 'IN_STOCK')`,
      [ctx.companyId, baleCode, ARTICLE_A, `${ARTICLE_A} Product`, ctx.locationId]
    );
  }
}

async function setStatus(toStatus: string, note?: string) {
  return agent
    .post(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/shipment/status`)
    .send({ toStatus, note });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);

  agent = request.agent(ctx.app);
  expect(
    (
      await agent.post("/api/auth/login").send({
        username: `${TEST_PREFIX}_testuser`,
        password: "testpassword123",
      })
    ).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  await addBales(4);

  const created = await agent.post("/api/factory/v5/container-plans").send({
    name: "Phase 6 Shipment Plan",
    capacityBales: 4,
    includeGarbageWipers: false,
    clientRequestId: "ctplan6-initial",
  });
  expect(created.status).toBe(201);
  planId = Number(created.body.plan.id);
  containerId = Number(created.body.plan.containers[0].id);
}, 120_000);

afterAll(async () => {
  if (planId) {
    await pool.query("DELETE FROM factory_container_plans WHERE id = $1 AND company_id = $2", [planId, ctx.companyId]);
  }
  await pool.query("DELETE FROM factory_bales WHERE company_id = $1 AND article_code = $2", [ctx.companyId, ARTICLE_A]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Factory container planner phase 6 API", () => {
  it("starts every container at PLANNED", async () => {
    const response = await agent.get(`/api/factory/v5/container-plans/${planId}/shipments`);
    expect(response.status).toBe(200);
    expect(response.body.summary.byStatus.PLANNED).toBe(1);
    expect(response.body.summary.containers[0].lifecycleStatus).toBe("PLANNED");
    expect(response.body.summary.containers[0].isCommitted).toBe(false);
    expect(response.body.summary.containers[0].nextStatus).toBe("LOADING");
  });

  it("refuses to skip a lifecycle step", async () => {
    const response = await setStatus("SHIPPED");
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("NOT_ADJACENT");
  });

  it("locks the container the moment it leaves PLANNED", async () => {
    const loading = await setStatus("LOADING", "Started loading");
    expect(loading.status).toBe(200);
    expect(loading.body.summary.containers[0].isCommitted).toBe(true);

    const detail = await agent.get(`/api/factory/v5/container-plans/${planId}`);
    expect(detail.body.plan.containers[0].isLocked).toBe(true);

    const unlock = await agent
      .patch(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/lock`)
      .send({ isLocked: false });
    expect(unlock.status).toBe(409);
    expect(unlock.body.code).toBe("CONTAINER_SHIPMENT_COMMITTED");
  });

  it("refuses LOADED until every planned bale is physically assigned", async () => {
    const blocked = await setStatus("LOADED");
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("BALES_NOT_ASSIGNED");

    // Assignment needs the container unlocked, so walk the status back first.
    expect((await setStatus("PLANNED")).status).toBe(200);
    expect(
      (
        await agent
          .post(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/bales`)
          .send({ auto: true })
      ).status
    ).toBe(200);

    expect((await setStatus("LOADING")).status).toBe(200);
    const loaded = await setStatus("LOADED");
    expect(loaded.status).toBe(200);
    expect(loaded.body.summary.containers[0].assignedQty).toBe(4);
  }, 60_000);

  it("refuses SHIPPED until the container number and carrier exist, then accepts it", async () => {
    const blocked = await setStatus("SHIPPED");
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("SHIPMENT_DETAILS_MISSING");
    expect(blocked.body.missingFields).toEqual(["containerNumber", "carrier"]);

    const badDate = await agent
      .patch(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/shipment`)
      .send({ containerNumber: "MSKU1234567", carrier: "Maersk", etd: "01/10/2026" });
    expect(badDate.status).toBe(400);

    const details = await agent
      .patch(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/shipment`)
      .send({
        containerNumber: "MSKU1234567",
        carrier: "Maersk",
        bookingNumber: "BK-99001",
        vesselName: "Maersk Kotka",
        destination: "Beirut, Lebanon",
        etd: "2026-10-01",
        eta: "2026-10-18",
      });
    expect(details.status).toBe(200);
    expect(details.body.summary.containers[0].destination).toBe("Beirut, Lebanon");
    expect(details.body.summary.containers[0].etd).toBe("2026-10-01");

    const shipped = await setStatus("SHIPPED", "Sailed on schedule");
    expect(shipped.status).toBe(200);
    expect(shipped.body.summary.shippedContainers).toBe(1);
  });

  it("walks through arrival and delivery, then treats delivery as terminal", async () => {
    expect((await setStatus("ARRIVED")).status).toBe(200);
    const delivered = await setStatus("DELIVERED", "Signed for by consignee");
    expect(delivered.status).toBe(200);
    expect(delivered.body.summary.deliveredContainers).toBe(1);
    expect(delivered.body.summary.containers[0].nextStatus).toBeNull();

    const reversal = await setStatus("ARRIVED");
    expect(reversal.status).toBe(409);
    expect(reversal.body.code).toBe("TERMINAL_STATUS");
  });

  it("keeps a full timeline of every status change", async () => {
    const response = await agent.get(
      `/api/factory/v5/container-plans/${planId}/containers/${containerId}/shipment/timeline`
    );
    expect(response.status).toBe(200);
    expect(response.body.events[0].toStatus).toBe("DELIVERED");
    expect(response.body.events[0].note).toBe("Signed for by consignee");
    expect(response.body.events.map((event: { toStatus: string }) => event.toStatus)).toContain("PLANNED");
    expect(response.body.events.length).toBeGreaterThanOrEqual(7);
  });

  it("stores and removes shipping documents", async () => {
    const created = await agent
      .post(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/documents`)
      .send({
        documentType: "BILL_OF_LADING",
        title: "B/L MAEU123456",
        reference: "MAEU123456",
        issuedOn: "2026-10-02",
      });
    expect(created.status).toBe(201);
    const documentId = Number(created.body.document.id);

    const rejected = await agent
      .post(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/documents`)
      .send({ documentType: "NOT_A_TYPE", title: "x" });
    expect(rejected.status).toBe(400);

    const listed = await agent.get(
      `/api/factory/v5/container-plans/${planId}/containers/${containerId}/documents`
    );
    expect(listed.status).toBe(200);
    expect(listed.body.documents).toHaveLength(1);

    const board = await agent.get(`/api/factory/v5/container-plans/${planId}/shipments`);
    expect(board.body.summary.containers[0].documentCount).toBe(1);

    const removed = await agent.delete(
      `/api/factory/v5/container-plans/${planId}/containers/${containerId}/documents/${documentId}`
    );
    expect(removed.status).toBe(200);
    expect(
      (await agent.get(`/api/factory/v5/container-plans/${planId}/containers/${containerId}/documents`)).body.documents
    ).toHaveLength(0);
  });
});
