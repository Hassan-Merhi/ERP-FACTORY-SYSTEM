import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXCEL_APPEARANCE_SETTINGS } from "../../shared/universal-excel/appearanceSettings";
import { fetchExcelAppearance } from "../../client/src/lib/excelAppearanceClient";

const mocks = vi.hoisted(() => ({ build: vi.fn(), write: vi.fn() }));
vi.mock("@shared/universal-excel/engine", () => ({
  buildUniversalExcelWorkbook: mocks.build,
}));
vi.mock("@/lib/excelHelper", () => ({ writeFile: mocks.write }));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.build.mockReset();
  mocks.write.mockReset();
});

function fileSpec(mode: "report" | "import-template" = "report") {
  return {
    schemaVersion: 1 as const,
    title: "Stock",
    mode,
    sheets: [
      {
        kind: "table" as const,
        name: "Stock",
        columns: [{ key: "code", header: "Code" }],
        rows: [{ code: "000123" }],
      },
    ],
  };
}

describe("Phase 9 company appearance fetch", () => {
  it("strictly reads only the active company's settings on each report export", async () => {
    let company = "Company A";
    const request = vi.fn(async (_path: string, options: RequestInit) => ({
      ok: true,
      json: async () => ({
        appearance: { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS, brandName: company },
        companyName: company,
      }),
      status: 200,
    }));
    vi.stubGlobal("fetch", request);
    mocks.build.mockImplementation((spec) => ({ workbook: { test: spec }, results: [] }));
    const { downloadUniversalExcelWorkbook } = await import("../../client/src/lib/universalExcelExport");
    await downloadUniversalExcelWorkbook(fileSpec(), "company-a.xlsx");
    company = "Company B";
    await downloadUniversalExcelWorkbook(fileSpec(), "company-b.xlsx");
    expect(request).toHaveBeenCalledTimes(2);
    expect(mocks.build.mock.calls[0][0].appearance.brandName).toBe("Company A");
    expect(mocks.build.mock.calls[1][0].appearance.brandName).toBe("Company B");
    expect(mocks.build.mock.calls[1][0].companyName).toBe("Company B");
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });

  it("never fetches preferences or modifies headers for a strict import template", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    mocks.build.mockReturnValue({ workbook: {}, results: [] });
    const { downloadUniversalExcelWorkbook } = await import("../../client/src/lib/universalExcelExport");
    await downloadUniversalExcelWorkbook(fileSpec("import-template"), "price-import.xlsx");
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.build.mock.calls[0][0].appearance).toBeUndefined();
    expect(mocks.build.mock.calls[0][0].mode).toBe("import-template");
  });

  it("lets an Admin preview unsaved appearance without requiring a backend save", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    mocks.build.mockReturnValue({ workbook: {}, results: [] });
    const { downloadUniversalExcelWorkbook } = await import("../../client/src/lib/universalExcelExport");
    await downloadUniversalExcelWorkbook(
      {
        ...fileSpec(),
        appearance: { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS, accentColor: "#AABBCC" },
      },
      "sample.xlsx"
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.build.mock.calls[0][0].appearance.accentColor).toBe("#AABBCC");
  });

  it("fails instead of silently exporting a previous company's appearance on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 }))
    );
    await expect(fetchExcelAppearance()).rejects.toThrow(/403/);
    const { downloadUniversalExcelWorkbook } = await import("../../client/src/lib/universalExcelExport");
    await expect(downloadUniversalExcelWorkbook(fileSpec(), "stock.xlsx")).rejects.toThrow(/403/);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
