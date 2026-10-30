/**
 * The core scheduler registers every recurring job once and, on each tick,
 * loads a job module only when its settings say work is due: the stock report
 * and net-position export follow their daily/weekly/monthly send hour, the
 * containers WhatsApp report its hour and a 12-hour gap, and any of them runs
 * early to retry a failed WhatsApp delivery. The daily export runs once per
 * day in its configured hour, and the rental catch-up posts every company and
 * module, counting failures instead of stopping. Cron, the clock, the database
 * and the job modules are all faked.
 */
const jobs = vi.hoisted(() => ({
  stockReport: vi.fn(),
  netPositionExport: vi.fn(),
  containers: vi.fn(),
  purge: vi.fn(),
  monthlyNetPosition: vi.fn(),
  overdue: vi.fn(),
  dailyExport: vi.fn(),
  exportSucceeded: vi.fn(),
  exportRunning: vi.fn(),
  postDueRental: vi.fn(),
  recurring: vi.fn(),
  convergence: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/db")>()),
  pool: { query: (...args: unknown[]) => jobs.query(...args) },
}));

vi.mock("../server/services/scheduler/stock-report", () => ({
  checkAndRunStockReport: jobs.stockReport,
  checkAndRunNetPositionExport: jobs.netPositionExport,
}));
vi.mock("../server/services/scheduler/maintenance", () => ({
  checkAndRunContainersWhatsApp: jobs.containers,
  purgeOldSoftDeletes: jobs.purge,
}));
vi.mock("../server/services/scheduler/net-position", () => ({
  runMonthlyWhatsAppNetPosition: jobs.monthlyNetPosition,
  checkOverdueCustomers: jobs.overdue,
}));
vi.mock("../server/services/scheduler/daily-export", () => ({ runDailyExport: jobs.dailyExport }));
vi.mock("../server/services/scheduler/daily-export-state", () => ({
  hasTodayExportSucceeded: jobs.exportSucceeded,
  isTodayExportRunning: jobs.exportRunning,
}));
vi.mock("../server/services/rental/dueRentalPosting", () => ({ postDueRentalForCompany: jobs.postDueRental }));
vi.mock("../server/services/accounting/recurringJournalService", () => ({ runDueRecurringJournals: jobs.recurring }));
vi.mock("../server/services/accounting/scheduledConvergenceReconciliation", () => ({
  runScheduledConvergenceReconciliation: jobs.convergence,
}));

import cron from "node-cron";
import { logger } from "../server/lib/logger";
import { runDailyRentalAccrual, startScheduler } from "../server/services/scheduler/scheduled-jobs";

type Row = Record<string, unknown>;
const ticks = new Map<string, () => Promise<void>>();
let tables: Record<string, Row[] | Error> = {};

function settings(table: string, rows: Row[] | Error) {
  tables[table] = rows;
}

function answer(sql: string): { rows: Row[]; rowCount: number } {
  const table = [
    "scheduled_whatsapp_occurrences",
    "whatsapp_stock_settings",
    "net_position_export_settings",
    "whatsapp_settings",
    "export_settings",
    "companies",
  ].find((name) => sql.includes(`FROM ${name}`));
  const rows = table ? (tables[table] ?? []) : [];
  if (rows instanceof Error) throw rows;
  return { rows, rowCount: rows.length };
}

const tick = (expression: string) => ticks.get(expression)!();
const nyHour = (hour: number, day = "2026-10-21") => {
  // October 2026 is EDT (UTC-4).
  vi.setSystemTime(new Date(`${day}T${String(hour + 4).padStart(2, "0")}:00:00Z`));
};

let registrations = 0;
beforeAll(() => {
  vi.spyOn(cron, "schedule").mockImplementation(((expression: string, run: () => Promise<void>) => {
    registrations += 1;
    ticks.set(expression, run);
    return { stop: vi.fn() };
  }) as never);
  startScheduler();
  startScheduler();
});

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
  vi.useFakeTimers({ toFake: ["Date"] });
  tables = {};
  for (const fn of Object.values(jobs)) fn.mockReset();
  jobs.query.mockImplementation(async (sql: string) => answer(sql));
});

afterEach(() => {
  vi.useRealTimers();
});

it("registers each job once, on its schedule", () => {
  expect([...ticks.keys()].sort()).toEqual(
    [
      "0 7 1 * *",
      "20 * * * *",
      "0 6 * * *",
      "0 * * * *",
      "5 * * * *",
      "10,25,40,55 * * * *",
      "15 * * * *",
      "30 3 * * *",
      "0 9 * * *",
      "0 2 * * *",
    ].sort()
  );
  // The second startScheduler() call registered nothing.
  expect(registrations).toBe(10);
});

it("runs the always-on jobs straight through to their modules", async () => {
  for (const expression of ["0 7 1 * *", "20 * * * *", "30 3 * * *", "0 9 * * *", "0 2 * * *"]) await tick(expression);

  expect(jobs.monthlyNetPosition).toHaveBeenCalledTimes(1);
  expect(jobs.recurring).toHaveBeenCalledTimes(1);
  expect(jobs.convergence).toHaveBeenCalledTimes(1);
  expect(jobs.overdue).toHaveBeenCalledTimes(1);
  expect(jobs.purge).toHaveBeenCalledTimes(1);
});

describe("hourly stock report", () => {
  const stock = (overrides: Row = {}) =>
    settings("whatsapp_stock_settings", [
      {
        company_id: 4,
        recipient_id: 9,
        enabled: true,
        auto_send: true,
        frequency: "daily",
        send_hour: 18,
        last_sent_at: null,
        ...overrides,
      },
    ]);

  it("sends at the configured hour, once a day", async () => {
    stock();
    nyHour(17);
    await tick("0 * * * *");
    expect(jobs.stockReport).not.toHaveBeenCalled();

    nyHour(18);
    await tick("0 * * * *");
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);

    stock({ last_sent_at: "2026-10-21T22:01:00Z" });
    await tick("0 * * * *");
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["disabled", { enabled: false }],
    ["not auto-sent", { auto_send: false }],
    ["missing a recipient", { recipient_id: null }],
    ["missing a company", { company_id: null }],
    ["on an unknown frequency", { frequency: "hourly" }],
  ])("does nothing when %s", async (_label, overrides) => {
    stock(overrides);
    nyHour(18);

    await tick("0 * * * *");

    expect(jobs.stockReport).not.toHaveBeenCalled();
  });

  it("sends weekly on the configured day only, once that week", async () => {
    stock({ frequency: "weekly", send_day_of_week: 3 });
    nyHour(18, "2026-10-20"); // Tuesday
    await tick("0 * * * *");
    expect(jobs.stockReport).not.toHaveBeenCalled();

    nyHour(18, "2026-10-21"); // Wednesday
    await tick("0 * * * *");
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);

    stock({ frequency: "weekly", send_day_of_week: 3, last_sent_at: "2026-10-19T22:00:00Z" });
    await tick("0 * * * *");
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);
  });

  it("sends monthly on the first, once that month", async () => {
    stock({ frequency: "monthly" });
    nyHour(18, "2026-10-02");
    await tick("0 * * * *");
    expect(jobs.stockReport).not.toHaveBeenCalled();

    nyHour(18, "2026-10-01");
    await tick("0 * * * *");
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);

    stock({ frequency: "monthly", last_sent_at: "2026-10-01T22:00:00Z" });
    await tick("0 * * * *");
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);
  });

  it("retries a failed WhatsApp delivery outside the send hour", async () => {
    stock();
    settings("scheduled_whatsapp_occurrences", [{ "?column?": 1 }]);
    nyHour(11);

    await tick("0 * * * *");

    expect(jobs.stockReport).toHaveBeenCalledTimes(1);
  });

  it("falls back to the due-time check while the delivery tables do not exist yet", async () => {
    stock();
    settings("scheduled_whatsapp_occurrences", Object.assign(new Error("missing"), { code: "42P01" }));
    nyHour(18);
    await tick("0 * * * *");
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);

    settings("scheduled_whatsapp_occurrences", new Error("connection lost"));
    await expect(tick("0 * * * *")).resolves.toBeUndefined();
    expect(jobs.stockReport).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("cron hourlyStockReport failed", expect.anything());
  });
});

describe("hourly net-position export", () => {
  it("runs at its send hour and not again the same day", async () => {
    settings("net_position_export_settings", [
      { enabled: true, auto_send: true, frequency: "daily", send_hour: 7, last_sent_at: null },
    ]);
    nyHour(7);
    await tick("5 * * * *");
    expect(jobs.netPositionExport).toHaveBeenCalledTimes(1);

    settings("net_position_export_settings", [
      { enabled: true, auto_send: true, frequency: "daily", send_hour: 7, last_sent_at: "2026-10-21T11:30:00Z" },
    ]);
    await tick("5 * * * *");
    settings("net_position_export_settings", []);
    await tick("5 * * * *");
    expect(jobs.netPositionExport).toHaveBeenCalledTimes(1);
  });
});

describe("hourly containers WhatsApp", () => {
  const wa = (overrides: Row = {}) =>
    settings("whatsapp_settings", [
      {
        instance_id: "i",
        api_token: "t",
        enabled: true,
        group_chat_id: "g",
        schedule_enabled: true,
        schedule_hour: 8,
        last_sent_at: null,
        ...overrides,
      },
    ]);

  it("sends at its hour unless it sent within the last 12 hours", async () => {
    wa();
    nyHour(7);
    await tick("15 * * * *");
    expect(jobs.containers).not.toHaveBeenCalled();

    nyHour(8);
    await tick("15 * * * *");
    expect(jobs.containers).toHaveBeenCalledTimes(1);

    wa({ last_sent_at: "2026-10-21T05:00:00Z" });
    await tick("15 * * * *");
    expect(jobs.containers).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["disabled", { enabled: false }],
    ["without a group", { group_chat_id: null }],
    ["unscheduled", { schedule_enabled: false }],
  ])("does nothing when %s", async (_label, overrides) => {
    wa(overrides);
    nyHour(8);
    await tick("15 * * * *");
    expect(jobs.containers).not.toHaveBeenCalled();
  });

  it("retries a failed delivery outside its hour", async () => {
    wa();
    settings("scheduled_whatsapp_occurrences", [{ "?column?": 1 }]);
    nyHour(15);

    await tick("15 * * * *");

    expect(jobs.containers).toHaveBeenCalledTimes(1);
  });
});

describe("scheduled daily export", () => {
  const exportSettings = (overrides: Row = {}) =>
    settings("export_settings", [{ schedule_enabled: true, schedule_hour: 18, schedule_timezone: null, ...overrides }]);

  it("runs in its configured hour unless today's export succeeded or is running", async () => {
    exportSettings();
    jobs.exportSucceeded.mockResolvedValue(false);
    jobs.exportRunning.mockResolvedValue(false);
    jobs.dailyExport.mockResolvedValue(true);

    nyHour(17);
    await tick("10,25,40,55 * * * *");
    expect(jobs.dailyExport).not.toHaveBeenCalled();

    nyHour(18);
    await tick("10,25,40,55 * * * *");
    expect(jobs.dailyExport).toHaveBeenCalledTimes(1);

    jobs.exportRunning.mockResolvedValue(true);
    await tick("10,25,40,55 * * * *");
    jobs.exportRunning.mockResolvedValue(false);
    jobs.exportSucceeded.mockResolvedValue(true);
    await tick("10,25,40,55 * * * *");
    expect(jobs.dailyExport).toHaveBeenCalledTimes(1);
  });

  it("uses the configured timezone and logs a failed attempt for the next tick to retry", async () => {
    exportSettings({ schedule_hour: 0, schedule_timezone: "UTC" });
    jobs.exportSucceeded.mockResolvedValue(false);
    jobs.exportRunning.mockResolvedValue(false);
    jobs.dailyExport.mockResolvedValue(false);
    vi.setSystemTime(new Date("2026-10-21T00:30:00Z"));

    await tick("10,25,40,55 * * * *");

    expect(jobs.dailyExport).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Attempt failed"));
  });

  it("does nothing when the schedule is off or unconfigured, and survives a broken settings read", async () => {
    exportSettings({ schedule_enabled: false });
    nyHour(18);
    await tick("10,25,40,55 * * * *");
    settings("export_settings", []);
    await tick("10,25,40,55 * * * *");
    settings("export_settings", new Error("db down"));
    await expect(tick("10,25,40,55 * * * *")).resolves.toBeUndefined();

    expect(jobs.dailyExport).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "[DailyExport] checkAndRunScheduledDailyExport error:",
      expect.anything()
    );
  });
});

describe("daily rental catch-up", () => {
  it("posts every module of every company and adds up the results, counting a failure without stopping", async () => {
    settings("companies", [{ id: 1 }, { id: 2 }]);
    jobs.postDueRental.mockImplementation(async (companyId: number, module: string) => {
      if (companyId === 2 && module === "FACTORY") throw new Error("closed period");
      return {
        accrued: 1,
        scheduledPaymentsPosted: 2,
        scheduledPaymentsFailed: 0,
        skipped: module === "ERP" ? ["x"] : [],
      };
    });

    const totals = await runDailyRentalAccrual();

    expect(jobs.postDueRental).toHaveBeenCalledTimes(6);
    expect(jobs.postDueRental).toHaveBeenCalledWith(1, "PROPERTIES", { trigger: "scheduler" });
    expect(totals).toEqual({ accrued: 5, scheduledPaymentsPosted: 10, skipped: 2, failed: 1 });
  });

  it("reports nothing posted when the company list cannot be read", async () => {
    settings("companies", new Error("db down"));

    expect(await runDailyRentalAccrual()).toEqual({ accrued: 0, scheduledPaymentsPosted: 0, skipped: 0, failed: 0 });
  });

  it("runs from its daily tick", async () => {
    settings("companies", []);
    await tick("0 6 * * *");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[RentalAccrual] Daily billing-date catch-up complete")
    );
  });
});
