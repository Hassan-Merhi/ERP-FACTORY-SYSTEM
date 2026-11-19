/**
 * Container tracking edits and the tracking import
 * (server/routes/containers/containerTrackingRoutes.ts) over HTTP with the real
 * database. Covers read-only role refusals, invalid ids and bodies, unknown
 * and other-company containers (allowed only with a role there), offload
 * forcing OFFLOADED, the import's malformed, missing, unknown and unparseable
 * rows with their date/money normalisation, and the retired ETA endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { signInAdmin, signInRole, type Agent } from "./helpers/routeCoverageSession";

const PREFIX = "ctrtrk";
const tag = Date.now().toString(36).toUpperCase();
const OWN = `CT${tag}`;
const OWN2 = `CU${tag}`;
const FOREIGN = `CF${tag}`;
let ctx: TestContext;
let admin: Agent;
let otherCompanyId = 0;
const ids: Record<string, number> = {};

async function container(companyId: number, number: string): Promise<number> {
  const supplier = await pool.query<{ id: number }>(
    "INSERT INTO suppliers(company_id,code,legal_name,email) VALUES($1,$2,'Supplier','s@example.test') RETURNING id",
    [companyId, `S-${number}`]
  );
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO containers(company_id,container_number,supplier_id,import_date,status)
     VALUES($1,$2,$3,'2026-01-10','OTW') RETURNING id`,
    [companyId, number, supplier.rows[0].id]
  );
  return rows[0].id;
}

async function row(number: string) {
  const { rows } = await pool.query(
    `SELECT status,shop_name,transporter,number_plate,tracking_location,agent,tracking_description,doc_received,
            transport_fee,duty_fee,freight_status,tracking_link,bl_docs,eta_source,
            to_char(eta,'YYYY-MM-DD') AS eta,to_char(border_date,'YYYY-MM-DD') AS border_date,
            to_char(offload_date,'YYYY-MM-DD') AS offload_date,to_char(docs_sent_date,'YYYY-MM-DD') AS docs_sent_date
       FROM containers WHERE container_number=$1`,
    [number]
  );
  return rows[0];
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
  const other = await pool.query<{ id: number }>("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
    `OC${tag}`.slice(0, 20),
    `${PREFIX}_OtherCompany`,
  ]);
  otherCompanyId = other.rows[0].id;
  ids[OWN] = await container(ctx.companyId, OWN);
  ids[OWN2] = await container(ctx.companyId, OWN2);
  ids[FOREIGN] = await container(otherCompanyId, FOREIGN);
}, 60000);

afterAll(async () => {
  await pool.query("DELETE FROM user_company_roles WHERE company_id=$1", [otherCompanyId]);
  for (const id of [ctx.companyId, otherCompanyId]) {
    await pool.query("DELETE FROM containers WHERE company_id=$1", [id]);
    await pool.query("DELETE FROM suppliers WHERE company_id=$1", [id]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("PATCH tracking", () => {
  const patch = (id: number | string, body: Record<string, unknown>, agent = admin) =>
    agent.patch(`/api/containers/${id}/tracking`).send(body);

  it("refuses anonymous callers, read-only roles and bad ids or bodies", async () => {
    expect((await request(ctx.app).patch(`/api/containers/${ids[OWN]}/tracking`).send({})).status).toBe(401);
    const viewer = await signInRole(ctx, PREFIX, "View Only");
    const readOnly = await patch(ids[OWN], { agent: "x" }, viewer);
    expect([readOnly.status, readOnly.body.message]).toEqual([403, "This role cannot edit existing containers"]);
    expect((await patch("abc", { agent: "x" })).status).toBe(400);
    const invalid = await patch(ids[OWN], { freightStatus: "Maybe", docReceived: "yes" });
    expect([invalid.status, invalid.body.message]).toEqual([400, "Invalid tracking data"]);
    expect((await patch(2_147_000_555, { agent: "x" })).status).toBe(404);
    expect((await row(OWN)).agent).toBeNull();
  });

  it("hides another company's container unless the user holds a role there", async () => {
    const hidden = await patch(ids[FOREIGN], { agent: "Intruder" });
    expect(hidden.status).toBe(404);
    expect((await row(FOREIGN)).agent).toBeNull();
    await pool.query("INSERT INTO user_company_roles(user_id,company_id,role) VALUES($1,$2,'Admin')", [
      ctx.userId,
      otherCompanyId,
    ]);
    const allowed = await patch(ids[FOREIGN], { agent: "Cross-company admin" });
    expect(allowed.status).toBe(200);
    expect((await row(FOREIGN)).agent).toBe("Cross-company admin");
  });

  it("writes every tracking field and clears blanks to null", async () => {
    const res = await patch(ids[OWN], {
      shopName: "Shop",
      eta: "2026-04-01",
      etaSource: "manual",
      transporter: "FastHaul",
      transportFee: "300",
      numberPlate: "T1",
      trackingLocation: "Dar",
      borderDate: "2026-04-03",
      agent: "Agent",
      dutyFee: "",
      docReceived: true,
      trackingDescription: "At port",
      docsSentDate: "2026-03-30",
      freightStatus: "No",
      trackingLink: "",
      status: "At Port",
      blDocs: "BL",
    });
    expect(res.status).toBe(200);
    expect(await row(OWN)).toMatchObject({
      status: "At Port",
      eta: "2026-04-01",
      transport_fee: "300.00",
      duty_fee: null,
      tracking_link: null,
      freight_status: "No",
      doc_received: true,
      bl_docs: "BL",
      docs_sent_date: "2026-03-30",
    });
  });

  it("forces OFFLOADED with an offload date and ignores an explicit null status", async () => {
    await patch(ids[OWN], { offloadDate: "2026-04-10", status: null });
    expect(await row(OWN)).toMatchObject({ status: "OFFLOADED", offload_date: "2026-04-10" });
    await patch(ids[OWN], {
      offloadDate: "",
      eta: "",
      borderDate: "",
      docsSentDate: "",
      transportFee: "",
      freightStatus: null,
      blDocs: "",
    });
    expect(await row(OWN)).toMatchObject({
      status: "OFFLOADED",
      offload_date: null,
      eta: null,
      border_date: null,
      bl_docs: null,
    });
  });
});

describe("tracking import", () => {
  const post = (rows: unknown, agent = admin) => agent.post("/api/containers/tracking/import").send({ rows });

  it("refuses read-only roles and an empty upload", async () => {
    const viewer = await signInRole(ctx, PREFIX, "Create Only");
    expect((await post([{ containerNumber: OWN2, agent: "x" }], viewer)).status).toBe(403);
    expect((await post([])).body.message).toBe("No data provided");
    expect((await post("rows")).status).toBe(400);
  });

  it("reports malformed, unnumbered, unknown, foreign and unwritable rows", async () => {
    const res = await post([
      "not a row",
      { containerNumber: "   " },
      { containerNumber: `NOPE${tag}`, agent: "x" },
      { containerNumber: FOREIGN, agent: "x" },
      { containerNumber: OWN2, eta: "13/45/2026" },
      { containerNumber: OWN2, shopName: "[object Object]", dutyFee: "[object Object]", eta: "garbage" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, updated: 0, notFound: 2, total: 6 });
    expect(res.body.errors[0]).toBe("Invalid row data for unknown");
    expect(res.body.errors[1]).toBe("Missing container number in row");
    expect(res.body.errors[2]).toBe(`Container not found: NOPE${tag}`);
    expect(res.body.errors[3]).toBe(`Container not found: ${FOREIGN}`);
    expect(res.body.errors[4]).toContain(`Error processing ${OWN2}`);
    expect((await row(OWN2)).eta).toBeNull();
  });

  it("reports null, array and scalar rows per row and still imports the valid ones", async () => {
    const res = await post([null, ["x"], 7, { containerNumber: OWN2, agent: "After bad rows" }]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, updated: 1, notFound: 0, total: 4 });
    expect(res.body.errors).toEqual([
      "Invalid row data for unknown",
      "Invalid row data for unknown",
      "Invalid row data for unknown",
    ]);
    expect((await row(OWN2)).agent).toBe("After bad rows");
  });

  it("normalises dates, amounts and document flags", async () => {
    const res = await post([
      {
        containerNumber: ` ${OWN2} `,
        shopName: "Shop 2",
        eta: "4/5/26",
        transporter: "Hauler",
        transportFee: "1,500.25",
        numberPlate: "T2",
        trackingLocation: "Kasumbalesa",
        borderDate: "2026-05-06",
        offloadDate: "May 7, 2026",
        agent: "Agent 2",
        dutyFee: 80,
        docReceived: "YES",
        trackingDescription: "Cleared",
      },
    ]);
    expect(res.body).toMatchObject({ updated: 1, notFound: 0, errors: [] });
    expect(await row(OWN2)).toMatchObject({
      shop_name: "Shop 2",
      eta: "2026-04-05",
      transport_fee: "1500.25",
      border_date: "2026-05-06",
      offload_date: "2026-05-07",
      duty_fee: "80.00",
      doc_received: true,
      tracking_location: "Kasumbalesa",
    });
    await post([{ containerNumber: OWN2, docReceived: false, eta: "1/2/1999" }]);
    expect(await row(OWN2)).toMatchObject({ doc_received: false, eta: "1999-01-02" });
  });
});

describe("retired ETA endpoints and summary", () => {
  it("answers 410 for carrier ETA refresh and returns the tracking summary", async () => {
    for (const url of [
      `/api/containers/${ids[OWN]}/fetch-eta`,
      `/api/containers/${ids[OWN]}/refresh-eta`,
      "/api/containers/refresh-etas",
    ]) {
      expect((await admin.post(url)).status).toBe(410);
    }
    const summary = await admin.get("/api/containers/eta-tracking-summary");
    expect(summary.status).toBe(200);
  });
});
