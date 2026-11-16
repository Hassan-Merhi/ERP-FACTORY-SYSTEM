import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  sheetNames: [] as string[],
  summaryCalls: [] as unknown[],
  poolQuery: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { query: harness.poolQuery },
}));
vi.mock("../server/lib/logger", () => ({ logger: { warn: harness.loggerWarn } }));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("../server/lib/bufferCompatibility", () => ({
  toArrayBuffer: (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
}));
vi.mock("../server/services/export-excel/sheet-helpers", () => ({
  ALT_FILL: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F7F7" } },
  HDR_FILL: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } },
  HDR_FONT: { bold: true, color: { argb: "FFFFFFFF" } },
  addSheet: (_workbook: unknown, sheetName: string, _rows: unknown[]) => {
    harness.sheetNames.push(sheetName);
  },
}));
vi.mock("../server/services/export-excel/summary-sheet", () => ({
  addSummarySheet: (workbook: any, data: unknown) => {
    harness.summaryCalls.push(data);
    workbook.addWorksheet("Summary");
  },
}));

import { buildCompanyWorkbook, streamCompanyWorkbookDirect } from "../server/services/export-excel/workbook";

describe("full company workbook export behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sheetNames.splice(0);
    harness.summaryCalls.splice(0);
    harness.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("company_settings")) throw new Error("optional table unavailable");
      if (sql.includes("SELECT name FROM companies")) return { rows: [{ name: "GC Lshi" }] };
      if (sql.includes("FROM locations")) return { rows: [{ id: 2, name: "Main" }] };
      return { rows: [] };
    });
  });

  it("writes every in-memory ERP dataset into the company workbook", async () => {
    const data = new Proxy(
      {
        company: { id: 4, name: "GC Lshi" },
        companySettings: [{ companyId: 4 }],
        locations: [{ id: 2, name: "Main" }],
      } as Record<string, unknown>,
      {
        get(target, property) {
          if (property in target) return target[property as string];
          return [];
        },
      }
    );
    const write = vi.fn();

    await buildCompanyWorkbook(data as never, { write } as never);

    expect(harness.summaryCalls).toHaveLength(1);
    expect(harness.sheetNames.length).toBeGreaterThan(100);
    expect(harness.sheetNames).toEqual(
      expect.arrayContaining([
        "Company Info",
        "Voucher Entries",
        "Factory Bale Production",
        "Stock Transfer Detail",
        "Supplier Balances",
        "Location Stock Detail",
        "Audit Log",
      ])
    );
    expect(write).toHaveBeenCalledTimes(1);
    const buffer = write.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1_000);
  });

  it("streams all datasets with date scoping and tolerates an individual query failure", async () => {
    const buffer = await streamCompanyWorkbookDirect(4, "2026-08-01", "2026-08-12");

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1_000);
    expect(harness.poolQuery.mock.calls.length).toBeGreaterThan(100);
    expect(harness.sheetNames.length).toBeGreaterThan(100);
    expect(harness.sheetNames).toEqual(
      expect.arrayContaining([
        "Company Info",
        "Company Settings",
        "Vouchers",
        "Factory Bales",
        "Customer Order Detail",
        "Employee Txn Detail",
      ])
    );

    const calls = harness.poolQuery.mock.calls as unknown as Array<[string, unknown[] | undefined]>;
    const sql = calls.map(([query]) => String(query));
    expect(sql.some((query) => query.includes("company_id = 4"))).toBe(true);
    // The date range is bound, never spliced into the SQL text.
    const voucherQuery = calls.find(
      ([query]) => query.includes("FROM vouchers") && query.includes("voucher_date >= $1") && query.includes("voucher_date <= $2")
    );
    expect(voucherQuery?.[1]).toEqual(["2026-08-01", "2026-08-12"]);
    expect(sql.some((query) => query.includes("2026-08-01"))).toBe(false);
    // Queries without a date filter carry no parameters.
    expect(calls.find(([query]) => query.includes("FROM companies WHERE id = 4"))?.[1]).toBeUndefined();
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("[ExportStream] Query warning: optional table unavailable")
    );
  });

  it("rejects a malformed or hostile date range before running any query", async () => {
    const before = harness.poolQuery.mock.calls.length;
    await expect(streamCompanyWorkbookDirect(4, "2026-08-01' OR '1'='1", undefined)).rejects.toThrow(/Invalid fromDate/);
    await expect(streamCompanyWorkbookDirect(4, undefined, "2026-02-30")).rejects.toThrow(/Invalid toDate/);
    expect(harness.poolQuery.mock.calls.length).toBe(before);
  });
});
