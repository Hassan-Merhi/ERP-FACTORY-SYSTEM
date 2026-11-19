/**
 * Supplier Partner GIT tracking Excel import and undo
 * (server/routes/git/spGitTrackingImportRoutes.ts) over HTTP with the real
 * database. Only logistics metadata is written. Covers the company-type and
 * role refusals, malformed rows (bad dates, amounts, freight and status),
 * skipped rows, closed or unknown containers, and undo of both newly created
 * and previously existing tracking rows, including refusals of foreign or
 * expired undo ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import XLSX from "xlsx-js-style";
import { pool } from "../server/db";
import { importUndoStore } from "../server/routes/git/_helpers";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { signInAdmin, signInRole, type Agent } from "./helpers/routeCoverageSession";

const PREFIX = "spgitimp";
const URL = "/api/git/sp-containers/import-excel";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const tag = Date.now().toString(36).toUpperCase();
const NEW = `SPN${tag}`;
const EXISTING = `SPE${tag}`;
const CLOSED = `SPC${tag}`;
let ctx: TestContext;
let admin: Agent;
const ids: Record<string, number> = {};

function workbook(rows: unknown[][], sheetName = "Containers"): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const upload = (agent: Agent, buffer: Buffer) =>
  agent.post(URL).attach("file", buffer, { filename: "sp.xlsx", contentType: XLSX_MIME });

async function spContainer(number: string, status = "open"): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sp_containers(company_id,invoice_date,invoice_number,supplier_name,container_number,status)
     VALUES($1,'2026-01-05',$2,'Partner Supplier',$3,$4) RETURNING id`,
    [ctx.companyId, `INV-${number}`, number, status]
  );
  return rows[0].id;
}

async function tracking(number: string) {
  const { rows } = await pool.query(
    `SELECT t.status,t.shop_name,to_char(t.eta,'YYYY-MM-DD') AS eta,to_char(t.border_date,'YYYY-MM-DD') AS border_date,
            to_char(t.docs_sent_date,'YYYY-MM-DD') AS docs_sent_date,t.transport_fee,t.duty_fee,t.freight_status,
            t.doc_received,t.agent,t.bl_docs
       FROM sp_container_git_tracking t WHERE t.container_id=$1`,
    [ids[number]]
  );
  return rows[0];
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
}, 60000);

afterAll(async () => {
  await pool.query("DELETE FROM sp_container_git_tracking WHERE company_id=$1", [ctx.companyId]);
  await pool.query("DELETE FROM sp_containers WHERE company_id=$1", [ctx.companyId]);
  await pool.query("UPDATE companies SET company_type='erp' WHERE id=$1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("refusals before parsing", () => {
  it("refuses an ERP company and roles below Owner", async () => {
    const book = workbook([
      ["Container", "Agent"],
      [NEW, "A"],
    ]);
    const erp = await upload(admin, book);
    expect([erp.status, erp.body.message]).toEqual([403, "Not a supplier_partner company"]);
    expect((await admin.post(`${URL}/undo`).send({ importId: "x" })).status).toBe(403);
    const manager = await signInRole(ctx, PREFIX, "Manager");
    expect((await upload(manager, book)).status).toBe(403);

    await pool.query("UPDATE companies SET company_type='supplier_partner' WHERE id=$1", [ctx.companyId]);
    ids[NEW] = await spContainer(NEW);
    ids[EXISTING] = await spContainer(EXISTING);
    ids[CLOSED] = await spContainer(CLOSED, "closed");
    await pool.query(
      "INSERT INTO sp_container_git_tracking(container_id,company_id,agent,status) VALUES($1,$2,'Old Agent','Sea')",
      [ids[EXISTING], ctx.companyId]
    );
  });

  it("refuses a missing file and an unreadable workbook", async () => {
    expect((await admin.post(URL)).body.message).toBe("No Excel file uploaded");
    const corrupt = await upload(admin, Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(64, 7)]));
    expect([corrupt.status, corrupt.body.message]).toEqual([500, "Unable to import Supplier Partner tracking Excel"]);
  });
});

describe("import rows", () => {
  it("reports malformed values per row without writing them", async () => {
    const res = await upload(
      admin,
      workbook([
        ["Container No", "ETA", "Duty Fee", "Freight Status", "Status"],
        [NEW, "next week", "", "", ""],
        [NEW, "", "-5", "", ""],
        [NEW, "", "", "Maybe", ""],
        [NEW, "", "", "", "Offloaded"],
      ])
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 0, skipped: 4, notFound: 0, importId: null });
    expect(res.body.errors).toEqual([
      `Row 2 (${NEW}): Invalid date`,
      `Row 3 (${NEW}): Invalid logistics amount`,
      `Row 4 (${NEW}): Freight status must be Yes, No or Pending`,
      `Row 5 (${NEW}): Invalid active GIT status (offload through the proper workflow)`,
    ]);
    expect(await tracking(NEW)).toBeUndefined();
  });

  it("skips template and empty rows and reports closed or unknown containers", async () => {
    const res = await upload(
      admin,
      workbook([
        ["Container", "Agent"],
        ["Required — used to match", ""],
        ["MSKU1234567", "x"],
        ["", "x"],
        [NEW, ""],
        [CLOSED, "Agent"],
        [`NOPE${tag}`, "Agent"],
      ])
    );
    expect(res.body).toMatchObject({ updated: 0, skipped: 4, notFound: 2 });
    expect(res.body.errors[0]).toBe(`Row 6: container ${CLOSED} not found in active Supplier Partner records`);
  });

  it("writes tracking fields, then undoes a new row and restores an existing one", async () => {
    const res = await upload(
      admin,
      workbook(
        [
          [
            "Container Number",
            "Status",
            "Shop",
            "ETA",
            "Border Date",
            "Docs Sent Date",
            "Transport Fee",
            "Duty Fee",
            "Freight Status",
            "Docs Received",
            "Agent",
            "BL Docs",
          ],
          [
            NEW.toLowerCase(),
            "at border",
            "Shop 1",
            new Date(Date.UTC(2026, 2, 4)),
            "5/3/2026",
            46043,
            "1,200",
            0,
            "pending",
            "yes",
            "Agent N",
            "BL-1",
          ],
          [EXISTING, "", "", "2026-03-09", "", "", "", "", "", "no", "New Agent", ""],
        ],
        "Data"
      )
    );
    expect(res.body).toMatchObject({ updated: 2, skipped: 0, errors: [] });
    expect(await tracking(NEW)).toEqual({
      status: "At Border",
      shop_name: "Shop 1",
      eta: "2026-03-04",
      border_date: "2026-03-05",
      docs_sent_date: "2026-01-21",
      transport_fee: "1200.0000",
      duty_fee: "0.0000",
      freight_status: "Pending",
      doc_received: true,
      agent: "Agent N",
      bl_docs: "BL-1",
    });
    expect(await tracking(EXISTING)).toMatchObject({
      agent: "New Agent",
      eta: "2026-03-09",
      doc_received: false,
      status: "Sea",
    });

    const undo = await admin.post(`${URL}/undo`).send({ importId: res.body.importId });
    expect(undo.body).toEqual({ reverted: 2 });
    expect(await tracking(NEW)).toBeUndefined();
    expect(await tracking(EXISTING)).toMatchObject({ agent: "Old Agent", eta: null, doc_received: null });
    expect((await admin.post(`${URL}/undo`).send({ importId: res.body.importId })).status).toBe(404);
  });

  it("refuses undo ids that belong to another company or to ERP imports", async () => {
    importUndoStore.set("sp-foreign", { companyId: ctx.companyId + 1, createdAt: Date.now(), changes: [] });
    importUndoStore.set("erp-import", {
      companyId: ctx.companyId,
      createdAt: Date.now(),
      changes: [{ id: 5, containerNumber: "X", prevData: {} }],
    });
    for (const importId of ["sp-foreign", "erp-import", ""]) {
      const res = await admin.post(`${URL}/undo`).send({ importId });
      expect(res.status).toBe(404);
    }
    importUndoStore.delete("sp-foreign");
    importUndoStore.delete("erp-import");
  });
});
