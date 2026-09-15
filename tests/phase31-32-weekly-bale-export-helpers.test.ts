import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  select: vi.fn(),
  selectResults: [] as unknown[][],
}));

function selectChain(result: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

vi.mock("../server/db", () => ({
  db: {
    select: harness.select,
  },
}));

import {
  _wrDateOnly,
  _wrDayName,
  _wrFmtDate,
  _wrIsoWeekKey,
  _wrMondayOfWeek,
  buildWeeklyReportExcelBuffer,
} from "../server/routes/factory/bale-exports/_helpers";

beforeEach(() => {
  vi.clearAllMocks();
  harness.selectResults.length = 0;
  harness.select.mockImplementation(() => selectChain(harness.selectResults.shift() ?? []));
});

async function readWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

function worksheetValues(workbook: ExcelJS.Workbook) {
  const sheet = workbook.getWorksheet("Weekly Report");
  expect(sheet).toBeDefined();
  const values: string[] = [];
  sheet!.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.value != null) values.push(String(cell.value));
    });
  });
  return values;
}

describe("phases 31-32 weekly bale export function and line gaps", () => {
  it("normalizes weekly date helpers across weekdays, Sunday, strings, and Date values", () => {
    expect(_wrMondayOfWeek("2026-09-15")).toBe("2026-09-14");
    expect(_wrMondayOfWeek("2026-09-20")).toBe("2026-09-14");
    expect(_wrIsoWeekKey("2026-09-14")).toBe(_wrIsoWeekKey("2026-09-20"));
    expect(_wrDayName("2026-09-14")).toBe("MON");
    expect(_wrDayName("2026-09-20")).toBe("SUN");
    expect(_wrFmtDate("2026-09-15")).toBe("15/09");
    expect(_wrDateOnly("2026-09-15T12:34:56.000Z")).toBe("2026-09-15");
    expect(_wrDateOnly(new Date("2026-09-16T08:30:00.000Z"))).toBe("2026-09-16");
  });

  it("builds a valid empty workbook instead of failing when no production rows exist", async () => {
    harness.selectResults.push([], [], [], []);

    const buffer = await buildWeeklyReportExcelBuffer(7, "all");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(harness.select).toHaveBeenCalledTimes(4);

    const workbook = await readWorkbook(buffer);
    const values = worksheetValues(workbook);
    expect(values).toContain("No production data found");
  });

  it("aggregates receipts, adjustments, mix consumption, and residual used stock into a weekly workbook", async () => {
    harness.selectResults.push(
      [
        {
          containerId: 101,
          categoryId: 10,
          receivedKg: "100",
          usedKg: "35",
          offloadedAt: new Date("2026-09-14T09:00:00.000Z"),
        },
        {
          containerId: 102,
          categoryId: null,
          receivedKg: "50",
          usedKg: "0",
          offloadedAt: new Date("2026-09-15T09:00:00.000Z"),
        },
      ],
      [{ id: 10, name: "Cotton" }],
      [
        { date: "2026-09-15", type: "ADD", kg: "20", catId: 10 },
        { date: new Date("2026-09-16T00:00:00.000Z"), type: "REMOVE", kg: "5", catId: 10 },
        { date: "2026-09-17", type: "REMOVE", kg: "0", catId: null },
      ],
      [
        {
          containerId: 101,
          batchDate: "2026-09-15",
          batchCreatedAt: new Date("2026-09-15T12:00:00.000Z"),
          catId: 10,
          weightKg: "30",
        },
        {
          containerId: 102,
          batchDate: null,
          batchCreatedAt: new Date("2026-09-16T12:00:00.000Z"),
          catId: null,
          weightKg: "10",
        },
      ]
    );

    const buffer = await buildWeeklyReportExcelBuffer(7, "all");
    const workbook = await readWorkbook(buffer);
    const values = worksheetValues(workbook);

    expect(values.some((value) => value.startsWith("Week of "))).toBe(true);
    expect(values).toContain("Cotton");
    expect(values).toContain("Uncategorized");
    expect(values).not.toContain("No production data found");
  });
});
