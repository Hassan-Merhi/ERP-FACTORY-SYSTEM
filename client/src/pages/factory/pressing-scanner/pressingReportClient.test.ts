import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pressingParams, pressingCell, fetchPressingReport,
  pressingDisplayDateTime, exportPressingReport, pressingKpiWorkers,
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
  articleCode: "HMD11476", productName: "Wipers", voided: false, timezoneName: "UTC",
  bales: 3, weightKg: "135.375", firstScanAt: detailed.confirmedAt,
  lastScanAt: detailed.confirmedAt,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("pressing history client", () => {
  it("shows the saved Factory display name on each KPI while using login only for identity", () => {
    const operators = [
      { userId: "p1-id", username: "P1", name: "Amir Darwish", displayName: "Amir Darwish", isPressingWorker: true },
      { userId: "p2-id", username: "p2", name: "Maya H.", displayName: "Maya H.", isPressingWorker: true },
      { userId: "p3-id", username: " P3 ", name: "Rami", displayName: " Rami ", isPressingWorker: true },
      { userId: "admin", username: "ADMIN", name: "Administrator", displayName: "Administrator", isPressingWorker: false },
    ];
    const aggregate = [
      { userId: "p1-id", name: "P1", totalBales: 12, totalKg: "600.000" },
      { userId: "p2-id", name: "P2", totalBales: 8, totalKg: "440.500" },
      { userId: "admin", name: "ADMIN", totalBales: 999, totalKg: "90000.000" },
    ];
    const workers = pressingKpiWorkers(operators, aggregate);
    expect(workers.map(worker => worker.label)).toEqual(["Amir Darwish", "Maya H.", "Rami"]);
    expect(workers.map(worker => worker.userId)).toEqual(["p1-id", "p2-id", "p3-id"]);
    expect(workers.map(worker => worker.bales)).toEqual([12, 8, 0]);
    expect(workers.map(worker => worker.kg)).toEqual([600, 440.5, 0]);
    expect(workers.reduce((sum, worker) => sum + worker.bales, 0)).toBe(20);
  });

  it("never substitutes a username for a missing Factory display name", () => {
    const workers = pressingKpiWorkers([
      { userId: "p1-id", username: "P1", name: "P1", displayName: null, isPressingWorker: true },
    ], []);
    expect(workers[0].label).toBe("Worker 1 (display name not set)");
    expect(workers[1].userId).toBeUndefined();
  });

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
    // A stored UTC timestamp must display as Beirut's winter UTC+2.
    expect(pressingDisplayDateTime(detailed.confirmedAt, "UTC")).toContain("10:20:13");
    // IANA timezone automatically observes Beirut's summer UTC+3.
    expect(pressingDisplayDateTime("2026-07-28T08:20:13.000Z", "UTC")).toContain("11:20:13");
    // History created under older UTC settings still belongs to Beirut's next day.
    expect(pressingDisplayDateTime("2026-10-27T22:30:00.000Z", "UTC"))
      .toMatch(/28\/10\/2026.*00:30:00/);
  });

  it("keeps condensed totals numeric and distinguishes voided records", () => {
    expect(pressingCell(condensed, "bales")).toBe(3);
    expect(pressingCell(condensed, "productName")).toBe("Wipers");
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
