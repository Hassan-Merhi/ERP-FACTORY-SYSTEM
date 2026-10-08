import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  selectResults: [] as unknown[][],
  dbSelect: vi.fn(),
  getFactoryCompanyId: vi.fn(),
}));

function makeSelectBuilder(result: unknown[]) {
  const builder: any = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../server/db", () => ({
  db: {
    select: harness.dbSelect,
  },
}));
vi.mock("../server/routes/payroll/core/_helpers", () => ({
  getFactoryCompanyId: harness.getFactoryCompanyId,
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  gte: (column: unknown, value: unknown) => ({ type: "gte", column, value }),
  lte: (column: unknown, value: unknown) => ({ type: "lte", column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ type: "inArray", column, values }),
}));
vi.mock("@shared/schema", () => ({
  companies: { id: "companies.id" },
  factoryWorkers: {
    id: "factoryWorkers.id",
    companyId: "factoryWorkers.companyId",
    active: "factoryWorkers.active",
  },
  factoryWorkerAdvances: {
    companyId: "factoryWorkerAdvances.companyId",
    fullyPaid: "factoryWorkerAdvances.fullyPaid",
    advanceDate: "factoryWorkerAdvances.advanceDate",
  },
  factoryWorkerDeductions: {
    companyId: "factoryWorkerDeductions.companyId",
    applied: "factoryWorkerDeductions.applied",
  },
  factoryAttendance: {
    companyId: "factoryAttendance.companyId",
    attendanceDate: "factoryAttendance.attendanceDate",
    workerId: "factoryAttendance.workerId",
  },
}));

import { registerPayrollPreviewRoutes } from "../server/routes/payroll/core/preview";

describe("factory payroll preview route behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    harness.selectResults.splice(0);
    harness.dbSelect.mockImplementation(() => makeSelectBuilder(harness.selectResults.shift() ?? []));
    harness.getFactoryCompanyId.mockReturnValue(4);

    registerPayrollPreviewRoutes({
      post: (path: string, ...callbacks: Array<(...args: any[]) => unknown>) => {
        harness.handlers.set(path, callbacks.at(-1)!);
      },
    } as never);
  });

  it("calculates attendance-prorated monthly pay, transport, salary advances, loans, deductions, and other frequencies", async () => {
    harness.selectResults.push(
      [
        {
          id: 1,
          employeeCode: "FAC-001",
          fullName: "Monthly Worker",
          position: "Pressing",
          baseSalary: "1000",
          payFrequency: "Monthly",
          salaryType: "Monthly",
          transportAllowance: "90",
        },
        {
          id: 2,
          fullName: "Daily Worker",
          position: "Sorting",
          baseSalary: "20",
          payFrequency: "Daily",
          salaryType: "Daily",
          transportAllowance: "60",
        },
        {
          id: 3,
          fullName: "Weekly Worker",
          position: "Loading",
          baseSalary: "700",
          payFrequency: "Weekly",
          salaryType: "Monthly",
          transportAllowance: "0",
        },
        {
          id: 4,
          fullName: "Biweekly Worker",
          position: "Loading",
          baseSalary: "1400",
          payFrequency: "Bi-Weekly",
          salaryType: "Monthly",
          transportAllowance: "0",
        },
      ],
      [
        { workerId: 1, attendanceDate: "2026-04-03", status: "Absent" },
        { workerId: 1, attendanceDate: "2026-04-01", status: "Present" },
        { workerId: 1, attendanceDate: "2026-04-02", status: "Half Day" },
      ],
      [
        {
          id: 10,
          workerId: 1,
          advanceDate: "2026-03-01",
          amount: "200",
          remainingBalance: "200",
          notes: "salary advance",
          repaymentType: "salary_deduction",
        },
        {
          id: 11,
          workerId: 1,
          advanceDate: "2026-03-02",
          amount: "300",
          remainingBalance: "300",
          notes: "manual loan",
          repaymentType: "manual_repayment",
        },
      ],
      [
        {
          id: 20,
          workerId: 1,
          amount: "30",
          reason: "uniform",
          deductionDate: "2026-04-05",
        },
      ]
    );

    const req = {
      body: {
        companyId: 4,
        periodStart: "2026-04-01",
        periodEnd: "2026-04-15",
        daysCount: "15",
        bonusPerWorker: "50",
        transportOverrides: { "2": "45" },
      },
    };
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);

    await harness.handlers.get("/api/factory/payrolls/preview")!(req, res);

    expect(res.json).toHaveBeenCalledOnce();
    const [rows] = res.json.mock.calls[0];

    expect(rows[0]).toMatchObject({
      id: 1,
      employeeCode: "FAC-001",
      // 1.5 attended days of 30 at 1000/month; transport 90 × 1.5 / 30.
      base: 50,
      bonus: 50,
      transport: 4.5,
      transportMonthly: 90,
      // The salary advance takes the whole gross, as generate-bulk does.
      advanceDeduction: 104.5,
      totalAdvanceBalance: 200,
      pendingDeductions: 30,
      totalLoanBalance: 300,
      net: -30,
      totalWorkingDays: 30,
      presentDays: 1.5,
      absentDays: 1.5,
    });
    expect(rows[0].presentDates).toEqual([{ date: "2026-04-01", status: "Present" }]);
    expect(rows[0].halfDayDates).toEqual([{ date: "2026-04-02", status: "Half Day" }]);
    expect(rows[0].absentDates).toEqual([{ date: "2026-04-03", status: "Absent" }]);
    expect(rows[0].pendingAdvances).toHaveLength(1);
    expect(rows[0].outstandingLoans).toHaveLength(1);

    expect(rows[1]).toMatchObject({ id: 2, base: 300, transport: 45, bonus: 50, net: 395 });
    expect(rows[2]).toMatchObject({ id: 3, base: 1500, bonus: 50, net: 1550 });
    expect(rows[3]).toMatchObject({ id: 4, base: 1500, bonus: 50, net: 1550 });
  });

  it("honors explicit worker IDs and uses calendar-day monthly fallback when attendance is absent", async () => {
    harness.selectResults.push(
      [
        {
          id: 9,
          fullName: "No Attendance",
          position: null,
          baseSalary: "900",
          payFrequency: "Monthly",
          salaryType: "Monthly",
          transportAllowance: "120",
        },
      ],
      [],
      [],
      []
    );

    const req = {
      body: {
        workerIds: [9],
        periodStart: "2026-05-01",
        periodEnd: "2026-05-15",
      },
    };
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);

    await harness.handlers.get("/api/factory/payrolls/preview")!(req, res);

    expect(harness.getFactoryCompanyId).toHaveBeenCalledWith(req);
    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 9,
        // 900 × 15 / 31 = 435.483… taken at cents.
        base: 435.48,
        transport: 120,
        net: 555.48,
        presentDays: 0,
        absentDays: 0,
        totalWorkingDays: 31,
      }),
    ]);
  });

  it("shows the amounts generate-bulk stores: weekly rates, cents, and exact sums", async () => {
    harness.selectResults.push(
      [
        {
          id: 5,
          fullName: "Weekly Rate Worker",
          baseSalary: "3000",
          weeklySalary: "700",
          payFrequency: "Weekly",
          salaryType: "Monthly",
          transportAllowance: "0",
        },
        {
          id: 6,
          fullName: "One Day Worker",
          baseSalary: "1000",
          payFrequency: "Monthly",
          salaryType: "Monthly",
          transportAllowance: "50",
        },
      ],
      [{ workerId: 6, attendanceDate: "2026-04-01", status: "Present" }],
      [],
      []
    );

    const req = { body: { companyId: 4, periodStart: "2026-04-01", periodEnd: "2026-04-14", daysCount: "14" } };
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);

    await harness.handlers.get("/api/factory/payrolls/preview")!(req, res);

    const [rows] = res.json.mock.calls[0];
    // Weekly pay comes from weeklySalary (700 × 14 / 7), not the monthly base salary.
    expect(rows[0]).toMatchObject({ id: 5, base: 1400, net: 1400 });
    // 1000 / 30 = 33.333… → 33.33 and 50 / 30 = 1.666… → 1.67; the net is their exact sum.
    expect(rows[1]).toMatchObject({ id: 6, base: 33.33, transport: 1.67, net: 35 });
  });

  it("rejects a bonus that is not a number", async () => {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);

    await harness.handlers.get("/api/factory/payrolls/preview")!(
      { body: { companyId: 4, periodStart: "2026-04-01", periodEnd: "2026-04-14", bonusPerWorker: "abc" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid amount" });
    expect(harness.dbSelect).not.toHaveBeenCalled();
  });

  it("rejects missing company or period before reading payroll data", async () => {
    harness.getFactoryCompanyId.mockReturnValue(null);
    const noCompanyRes = { status: vi.fn(), json: vi.fn() };
    noCompanyRes.status.mockReturnValue(noCompanyRes);

    await harness.handlers.get("/api/factory/payrolls/preview")!({ body: {} }, noCompanyRes);
    expect(noCompanyRes.status).toHaveBeenCalledWith(400);
    expect(noCompanyRes.json).toHaveBeenCalledWith({ message: "No company selected" });
    expect(harness.dbSelect).not.toHaveBeenCalled();

    harness.getFactoryCompanyId.mockReturnValue(4);
    const noPeriodRes = { status: vi.fn(), json: vi.fn() };
    noPeriodRes.status.mockReturnValue(noPeriodRes);
    await harness.handlers.get("/api/factory/payrolls/preview")!({ body: {} }, noPeriodRes);
    expect(noPeriodRes.status).toHaveBeenCalledWith(400);
    expect(noPeriodRes.json).toHaveBeenCalledWith({ message: "Period dates required" });
    expect(harness.dbSelect).not.toHaveBeenCalled();
  });
});
