/**
 * Factory status-builder sheets over HTTP against PostgreSQL, one rolled-back
 * transaction per test: create / update / delete with company scoping, the
 * per-cell change history, Excel import (dates, text, blanks, empty sheets),
 * the template and the export with its DIFFERENCE row.
 */
import { describe, expect, it } from "vitest";
import xlsxStyle from "xlsx-js-style";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const { utils, read, write } = xlsxStyle;
const BASE = "/api/factory/status-builder/sheets";

const binary = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

/** The history log is written after the response; wait until `count` rows exist. */
async function logRows(w: FactoryWorld, sheetId: number, count: number) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await w.agent.get("/api/factory/status-builder/log").query({ sheetId, limit: "50" });
    if (res.body.length >= count) return res.body as Array<Record<string, string>>;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("history log rows did not appear");
}

describe("status builder sheets CRUD", () => {
  it("creates sheets in order, updates them with a cell-level history and deletes them", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post(BASE).send({ name: "  " })).status).toBe(400);
      const first = await w.agent.post(BASE).send({ name: " Weekly " });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ name: "Weekly", orderIndex: 0, columns: [], rows: [] });
      const second = await w.agent.post(BASE).send({ name: "Monthly" });
      expect(second.body.orderIndex).toBe(1);

      const id = first.body.id;
      const columns = [{ label: "Mon" }, "Tue", { label: null }, 5];
      const rows = [
        { id: "a", label: "Target", cells: [10, { value: 5 }, null, "x"] },
        { id: "b", label: "Actual", cells: [{ value: 1, link: { sheetId: 2 } }] },
        { id: "c", label: "", cells: [] },
      ];
      const put = await w.agent.put(`${BASE}/${id}`).send({ name: "Weekly KPIs", columns, rows });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ name: "Weekly KPIs", columns, rows });
      expect(await logRows(w, id, 3)).toHaveLength(3);

      const edited = [
        { id: "a", label: "Target v2", cells: [11, { value: 5 }, { value: null }, "x", 7] },
        { id: "b", label: "Actual", cells: [{ value: 2 }] },
      ];
      expect((await w.agent.put(`${BASE}/${id}`).send({ rows: edited })).status).toBe(200);
      const log = await logRows(w, id, 8);
      const changes = log.map((e) => [e.rowLabel, e.columnLabel, e.oldValue, e.newValue]);
      expect(changes).toEqual(
        expect.arrayContaining([
          ["Target v2", "(label)", "Target", "Target v2"],
          ["Target v2", "Mon", "10", "11"],
          ["Target v2", "Column 5", "", "7"],
          ["Actual", "Mon", "→ linked", "2"],
          ["(row)", "(row)", "present", "deleted"],
        ])
      );
      expect((await w.agent.get("/api/factory/status-builder/log")).body.length).toBeGreaterThanOrEqual(8);

      // Renaming alone writes no history.
      expect((await w.agent.put(`${BASE}/${id}`).send({ name: "Renamed" })).body.name).toBe("Renamed");
      const list = await w.agent.get(BASE);
      expect(list.body.map((s: any) => s.name)).toEqual(["Renamed", "Monthly"]);

      expect((await w.agent.delete(`${BASE}/${id}`)).body).toEqual({ ok: true });
      expect((await w.agent.delete(`${BASE}/${id}`)).status).toBe(404);
      expect((await w.agent.get(BASE)).body).toHaveLength(1);
    });
  });

  it("refuses invalid IDs and sheets of another company", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await w.one(
        `INSERT INTO status_builder_sheets (company_id, name, order_index, columns, rows)
         VALUES ($1, 'Foreign', 0, '[]', '[]') RETURNING id`,
        [other]
      );
      expect((await w.agent.put(`${BASE}/abc`).send({ name: "x" })).status).toBe(400);
      expect((await w.agent.delete(`${BASE}/abc`)).status).toBe(400);
      expect((await w.agent.put(`${BASE}/${foreign}`).send({ name: "Hijack" })).status).toBe(404);
      expect((await w.agent.delete(`${BASE}/${foreign}`)).status).toBe(404);
      const [row] = await w.q(`SELECT name FROM status_builder_sheets WHERE id = $1`, [foreign]);
      expect(row.name).toBe("Foreign");
      expect((await w.agent.get(BASE)).body).toEqual([]);
    });
  });
});

describe("status builder Excel", () => {
  it("imports every worksheet, replacing the company's sheets, and exports them back", async () => {
    await withFactoryWorld(async (w) => {
      await w.agent.post(BASE).send({ name: "Old sheet" });
      const book = utils.book_new();
      const data = utils.aoa_to_sheet(
        [
          ["Label", "Week 1", null, "Week 3"],
          ["Target", 150, "n/a", new Date(Date.UTC(2026, 0, 5, 12))],
          [null, null, null, null],
          [new Date(Date.UTC(2026, 1, 2, 12)), " 12 ", "", null],
          [null, 3],
        ],
        { cellDates: true }
      );
      utils.book_append_sheet(book, data, "Data");
      utils.book_append_sheet(book, utils.aoa_to_sheet([]), "Empty");
      const file = write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;

      expect((await w.agent.post(`${BASE}/import`)).status).toBe(400);
      const imported = await w.agent.post(`${BASE}/import`).attach("file", file, "status.xlsx");
      expect(imported.status).toBe(200);
      expect(imported.body.map((s: any) => s.name)).toEqual(["Data", "Empty"]);
      expect(imported.body[0].columns).toEqual(["Week 1", "", "Week 3"]);
      expect(imported.body[0].rows).toEqual([
        { label: "Target", cells: [150, "n/a", "2026-01-05"] },
        { label: "2026-02-02", cells: [12, null, null] },
        { label: "", cells: [3, null, null] },
      ]);
      expect(imported.body[1]).toMatchObject({ columns: [], rows: [] });

      await w.agent.put(`${BASE}/${imported.body[0].id}`).send({
        columns: [{ label: "Week 1" }, "x", "y"],
        rows: [
          { id: "r1", label: "Target", cells: [{ value: 150 }, { value: { bad: true } }, "text"] },
          { id: "r2", label: "Actual", cells: [-30, null, 4] },
        ],
      });
      const exported = await w.agent.get(`${BASE}/export`).buffer(true).parse(binary);
      expect(exported.status).toBe(200);
      expect(exported.headers["content-disposition"]).toContain("status-builder.xlsx");
      const parsed = read(exported.body as Buffer, { type: "buffer" });
      expect(parsed.SheetNames).toEqual(["Data", "Empty"]);
      const aoa = utils.sheet_to_json<unknown[]>(parsed.Sheets.Data, { header: 1, defval: null });
      expect(aoa[aoa.length - 1]).toEqual(["DIFFERENCE", 120, 0, 4]);
    });
  });

  it("downloads the template and a no-data export for a company without sheets", async () => {
    await withFactoryWorld(async (w) => {
      const template = await w.agent.get(`${BASE}/template`).buffer(true).parse(binary);
      expect(template.status).toBe(200);
      expect(read(template.body as Buffer, { type: "buffer" }).SheetNames).toEqual(["Status Overview"]);
      const empty = await w.agent.get(`${BASE}/export`).buffer(true).parse(binary);
      expect(empty.status).toBe(200);
      const parsed = read(empty.body as Buffer, { type: "buffer" });
      expect(parsed.SheetNames).toEqual(["Sheets"]);
    });
  });
});
