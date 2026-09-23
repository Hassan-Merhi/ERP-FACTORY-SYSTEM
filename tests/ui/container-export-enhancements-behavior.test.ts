/**
 * containerExportEnhancements is loaded from index.html. On a container page
 * it (1) restyles the plain "Container Items" Excel export into the supplier
 * document — supplier title, container and truck row, rows sorted by name,
 * quantity and value totals — and (2) turns Print into a no-cost PDF listing
 * description and quantity only. Elsewhere, Print stays the browser's.
 *
 * The first case caught a real defect: ExcelJS's spliceRows(1, rowCount) did
 * not remove the raw rows, so the rebuilt sheet was appended below them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdf = vi.hoisted(() => ({ saved: [] as string[], texts: [] as string[], tables: [] as any[] }));

vi.mock("jspdf", () => ({
  jsPDF: class {
    internal = { pageSize: { getWidth: () => 210 } };
    setFillColor() {}
    rect() {}
    setTextColor() {}
    setFont() {}
    setFontSize() {}
    text(value: string) {
      pdf.texts.push(value);
    }
    save(name: string) {
      pdf.saved.push(name);
    }
  },
}));
vi.mock("jspdf-autotable", () => ({
  default: (_doc: unknown, options: any) => {
    pdf.tables.push(options);
    options.didDrawPage?.();
    options.didParseCell?.({
      section: "body",
      row: { index: options.body.length - 1 },
      column: { index: 2 },
      cell: { styles: {} },
    });
  },
}));

const exportPayload = {
  container: { containerNumber: "MSKU 123/4", numberPlate: "AB-123", supplierName: "Fallback Supplier" },
  supplier: { code: "SUP-9", legalName: "Supplier Nine" },
  purchaseOrders: [
    {
      lineItems: [
        { stockItemName: "Zeta shoes", quantity: "3" },
        { stockItemName: "alpha bags", quantity: "1,200" },
      ],
    },
    { lineItems: [{ stockItemName: "Mid coats", quantity: 5 }] },
  ],
};

const nativePrint = vi.fn();
const originalPrint = window.print;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  pdf.saved = [];
  pdf.texts = [];
  pdf.tables = [];
  nativePrint.mockReset();
  window.print = nativePrint;
  globalThis.fetch = vi.fn(async (url: any) => {
    if (String(url) === "/api/containers/12/export") {
      return new Response(JSON.stringify(exportPayload), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as any;
});

afterEach(() => {
  window.print = originalPrint;
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, "", "/");
});

async function loadOn(path: string) {
  window.history.replaceState(null, "", path);
  await import("@/lib/containerExportEnhancements");
}

describe("Container Items Excel export", () => {
  it("rewrites the plain export into the supplier document on a container page", async () => {
    await loadOn("/containers/12");
    const { ExcelJS } = await import("@/lib/excelHelper");
    await vi.waitFor(() => expect(ExcelJS.Workbook.name).toBe("ContainerExportWorkbook"));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Container Items");
    ws.addRow(["CODE", "NAME", "QTY", "RATE", "VALUE"]);
    ws.addRow(["Z1", "Zeta shoes", "3", "10", "30"]);
    ws.addRow(["A1", "alpha bags", "1,200", "0.5", "600"]);
    await wb.xlsx.writeBuffer();

    const values = (r: number) => (ws.getRow(r).values as unknown[]).slice(1);
    expect(values(1)[0]).toBe("SUP-9");
    expect(values(2)[0]).toBe("CONTAINER: MSKU 123/4");
    expect(values(2)[4]).toBe("TRUCK: AB-123");
    expect(values(3)).toEqual(["NO", "CODE", "DESCRIPTION", "Q'TY", "RATE", "TOTAL"]);
    // Sorted case-insensitively by name, thousands separators parsed.
    expect(values(4)).toEqual([1, "A1", "alpha bags", 1200, 0.5, 600]);
    expect(values(5)).toEqual([2, "Z1", "Zeta shoes", 3, 10, 30]);
    expect(ws.getCell("A6").value).toBe("TOTAL");
    expect(ws.getCell("D6").value).toBe(1203);
    expect(ws.getCell("F6").value).toBe(630);
    expect(ws.pageSetup.printArea).toBe("A1:F6");
    // Nothing from the raw export survives above or below the rebuilt sheet.
    expect(ws.rowCount).toBe(6);
  });

  it("leaves other sheets and differently-shaped exports alone", async () => {
    await loadOn("/containers/12");
    const { ExcelJS } = await import("@/lib/excelHelper");
    await vi.waitFor(() => expect(ExcelJS.Workbook.name).toBe("ContainerExportWorkbook"));

    const wb = new ExcelJS.Workbook();
    const other = wb.addWorksheet("Container Items");
    other.addRow(["CODE", "NAME", "QTY"]);
    other.addRow(["X", "Thing", 1]);
    await wb.xlsx.writeBuffer();
    expect((other.getRow(1).values as unknown[]).slice(1)).toEqual(["CODE", "NAME", "QTY"]);
  });
});

describe("Print on a container page", () => {
  it("saves a no-cost PDF with sorted descriptions and a quantity total", async () => {
    await loadOn("/containers/12");
    window.print();

    await vi.waitFor(() => expect(pdf.saved).toEqual(["container_MSKU_123_4_no_cost.pdf"]));
    expect(nativePrint).not.toHaveBeenCalled();
    const table = pdf.tables[0];
    expect(table.head).toEqual([["NO", "DESCRIPTION", "Q'TY"]]);
    expect(table.body).toEqual([
      [1, "alpha bags", 1200],
      [2, "Mid coats", 5],
      [3, "Zeta shoes", 3],
      ["TOTAL Q'TY", "", 1208],
    ]);
    expect(pdf.texts).toEqual(expect.arrayContaining(["SUP-9", "CONTAINER: MSKU 123/4", "TRUCK: AB-123"]));
  });

  it("falls back to the browser print when the export data cannot be loaded", async () => {
    await loadOn("/containers/99");
    window.print();
    await vi.waitFor(() => expect(nativePrint).toHaveBeenCalledTimes(1));
    expect(pdf.saved).toEqual([]);
  });

  it("keeps the browser print off container pages", async () => {
    await loadOn("/inventory");
    window.print();
    expect(nativePrint).toHaveBeenCalledTimes(1);
  });
});
