import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pressingParams, pressingCell, fetchPressingReport,
  pressingDisplayDateTime, exportPressingReport,
  type PressingDetailRow, type PressingCondensedRow,
} from "./pressingReportClient";
import * as XLSX from "@/lib/excelHelper";

vi.mock("@/lib/excelHelper", () => {
  const sheet = {
    mergeCells: vi.fn(),
    getCell: vi.fn(() => ({ value: "", font: {}, fill: {} })),
    getRow: vi.fn(() => ({ height: 0 })),
    addRow: vi.fn(() => ({ eachCell: (fn: (cell: Record<string, unknown>) => void) => {
      fn({ font: {}, fill: {}, border: {} });
    } })),
    columns: Array.from({ length: 25 }, () => ({ width: 0 })),
    views: [],
    autoFilter: undefined,
  };
  return { utils: { book_new: () => ({ addWorksheet: () => sheet }) },
    writeFile: vi.fn(async () => {}) };
});

const detailed: PressingDetailRow = {
  id: 99, referenceNumber: "REF300208", articleCode: "HMD11476",
  productName: "Wipers", weightKg: "45.125", machineId: 4,
  machineName: "Press 04", operatorUserId: "user-12", operatorName: "Operator A",
  shiftId: null, productionDate: "2026-10-27",
  confirmedAt: "2026-10-27T08:20:13.000Z",
  deviceCapturedAt: "2026-10-27T08:20:12.000Z",
  voidedAt: null, timezoneName: "UTC", secondsSincePrevious: "37",
};
const condensed: PressingCondensedRow = {
  productionDate: "2026-10-27", machineId: 4, machineName: "Press 04",
  operatorUserId: "user-12", operatorName: "Operator A", shiftId: null,
  articleCode: "HMD11476", voided: false, timezoneName: "UTC",
  bales: 3, weightKg: "135.375", firstScanAt: detailed.confirmedAt,
  lastScanAt: detailed.confirmedAt,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("pressing history client", () => {
  it("preserves date, selected machine, operator, status and pagination", () => {
    const params = pressingParams({
      from: "2026-10-01", to: "2026-10-27", machineId: 4, userId: "user-12",
      status: "active", mode: "detailed", page: 2, limit: 100,
    });
    expect(params.get("from")).toBe("2026-10-01");
    expect(params.get("to")).toBe("2026-10-27");
    expect(params.get("machineId")).toBe("4");
    expect(params.get("userId")).toBe("user-12");
    expect(params.get("page")).toBe("2");
  });

  it("preserves exact seconds and numeric KG in detailed mode", () => {
    expect(pressingCell(detailed, "secondsSincePrevious")).toBe(37);
    expect(pressingCell(detailed, "weightKg")).toBe(45.125);
    expect(pressingCell(detailed, "productionDate")).toBe("27/10/2026");
    expect(pressingCell(detailed, "status")).toBe("Confirmed");
    expect(pressingDisplayDateTime(detailed.confirmedAt, "UTC")).toContain("08:20:13");
  });

  it("keeps condensed totals numeric and distinguishes voided records", () => {
    expect(pressingCell(condensed, "bales")).toBe(3);
    expect(pressingCell(condensed, "weightKg")).toBe(135.375);
    expect(pressingCell({ ...condensed, voided: true }, "status")).toBe("Voided");
  });

  it("fetches only authenticated server history, not device-local queued scans", async () => {
    const fake = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({
      rows: [detailed], total: 1, summary: { totalBales: 1, totalKg: "45.125", voidedBales: 0 },
      page: 1, limit: 100, mode: "detailed", asOf: "2026-10-27T09:00:00.000Z",
    }) }));
    vi.stubGlobal("fetch", fake);
    const result = await fetchPressingReport({
      status: "active", mode: "detailed", page: 1, limit: 100,
    });
    expect(result.total).toBe(1);
    expect(fake.mock.calls[0][0]).toContain("/api/factory/pressing-machines/report?");
  });

  it("exports a true workbook with the selected filtered records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
      rows: [detailed], total: 1, summary: { totalBales: 1, totalKg: "45.125", voidedBales: 0 },
      page: 1, limit: 250, mode: "detailed", asOf: "2026-10-27T09:00:00.000Z",
    }) })));
    await exportPressingReport({
      from: "2026-10-27", to: "2026-10-27",
      mode: "detailed", status: "active", page: 1, limit: 100,
    }, ["referenceNumber", "weightKg", "confirmedAt"]);
    expect(XLSX.writeFile).toHaveBeenCalledWith(expect.anything(), "pressing-machines-detailed-2026-10-27_2026-10-27.xlsx");
  });

  it("never silently truncates exports exceeding the safe workbook ceiling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
      rows: [], total: 30001,
      summary: { totalBales: 30001, totalKg: "99999", voidedBales: 0 },
      page: 1, limit: 250, mode: "detailed", asOf: "2026-10-27T09:00:00.000Z",
    }) })));
    await expect(exportPressingReport({
      mode: "detailed", status: "active", page: 1, limit: 100,
    }, ["referenceNumber"])).rejects.toThrow("Narrow your dates");
    expect(XLSX.writeFile).not.toHaveBeenCalled();
  });
});
