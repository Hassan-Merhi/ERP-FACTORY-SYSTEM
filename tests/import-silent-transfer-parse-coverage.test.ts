/**
 * Silent transfer template and parse routes
 * (server/routes/import/registerSilentTransferRoutesPart1.ts): request
 * validation, another company's location ids, empty sheets, and the three
 * output buckets (valid, warn, error) with duplicate, quantity, unknown
 * barcode, no-stock and short-stock rows. Rolled back per test.
 */
import { describe, expect, it } from "vitest";

import { createWorkbook, jsonToSheet, readExcel, sheetToJson, writeWorkbook } from "../server/excelHelper";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PARSE = "/api/inventory/silent-transfer/parse";

async function sheet(rows: Record<string, unknown>[]): Promise<Buffer> {
  const workbook = createWorkbook();
  jsonToSheet(workbook, rows, "Transfer");
  return writeWorkbook(workbook);
}

function upload(w: FactoryWorld, fields: Record<string, string | number>, file?: Buffer) {
  let req = w.agent.post(PARSE);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, String(value));
  if (file) req = req.attach("file", file, "transfer.xlsx");
  return req;
}

async function destination(w: FactoryWorld) {
  return w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}D`,
  ]);
}

describe("silent transfer template", () => {
  it("downloads a workbook with the sample barcode rows", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent
        .get("/api/inventory/silent-transfer/template")
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("Silent_Transfer_Template.xlsx");
      const workbook = await readExcel(res.body as Buffer);
      const rows = sheetToJson(workbook.Sheets[workbook.SheetNames[0]]);
      expect(rows.map((row) => row.Barcode)).toEqual(["BC001", "BC002", "BC003"]);
    });
  });
});

describe("POST /api/inventory/silent-transfer/parse", () => {
  it("refuses a missing file, missing or equal locations, and another company's locations", async () => {
    await withFactoryWorld(async (w) => {
      const dest = await destination(w);
      const file = await sheet([{ Barcode: "X", Quantity: 1 }]);
      const otherCompany = await w.one(
        `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
        [`${w.tag}X`]
      );
      const foreign = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Foreign') RETURNING id`,
        [otherCompany, `${w.tag}XL`]
      );

      const cases: Array<[Record<string, string | number>, Buffer | undefined, string]> = [
        [{ sourceLocationId: w.locationId, destinationLocationId: dest }, undefined, "No file uploaded"],
        [{ sourceLocationId: w.locationId }, file, "Source and destination locations are required"],
        [{ sourceLocationId: dest, destinationLocationId: dest }, file, "Source and destination must be different"],
        [{ sourceLocationId: foreign, destinationLocationId: dest }, file, "Source location not found"],
        [{ sourceLocationId: w.locationId, destinationLocationId: foreign }, file, "Destination location not found"],
      ];
      for (const [fields, attached, message] of cases) {
        const res = await upload(w, fields, attached);
        expect(res.status, message).toBe(400);
        expect(res.body.message).toBe(message);
      }
    });
  });

  it("refuses a sheet with no data rows", async () => {
    await withFactoryWorld(async (w) => {
      const dest = await destination(w);
      const workbook = createWorkbook();
      workbook.addWorksheet("Transfer").addRow(["Barcode", "Quantity"]);
      const res = await upload(
        w,
        { sourceLocationId: w.locationId, destinationLocationId: dest },
        await writeWorkbook(workbook)
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Excel file is empty");
    });
  });

  it("sorts rows into valid, warning and error buckets", async () => {
    await withFactoryWorld(async (w) => {
      const dest = await destination(w);
      const addItem = (code: string, name: string) =>
        w.one(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, $3, 'PCS') RETURNING id`, [
          w.companyId,
          code,
          name,
        ]);
      const plenty = await addItem(`${w.tag}A`, "Plenty");
      const short = await addItem(`${w.tag}B`, "Short");
      await addItem(`${w.tag}C`, "Empty");
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
         VALUES ($1, $2, $3, 10, 2, 20), ($1, $2, $4, 3, 1, 3)`,
        [w.companyId, w.locationId, plenty, short]
      );
      const file = await sheet([
        { Barcode: `${w.tag}A`, Quantity: 4 },
        { Barcode: "", Quantity: 9 },
        { Barcode: `${w.tag}A`, Quantity: 1 },
        { Barcode: `${w.tag}B`, Quantity: 5 },
        { Barcode: `${w.tag}C`, Quantity: 2 },
        { Barcode: `${w.tag}Z`, Quantity: 1 },
        { Barcode: `${w.tag}Q`, Quantity: 0 },
      ]);
      const res = await upload(w, { sourceLocationId: w.locationId, destinationLocationId: dest }, file);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sourceLocation: "Yard", destLocation: "Shop", totalRows: 6 });
      expect(res.body.validItems).toEqual([
        expect.objectContaining({
          rowNum: 2,
          stockItemName: "Plenty",
          quantity: 4,
          currentStock: 10,
          afterTransfer: 6,
        }),
      ]);
      expect(res.body.warnItems.map((row: { warnReason: string }) => row.warnReason)).toEqual([
        "Insufficient stock (available: 3.00, short by: 2.00)",
        "No stock at source (available: 0)",
      ]);
      expect(res.body.errorLines).toEqual([
        { rowNum: 4, barcode: `${w.tag}A`, reason: "Duplicate — already listed at row 2" },
        { rowNum: 7, barcode: `${w.tag}Z`, reason: "Barcode / code not found in stock items" },
        { rowNum: 8, barcode: `${w.tag}Q`, reason: "Quantity must be a positive number" },
      ]);
    });
  });

  it("accepts the lower-case and short column names", async () => {
    await withFactoryWorld(async (w) => {
      const dest = await destination(w);
      await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Lower', 'PCS') RETURNING id`,
        [w.companyId, `${w.tag}L`]
      );
      const file = await sheet([{ code: `${w.tag}L`, qty: 1 }]);
      const res = await upload(w, { sourceLocationId: w.locationId, destinationLocationId: dest }, file);
      expect(res.status).toBe(200);
      expect(res.body.totalRows).toBe(1);
      expect(res.body.warnItems).toEqual([expect.objectContaining({ barcode: `${w.tag}L`, quantity: 1, uom: "PCS" })]);
    });
  });
});
