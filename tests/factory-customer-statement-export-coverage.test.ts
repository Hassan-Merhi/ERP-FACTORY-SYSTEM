/**
 * Factory customer statement exports (customers-core/statement-excel.ts and
 * statement-pdf.ts) through the real HTTP app in one rolled-back transaction
 * per test. The workbook is loaded with ExcelJS and its rows asserted; the
 * PDF is checked as a real PDFKit document (header, trailer, page count).
 * Pins the id / customer / company refusals, the brought-forward row for a
 * date window, the destination filter, row notes, Cr closing balances and
 * pagination.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { statementCustomer } from "./helpers/customerStatementFixture";

const excelUrl = (id: number | string) => `/api/factory/customers/${id}/statement/export-excel`;
const pdfUrl = (id: number | string) => `/api/factory/customers/${id}/statement/export-pdf`;

function binary(res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (e: Error | null, b: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c) => chunks.push(c!));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

async function workbookRows(w: FactoryWorld, id: number, filters: Record<string, string> = {}) {
  const res = await w.agent
    .get(`${excelUrl(id)}?${new URLSearchParams(filters)}`)
    .buffer(true)
    .parse(binary);
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("spreadsheetml");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body as unknown as ExcelJS.Buffer);
  const lines: string[] = [];
  workbook.worksheets[0].eachRow((row) =>
    lines.push(
      (row.values as unknown[])
        .slice(1)
        .map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "")))
        .join("|")
    )
  );
  return lines;
}

async function pdf(w: FactoryWorld, id: number, filters: Record<string, string> = {}) {
  const res = await w.agent
    .get(`${pdfUrl(id)}?${new URLSearchParams(filters)}`)
    .buffer(true)
    .parse(binary);
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("application/pdf");
  const body = res.body as Buffer;
  expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  expect(body.subarray(-6).toString()).toContain("%%EOF");
  const pages = body.toString("latin1").match(/\/Type \/Page\b/g)?.length ?? 0;
  return { pages, disposition: String(res.headers["content-disposition"]) };
}

describe("customer statement exports: refusals", () => {
  it("refuses invalid ids and customers of another company for both formats", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreign = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Foreign') RETURNING id`,
        [other, `${w.tag}FC`]
      );
      for (const url of [excelUrl, pdfUrl]) {
        expect((await w.agent.get(url("abc"))).status).toBe(400);
        const res = await w.agent.get(url(foreign));
        expect(res.status).toBe(404);
        expect(res.body.message).toBe("Customer not found");
      }
    });
  });
});

describe("customer statement Excel export", () => {
  it("lists ledger rows with destination, note and the closing balance", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w, { note: "Payment due in 30 days.", opening: "50.00" });
      const lines = await workbookRows(w, customerId);
      const text = lines.join("\n");
      expect(text).toContain("Payment due in 30 days.");
      expect(lines.find((l) => l.includes("Opening Balance"))).toContain("50");
      expect(text).toContain("Customer: Statement Customer");
      expect(text).toContain("Kinshasa");
      expect(text).toContain("Delivered in two trucks");
      expect(text).toContain("Cash received");
      expect(lines.find((l) => l.includes("Kinshasa"))).toContain("400");
      expect(text).not.toContain("Period:");
      expect(lines.some((l) => l.includes("350"))).toBe(true);
    });
  });

  it("shows a brought-forward row and a period line for a date window and a destination filter", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w, { extraSales: 2 });
      const windowed = await workbookRows(w, customerId, { dateFrom: "2026-03-01", dateTo: "2026-03-12" });
      const text = windowed.join("\n");
      expect(text).toContain("Period: 2026-03-01 to 2026-03-12");
      expect(windowed.some((l) => /brought forward|B\/F/i.test(l) && l.includes("400"))).toBe(true);
      expect(text).toContain("Cash received");
      expect(text).not.toContain("Small sale");

      const filtered = await workbookRows(w, customerId, { destination: "kinsh" });
      const filteredText = filtered.join("\n");
      expect(filteredText).toContain("Destination filter: KINSH");
      expect(filteredText).not.toContain("Cash received");
      expect(filteredText).toContain("Kinshasa");
    });
  });

  it("closes on the credit side when receipts exceed sales", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w, { receipt: "650.00" });
      const lines = await workbookRows(w, customerId, { dateFrom: "2026-03-01" });
      expect(lines.some((l) => l.includes("250"))).toBe(true);
      expect(lines.join("\n")).toContain("Period: 2026-03-01 to End");
    });
  });
});

describe("customer statement PDF export", () => {
  it("renders a one-page statement with a safe attachment filename", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w, { note: "Thank you for your business.", opening: "50.00" });
      const out = await pdf(w, customerId);
      expect(out.pages).toBe(1);
      expect(out.disposition).toContain("attachment");
      expect(out.disposition).toContain(".pdf");
    });
  });

  it("breaks long statements across pages and renders date, destination and credit windows", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w, { extraSales: 70, name: "عميل الكشف" });
      const long = await pdf(w, customerId);
      expect(long.pages).toBeGreaterThan(1);
      const windowed = await pdf(w, customerId, { dateFrom: "2026-03-01", dateTo: "2026-03-12" });
      expect(windowed.pages).toBe(1);
      const filtered = await pdf(w, customerId, { destination: "kinshasa" });
      expect(filtered.pages).toBe(1);
    });
  });

  it("renders a credit closing balance and a credit brought-forward", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w, { receipt: "650.00", extraSales: 1 });
      expect((await pdf(w, customerId)).pages).toBe(1);
      expect((await pdf(w, customerId, { dateFrom: "2026-03-12" })).pages).toBe(1);
    });
  });
});
