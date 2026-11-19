/**
 * Goods-in-transit (GIT) container Excel bulk update
 * (server/routes/git/registerGitImportRoutesPart2.ts) over HTTP with the real
 * database. Covers the role and upload refusals (wrong type, no file,
 * unreadable workbook), every skipped-row rule (blank, template example, hint
 * text, unknown or other-company container, invalid status, nothing to
 * update) and the parsing of dates, money, freight and document flags.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import XLSX from "xlsx-js-style";
import request from "supertest";
import { pool } from "../server/db";
import { importUndoStore } from "../server/routes/git/_helpers";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { signInAdmin, signInRole, type Agent } from "./helpers/routeCoverageSession";

const PREFIX = "gitxlsx";
const URL = "/api/git/containers/import-excel";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const tag = `${Date.now().toString(36).toUpperCase()}`;
const OWN = `GA${tag}`;
const OWN2 = `GB${tag}`;
const FOREIGN = `GF${tag}`;
let ctx: TestContext;
let admin: Agent;
let otherCompanyId = 0;

function workbook(rows: unknown[][], sheetName = "Containers"): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function upload(agent: Agent, buffer: Buffer, filename = "git.xlsx", contentType = XLSX_MIME) {
  return agent.post(URL).attach("file", buffer, { filename, contentType });
}

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
    `SELECT status,number_plate,transporter,tracking_location,agent,tracking_description,tracking_link,shop_name,
            to_char(eta,'YYYY-MM-DD') AS eta,to_char(border_date,'YYYY-MM-DD') AS border_date,
            to_char(docs_sent_date,'YYYY-MM-DD') AS docs_sent_date,duty_fee,transport_fee,freight_status,
            doc_received,eta_source
       FROM containers WHERE container_number=$1`,
    [number]
  );
  return rows[0];
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
  const other = await pool.query<{ id: number }>("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
    `OG${tag}`.slice(0, 20),
    `${PREFIX}_OtherCompany`,
  ]);
  otherCompanyId = other.rows[0].id;
  await container(ctx.companyId, OWN);
  await container(ctx.companyId, OWN2);
  await container(otherCompanyId, FOREIGN);
}, 60000);

afterAll(async () => {
  for (const id of [ctx.companyId, otherCompanyId]) {
    await pool.query("DELETE FROM containers WHERE company_id=$1", [id]);
    await pool.query("DELETE FROM suppliers WHERE company_id=$1", [id]);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("access and upload refusals", () => {
  it("refuses anonymous callers and roles below Owner", async () => {
    const book = workbook([["Container #"], [OWN]]);
    expect(
      (await request(ctx.app).post(URL).attach("file", book, { filename: "g.xlsx", contentType: XLSX_MIME })).status
    ).toBe(401);
    const manager = await signInRole(ctx, PREFIX, "Manager");
    expect((await upload(manager, book)).status).toBe(403);
  });

  it("refuses a missing file, a non-Excel file and an unreadable workbook", async () => {
    const none = await admin.post(URL);
    expect([none.status, none.body.message]).toEqual([400, "No file uploaded"]);
    const text = await upload(admin, Buffer.from("a,b"), "git.csv", "text/csv");
    expect([text.status, text.body.message]).toEqual([400, "Only Excel files (.xlsx, .xls) are allowed"]);
    const corrupt = await upload(admin, Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(64, 7)]));
    expect(corrupt.status).toBe(500);
    expect((await row(OWN)).status).toBe("OTW");
  });
});

describe("row handling", () => {
  it("skips template, blank and hint rows and reports unknown or foreign containers", async () => {
    const res = await upload(
      admin,
      workbook([
        ["Container #", "Status", "Location"],
        ["Required — used to match", "", ""],
        ["MSKU1234567", "Sea", "Dar"],
        ["e.g. ABCU1234567", "", ""],
        ["", "Sea", ""],
        [`NOPE${tag}`, "Sea", ""],
        [FOREIGN, "Sea", "Kasumbalesa"],
      ])
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 0, skipped: 4, notFound: 2, importId: null });
    expect(res.body.errors).toEqual([
      `Row 7: "NOPE${tag}" not found in system`,
      `Row 8: "${FOREIGN}" not found in system`,
    ]);
    const foreign = await pool.query("SELECT status FROM containers WHERE container_number=$1", [FOREIGN]);
    expect(foreign.rows[0].status).toBe("OTW");
  });

  it("refuses an invalid status and a row with nothing to update", async () => {
    const res = await upload(
      admin,
      workbook([
        ["Container No", "Status", "Freight Status", "Plate"],
        [OWN, "Lost at sea", "", ""],
        [OWN2, "", "Maybe", 0],
      ])
    );
    expect(res.body).toMatchObject({ updated: 0, skipped: 2, notFound: 0 });
    expect(res.body.errors[0]).toContain(`(${OWN}): invalid status "Lost at sea"`);
    expect(res.body.errors[1]).toContain(`(${OWN2}): no fields to update`);
    expect((await row(OWN)).status).toBe("OTW");
  });

  it("refuses amounts that are not exactly one number instead of truncating them", async () => {
    const res = await upload(
      admin,
      workbook([
        ["Container No", "Agent", "Duty Fee", "Transport Fee"],
        [OWN, "Should not save", "1,25", ""],
        [OWN, "Should not save", "", "12abc"],
        [OWN, "Should not save", -5, ""],
        [OWN, "Should not save", "2000000000", ""],
      ])
    );
    expect(res.body).toMatchObject({ updated: 0, skipped: 4, notFound: 0 });
    expect(res.body.errors).toEqual([
      `Row 3 (${OWN}): invalid duty fee "1,25" — use a plain number such as 1250.50`,
      `Row 4 (${OWN}): invalid transport fee "12abc" — use a plain number such as 1250.50`,
      `Row 5 (${OWN}): invalid duty fee "-5" — use a plain number such as 1250.50`,
      `Row 6 (${OWN}): invalid duty fee "2000000000" — use a plain number such as 1250.50`,
    ]);
    expect(await row(OWN)).toMatchObject({ agent: null, duty_fee: null, transport_fee: null });
  });

  it("applies every supported column and records an undo snapshot", async () => {
    const res = await upload(
      admin,
      workbook([
        [
          "Container Number",
          "Status",
          "Plate/Truck No",
          "Transporter",
          "Tracking Location",
          "Agent",
          "Description",
          "Tracking Link",
          "Shop Name",
          "ETA (YYYY-MM-DD)",
          "Border Date",
          "Docs Sent Date",
          "Duty Fee",
          "Transport Fee",
          "Freight",
          "Docs Received",
        ],
        [
          ` ${OWN.toLowerCase()} `,
          "at port",
          "T 123 ABC",
          "FastHaul",
          "Dar es Salaam",
          "Agent K",
          "Waiting customs",
          "https://track.example.test/1",
          "Shop One",
          new Date(Date.UTC(2026, 2, 4)),
          "05/03/2026",
          "06-03-2026",
          "1,250.50",
          0,
          "Yes",
          "y",
        ],
        [OWN2, "", "", "", "", "", "", "", "", 46043, "07.03.2026", "2026-03-08", "", "", "", "no"],
      ])
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2, skipped: 0, notFound: 0, errors: [] });
    expect(importUndoStore.get(res.body.importId)?.changes).toHaveLength(2);
    expect(await row(OWN)).toEqual({
      status: "At Port",
      number_plate: "T 123 ABC",
      transporter: "FastHaul",
      tracking_location: "Dar es Salaam",
      agent: "Agent K",
      tracking_description: "Waiting customs",
      tracking_link: "https://track.example.test/1",
      shop_name: "Shop One",
      eta: "2026-03-04",
      border_date: "2026-03-05",
      docs_sent_date: "2026-03-06",
      duty_fee: "1250.50",
      transport_fee: "0.00",
      freight_status: "Yes",
      doc_received: true,
      eta_source: "manual",
    });
    expect(await row(OWN2)).toMatchObject({
      eta: "2026-01-21",
      border_date: "2026-03-07",
      docs_sent_date: "2026-03-08",
      doc_received: false,
    });
  });

  it("falls back to the first sheet when no Containers sheet exists", async () => {
    const res = await upload(
      admin,
      workbook(
        [
          ["Container", "Docs"],
          [OWN2, "true"],
        ],
        "Sheet1"
      )
    );
    expect(res.body).toMatchObject({ updated: 1 });
    expect((await row(OWN2)).doc_received).toBe(true);
  });
});
