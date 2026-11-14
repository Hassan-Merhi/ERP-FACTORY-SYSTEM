import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportPressingReport,
  type PressingCondensedRow,
  type PressingReportResponse,
} from "../../client/src/pages/factory/pressing-scanner/pressingReportClient";

const mocks = vi.hoisted(() => ({ exportWorkbook: vi.fn() }));
vi.mock("@/lib/operationalExcelExport", () => ({
  exportOperationalWorkbook: mocks.exportWorkbook,
}));

const cutoff = "2026-11-13T12:00:00.000Z";
const filters = {
  status: "active" as const,
  mode: "condensed" as const,
  page: 1,
  limit: 100,
  from: "2026-11-13",
  to: "2026-11-13",
};

function row(i: number): PressingCondensedRow {
  return {
    productionDate: "2026-11-13",
    machineId: 1,
    machineName: "Press 1",
    operatorUserId: "p1",
    operatorName: "Worker",
    shiftId: null,
    articleCode: "001234",
    productName: "Cotton",
    voided: false,
    timezoneName: "Asia/Beirut",
    bales: 1,
    weightKg: "25",
    firstScanAt: cutoff,
    lastScanAt: cutoff,
  };
}

function page(rows: PressingCondensedRow[], current: number, total: number): PressingReportResponse {
  const summary = {
    totalBales: total,
    totalKg: String(total * 25),
    voidedBales: 0,
    byOperator: [{ userId: "p1", name: "Worker", totalBales: total, totalKg: String(total * 25) }],
  };
  return {
    rows, total, summary, overview: summary,
    page: current, limit: 250, mode: "condensed", asOf: cutoff,
  };
}

beforeEach(() => {
  mocks.exportWorkbook.mockReset();
  mocks.exportWorkbook.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Factory pressing report universal Excel export", () => {
  it("fetches all pages using the first asOf snapshot, then exports only selected columns and totals", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: string) => {
      requests.push(input);
      const url = new URL(input, "http://localhost");
      const pageNo = Number(url.searchParams.get("page"));
      return {
        ok: true,
        json: async () => page(
          Array.from({ length: pageNo === 1 ? 250 : 1 }, (_, i) => row(i)),
          pageNo,
          251
        ),
      };
    });
    vi.stubGlobal("fetch", fetcher);
    await exportPressingReport(filters, ["articleCode", "weightKg", "bales"]);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0], "http://localhost").searchParams.get("asOf")).toBeNull();
    expect(new URL(requests[1], "http://localhost").searchParams.get("asOf")).toBe(cutoff);
    expect(mocks.exportWorkbook).toHaveBeenCalledTimes(1);
    const spec = mocks.exportWorkbook.mock.calls[0][0];
    expect(spec.fileName).toBe("pressing-machines-condensed-2026-11-13_2026-11-13.xlsx");
    expect(spec.sheets[0].rows).toHaveLength(251);
    expect(spec.sheets[0].columns.map((col: { key: string }) => col.key)).toEqual([
      "articleCode", "weightKg", "bales",
    ]);
    expect(spec.sheets[0].rows[0]).toEqual({ articleCode: "001234", weightKg: 25, bales: 1 });
    expect(spec.sheets[0].footer).toEqual({ articleCode: "TOTAL ACTIVE", weightKg: 6275, bales: 251 });
  });

  it("fails without downloading if the server reports an incomplete page", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => ({
      ok: true,
      json: async () => page(
        Array.from({ length: new URL(input, "http://localhost").searchParams.get("page") === "1" ? 250 : 0 },
          (_, i) => row(i)),
        Number(new URL(input, "http://localhost").searchParams.get("page")),
        251
      ),
    })));
    await expect(exportPressingReport(filters, ["articleCode"])).rejects.toThrow(/changed during export/);
    expect(mocks.exportWorkbook).not.toHaveBeenCalled();
  });
});
