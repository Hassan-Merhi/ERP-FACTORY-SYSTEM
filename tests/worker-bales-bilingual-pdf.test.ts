/**
 * The bilingual worker bales PDF: row ordering, fallbacks for missing
 * values, per-language headings, the Arabic font and right-to-left layout,
 * pagination and the totals line. pdfkit renders for real; its text calls are
 * recorded so the content can be checked.
 */
import fs from "fs";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBilingualWorkerBalesPdf } from "../server/lib/workerBalesBilingualPdfGenerator";

type TextCall = { text: string; options: Record<string, unknown> };
let texts: TextCall[];
let fonts: string[];
let pages: number;

beforeEach(() => {
  texts = [];
  fonts = [];
  pages = 1;
  const proto = PDFDocument.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const text = proto.text;
  const font = proto.font;
  const addPage = proto.addPage;
  vi.spyOn(proto, "text").mockImplementation(function (this: unknown, ...args: unknown[]) {
    texts.push({ text: String(args[0]), options: (args[3] ?? {}) as Record<string, unknown> });
    return text.apply(this, args);
  });
  vi.spyOn(proto, "font").mockImplementation(function (this: unknown, ...args: unknown[]) {
    fonts.push(String(args[0]));
    return font.apply(this, args);
  });
  vi.spyOn(proto, "addPage").mockImplementation(function (this: unknown, ...args: unknown[]) {
    pages += 1;
    return addPage.apply(this, args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const groups = [
  {
    bales: [
      { referenceNumber: "B-2", workerName: "Zed", productName: "Shirts", articleCode: "SH-1", weightKg: "45.5" },
      { referenceNumber: null, workerName: "Ann", productName: null, articleCode: "PA-2", weightKg: 30 },
    ],
  },
  { bales: [{ workerName: "Ann", productName: "Coats", weightKg: "x" }] },
  {},
];

describe("generateBilingualWorkerBalesPdf", () => {
  it("renders an English PDF sorted by worker then product with fallbacks and totals", async () => {
    const pdf = await generateBilingualWorkerBalesPdf(structuredClone(groups), "2026-10-20", "Acme", "en");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const values = texts.map((t) => t.text);
    expect(values.slice(0, 6)).toEqual([
      "Worker Bales Report",
      "Acme · 2026-10-20",
      "Reference",
      "Worker",
      "Product",
      "Weight (kg)",
    ]);
    // A missing product name sorts before any name.
    expect(values.slice(6, 18)).toEqual([
      "—",
      "Ann",
      "PA-2 (PA-2)",
      "30",
      "—",
      "Ann",
      "Coats",
      "0",
      "B-2",
      "Zed",
      "Shirts (SH-1)",
      "45.5",
    ]);
    expect(values.slice(-2)).toEqual(["Total: 3 bales", "75.5 kg"]);
    expect(texts[0].options).toMatchObject({ align: "left" });
    expect(texts.find((t) => t.text === "45.5")?.options).toMatchObject({ align: "right", lineBreak: false });
    expect(fonts).not.toContain("FactoryArabic");
  });

  it("renders Arabic right-to-left with the Arabic font and shaping features", async () => {
    await generateBilingualWorkerBalesPdf(
      [
        {
          bales: [
            { workerName: "سامي", productName: null, weightKg: 1 },
            { workerName: null, productName: "قميص", weightKg: 1 },
          ],
        },
      ],
      "2026-10-20",
      "شركة",
      "ar"
    );
    const values = texts.map((t) => t.text);
    expect(values).toContain("تقرير بالات العمال");
    expect(values).toContain("غير محدد");
    expect(values).toContain("الإجمالي: 2 بالات");
    // The unnamed worker sorts first.
    expect(values.indexOf("غير محدد")).toBeLessThan(values.indexOf("سامي"));
    expect(texts[0].options).toMatchObject({ align: "right", features: ["rtla", "arab"] });
    expect(texts.find((t) => t.text === "قميص")?.options).toMatchObject({ align: "right", features: ["rtla", "arab"] });
    expect(fonts).toContain("FactoryArabic");
    expect(fonts).not.toContain("Helvetica-Bold");
  });

  it("renders French headings, and Arabic without shaping when no Arabic font is installed", async () => {
    await generateBilingualWorkerBalesPdf(
      [
        {
          bales: [
            { workerName: "Éli", productName: "B", weightKg: 2 },
            { workerName: "Éli", productName: "A", weightKg: 2 },
          ],
        },
      ],
      "d",
      "Société",
      "fr"
    );
    const french = texts.map((t) => t.text);
    expect(french).toEqual(
      expect.arrayContaining(["Rapport des balles des travailleurs", "Travailleur", "Total: 2 balles"])
    );
    expect(french.indexOf("A")).toBeLessThan(french.indexOf("B"));

    texts = [];
    fonts = [];
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    await generateBilingualWorkerBalesPdf([{ bales: [{ workerName: "Ali", weightKg: 2 }] }], "d", "Co", "ar");
    expect(texts[0].options).toEqual({ width: expect.any(Number), align: "right" });
    expect(fonts).not.toContain("FactoryArabic");
    expect(fonts).toContain("Helvetica-Bold");
  });

  it("starts a new page with the header when rows run past the page", async () => {
    const bales = Array.from({ length: 60 }, (_, i) => ({
      referenceNumber: `R${i}`,
      workerName: `W${String(i).padStart(2, "0")}`,
      weightKg: 1,
    }));
    await generateBilingualWorkerBalesPdf([{ bales }], "d", "Co", "en");
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(texts.filter((t) => t.text === "Worker Bales Report")).toHaveLength(3);
    expect(texts.at(-2)?.text).toBe("Total: 60 bales");
  });

  it("renders an empty report", async () => {
    const pdf = await generateBilingualWorkerBalesPdf([], "d", "Co", "en");
    expect(pdf.length).toBeGreaterThan(500);
    expect(texts.at(-2)?.text).toBe("Total: 0 bales");
  });
});
