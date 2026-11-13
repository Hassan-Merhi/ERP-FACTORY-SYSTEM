import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadFromUrl, exportFileName, exportFileSlug } from "./exportFile";

const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock("./downloadBlob", () => ({ downloadBlob }));

describe("export file names", () => {
  const today = new Date(2026, 10, 13);

  it("uses kebab-case subject and a local date stamp", () => {
    expect(exportFileName("Daily Production (Line 2)", "xlsx", { date: today })).toBe(
      "daily-production-line-2_2026-11-13.xlsx"
    );
    expect(exportFileName("Employee_Bonuses", "csv", { date: "2026-01-05" })).toBe("employee-bonuses_2026-01-05.csv");
  });

  it("uses the period instead of today when a range is given", () => {
    expect(exportFileName("Daybook", "xlsx", { from: "2026-11-01", to: "2026-11-30" })).toBe(
      "daybook_2026-11-01_2026-11-30.xlsx"
    );
    expect(exportFileName("Daybook", "pdf", { from: "2026-11-01", to: "2026-11-01" })).toBe("daybook_2026-11-01.pdf");
    expect(exportFileName("Stock", "csv", { date: false })).toBe("stock.csv");
  });

  it("keeps non-Latin letters and never returns an empty subject", () => {
    expect(exportFileSlug("كشف حساب / ACME")).toBe("كشف-حساب-acme");
    expect(exportFileSlug(" // ")).toBe("export");
  });
});

describe("downloadFromUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    downloadBlob.mockReset();
  });

  it("downloads with the server file name when one is sent", async () => {
    const blob = new Blob(["x"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => blob,
        headers: new Headers({ "Content-Disposition": 'attachment; filename="invoice-12.xlsx"' }),
      }))
    );
    await expect(downloadFromUrl("/api/x", { fileName: "fallback.xlsx" })).resolves.toBe("invoice-12.xlsx");
    expect(downloadBlob).toHaveBeenCalledWith(blob, "invoice-12.xlsx");
    expect(fetch).toHaveBeenCalledWith("/api/x", expect.objectContaining({ method: "GET", credentials: "include" }));
  });

  it("falls back to the local name and posts JSON bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["x"]), headers: new Headers() }))
    );
    await expect(
      downloadFromUrl("/api/x", { fileName: "fallback.xlsx", method: "POST", body: { a: 1 } })
    ).resolves.toBe("fallback.xlsx");
    expect(fetch).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ method: "POST", body: '{"a":1}', headers: { "Content-Type": "application/json" } })
    );
  });

  it("rejects with the server message instead of downloading an error page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: "Permission denied" }),
        headers: new Headers(),
      }))
    );
    await expect(downloadFromUrl("/api/x", { fileName: "f.xlsx" })).rejects.toThrow("Permission denied");
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
