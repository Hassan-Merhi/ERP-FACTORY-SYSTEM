import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  schedules: [] as Array<{ expression: string; tick: () => Promise<void>; options?: unknown }>,
  core: vi.fn(),
  locationStock: vi.fn(),
  customMessages: vi.fn(),
  factoryStock: vi.fn(),
  recover: vi.fn(),
  manual: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: (expression: string, tick: () => Promise<void>, options?: unknown) => {
      h.schedules.push({ expression, tick, options });
    },
  },
}));
vi.mock("../server/services/scheduler/scheduled-jobs", () => ({ startScheduler: () => h.core() }));
vi.mock("../server/services/scheduler/location-stock-report", () => ({
  checkAndRunLocationStockReports: () => h.locationStock(),
}));
vi.mock("../server/services/scheduledWhatsAppMessages", () => ({
  runScheduledWhatsAppMessages: () => h.customMessages(),
}));
vi.mock("../server/services/accounting/perpetualInventory/factoryStockJournal", () => ({
  runFactoryStockJournals: () => h.factoryStock(),
}));
vi.mock("../server/services/scheduler/daily-export-state", () => ({
  checkAndRecoverDailyExport: () => h.recover(),
}));
vi.mock("../server/services/scheduler/maintenance", () => ({
  triggerDailyWhatsAppSendNow: (...args: unknown[]) => h.manual(...args),
}));

import { logger } from "../server/lib/logger";

const original = process.env.ENABLE_SCHEDULERS;

beforeEach(() => {
  h.schedules = [];
  for (const fn of [h.core, h.locationStock, h.customMessages, h.factoryStock, h.recover, h.manual]) fn.mockReset();
  vi.spyOn(logger, "info").mockImplementation(() => logger);
});

afterEach(() => {
  if (original === undefined) delete process.env.ENABLE_SCHEDULERS;
  else process.env.ENABLE_SCHEDULERS = original;
  vi.restoreAllMocks();
});

const load = () => import("../server/services/scheduler/index");

describe("scheduler entrypoint", () => {
  it("is enabled unless explicitly switched off", async () => {
    const { schedulersEnabled } = await load();
    expect(schedulersEnabled({})).toBe(true);
    expect(schedulersEnabled({ ENABLE_SCHEDULERS: "true" })).toBe(true);
    expect(schedulersEnabled({ ENABLE_SCHEDULERS: "0" })).toBe(true);
    expect(schedulersEnabled({ ENABLE_SCHEDULERS: "false" })).toBe(false);
  });

  it("registers nothing when schedulers are disabled", async () => {
    process.env.ENABLE_SCHEDULERS = "false";
    const { startScheduler } = await load();
    startScheduler();
    expect(h.core).not.toHaveBeenCalled();
    expect(h.schedules).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith("Schedulers disabled; cron registration skipped", {
      module: "scheduler",
      action: "start",
    });
  });

  it("registers the core jobs and the three extra ticks once", async () => {
    delete process.env.ENABLE_SCHEDULERS;
    const { startScheduler } = await load();
    startScheduler();
    startScheduler();
    expect(h.core).toHaveBeenCalledTimes(2);
    expect(h.schedules.map((s) => [s.expression, s.options])).toEqual([
      ["* * * * *", undefined],
      ["* * * * *", undefined],
      ["45 23 * * *", { timezone: "UTC" }],
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "Location stock WhatsApp scheduler registered",
      expect.objectContaining({ jobs: expect.arrayContaining(["factoryStockJournal(23:45 UTC daily)"]) })
    );

    // Each tick loads its job module lazily and runs it.
    for (const schedule of h.schedules) await schedule.tick();
    expect(h.locationStock).toHaveBeenCalledTimes(1);
    expect(h.customMessages).toHaveBeenCalledTimes(1);
    expect(h.factoryStock).toHaveBeenCalledTimes(1);
  });

  it("delegates recovery and the manual WhatsApp send to their modules", async () => {
    const { checkAndRecoverDailyExport, triggerDailyWhatsAppSendNow } = await load();
    h.manual.mockResolvedValue({ message: "sent" });
    await checkAndRecoverDailyExport();
    expect(h.recover).toHaveBeenCalledTimes(1);
    await expect(triggerDailyWhatsAppSendNow("2026-01-01", "2026-02-01")).resolves.toEqual({ message: "sent" });
    expect(h.manual).toHaveBeenCalledWith("2026-01-01", "2026-02-01");
  });
});
