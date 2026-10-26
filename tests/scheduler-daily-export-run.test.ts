import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  queries: [] as string[],
  settings: [] as unknown[],
  succeeded: false,
  running: false,
  queryError: null as Error | null,
  companies: [] as Array<{ id: number; name: string }>,
  emailEnabled: true,
  wa: null as unknown,
  artifact: null as unknown,
  artifactError: null as Error | null,
  email: vi.fn(),
  whatsapp: vi.fn(),
  excel: vi.fn(),
  runs: [] as Array<{ id: number; type: string }>,
  updates: [] as Array<[number, Record<string, unknown>]>,
  finishes: [] as Array<[number, Record<string, unknown>]>,
  finishError: null as Error | null,
  retries: [] as Array<{ label: string; attempts: number; delayMs: number }>,
}));

vi.mock("../server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/db")>()),
  pool: {
    query: async (sql: string) => {
      deps.queries.push(sql);
      if (deps.queryError) throw deps.queryError;
      if (sql.includes("FROM export_settings")) return { rows: deps.settings };
      if (sql.includes("status   IN ('success', 'partial_failed')"))
        return { rowCount: deps.succeeded ? 1 : 0, rows: [] };
      if (sql.includes("status   = 'running'")) return { rowCount: deps.running ? 1 : 0, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  },
}));
vi.mock("../server/services/export-data", () => ({ fetchAllCompanies: async () => deps.companies }));
vi.mock("../server/services/emailService", () => ({ sendExportEmail: (...args: unknown[]) => deps.email(...args) }));
vi.mock("../server/services/whatsappService", () => ({ getWaSettings: async () => deps.wa }));
vi.mock("../server/helpers/generateNetPositionExcel", () => ({
  generateNetPositionExcel: (...args: unknown[]) => deps.excel(...args),
}));
vi.mock("../server/helpers/exportRunTracker", () => ({
  createExportRun: async (type: string) => {
    const id = deps.runs.length + 1;
    deps.runs.push({ id, type });
    return id;
  },
  updateExportRun: async (id: number, data: Record<string, unknown>) => {
    deps.updates.push([id, data]);
  },
  finishExportRun: async (id: number, data: Record<string, unknown>) => {
    deps.finishes.push([id, data]);
    if (deps.finishError) throw deps.finishError;
  },
}));
vi.mock("../server/helpers/scheduledExportArtifact", () => ({
  createScheduledExportArtifact: async () => {
    if (deps.artifactError) throw deps.artifactError;
    return deps.artifact;
  },
}));
vi.mock("../server/helpers/retryAsync", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/helpers/retryAsync")>();
  return {
    ...original,
    retryAsync: (options: Parameters<typeof original.retryAsync>[0]) => {
      deps.retries.push({ label: options.label, attempts: options.attempts, delayMs: options.delayMs });
      return original.retryAsync({ ...options, delayMs: 0 });
    },
  };
});
vi.mock("../server/services/scheduler/net-position", () => ({ isScheduleEnabled: async () => deps.emailEnabled }));
vi.mock("../server/services/scheduler/whatsapp-send", () => ({
  runDailyWhatsAppSend: (...args: unknown[]) => deps.whatsapp(...args),
}));

import {
  buildNetPositionZip,
  checkAndRecoverDailyExport,
  getTodayLabel,
  hasTodayExportSucceeded,
  isTodayExportRunning,
  runDailyExport,
} from "../server/services/scheduler/daily-export";
import { logger } from "../server/lib/logger";

const dispose = vi.fn(async () => undefined);
const companies = [
  { id: 1, name: "Acme" },
  { id: 2, name: "Beta" },
];
const waReady = { enabled: true, dailyAutoSend: true, dailyRecipientId: 9 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 16:00 in New York (EDT).
  vi.setSystemTime(new Date("2026-10-20T20:00:00Z"));
  Object.assign(deps, {
    queries: [],
    settings: [],
    succeeded: false,
    running: false,
    queryError: null,
    companies,
    emailEnabled: true,
    wa: null,
    artifact: {
      attachment: Buffer.from("zip"),
      names: ["Acme.xlsx", "Beta.xlsx"],
      skipped: [],
      sizeBytes: 2 * 1024 * 1024,
      dispose,
    },
    artifactError: null,
    runs: [],
    updates: [],
    finishes: [],
    finishError: null,
    retries: [],
  });
  dispose.mockClear();
  deps.email.mockReset().mockResolvedValue({ success: true });
  deps.whatsapp.mockReset().mockResolvedValue({ sent: true, skipped: false });
  deps.excel.mockReset();
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("export run state checks", () => {
  it("labels today in UTC", () => {
    expect(getTodayLabel()).toBe("2026-10-20");
  });

  it("reads today's scheduled run state and treats errors as false", async () => {
    await expect(hasTodayExportSucceeded()).resolves.toBe(false);
    await expect(isTodayExportRunning()).resolves.toBe(false);
    deps.succeeded = true;
    deps.running = true;
    await expect(hasTodayExportSucceeded()).resolves.toBe(true);
    await expect(isTodayExportRunning()).resolves.toBe(true);
    deps.queryError = new Error("db down");
    await expect(hasTodayExportSucceeded()).resolves.toBe(false);
    await expect(isTodayExportRunning()).resolves.toBe(false);
  });
});

describe("checkAndRecoverDailyExport", () => {
  it("does nothing without settings or with the schedule disabled", async () => {
    await checkAndRecoverDailyExport();
    deps.settings = [{ schedule_enabled: false, schedule_hour: 1 }];
    await checkAndRecoverDailyExport();
    expect(deps.runs).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith("[DailyExport] Recovery check: schedule is disabled — skipping.");
  });

  it("waits for the scheduled hour in the configured time zone", async () => {
    deps.settings = [{ schedule_enabled: true, schedule_hour: 17, schedule_timezone: null }];
    await checkAndRecoverDailyExport();
    expect(deps.runs).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "[DailyExport] Recovery check: current hour (16:xx America/New_York) is before scheduled hour (17:00) — skipping."
    );

    // It is already 20:00 in UTC.
    deps.settings = [{ schedule_enabled: true, schedule_hour: 17, schedule_timezone: "UTC" }];
    await checkAndRecoverDailyExport();
    expect(deps.runs).toHaveLength(1);
  });

  it("defaults to 18:00 when no hour is stored", async () => {
    deps.settings = [{ schedule_enabled: true, schedule_hour: null, schedule_timezone: "Asia/Tokyo" }];
    // 05:00 the next morning in Tokyo.
    await checkAndRecoverDailyExport();
    expect(logger.info).toHaveBeenCalledWith(
      "[DailyExport] Recovery check: current hour (5:xx Asia/Tokyo) is before scheduled hour (18:00) — skipping."
    );
  });

  it("skips a run that already succeeded or is still running, and reruns a missed one", async () => {
    deps.settings = [{ schedule_enabled: true, schedule_hour: 16, schedule_timezone: "America/New_York" }];
    deps.succeeded = true;
    await checkAndRecoverDailyExport();
    deps.succeeded = false;
    deps.running = true;
    await checkAndRecoverDailyExport();
    expect(deps.runs).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "[DailyExport] Recovery check: today's export already succeeded — nothing to do."
    );
    expect(logger.info).toHaveBeenCalledWith("[DailyExport] Recovery check: export is currently running — skipping.");

    deps.running = false;
    await checkAndRecoverDailyExport();
    expect(deps.runs).toEqual([{ id: 1, type: "scheduled" }]);
  });

  it("logs and swallows errors", async () => {
    deps.queryError = new Error("no table");
    await expect(checkAndRecoverDailyExport()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("[DailyExport] Recovery check error:", { error: "no table" });
  });
});

describe("runDailyExport", () => {
  it("records a skipped run when neither channel is enabled", async () => {
    deps.emailEnabled = false;
    deps.wa = { enabled: true, dailyAutoSend: true, dailyRecipientId: null };
    await expect(runDailyExport()).resolves.toBe(true);
    expect(deps.finishes).toEqual([
      [1, { status: "skipped", skippedReason: "Email schedule and WhatsApp daily auto-send are both disabled." }],
    ]);
  });

  it("fails when there are no companies or the archive is empty", async () => {
    deps.companies = [];
    await expect(runDailyExport()).resolves.toBe(false);
    expect(deps.finishes.at(-1)).toEqual([1, { status: "failed", skippedReason: "No companies found." }]);

    deps.companies = companies;
    deps.artifact = { attachment: Buffer.alloc(0), names: [], skipped: ["Acme"], sizeBytes: 0, dispose };
    await expect(runDailyExport()).resolves.toBe(false);
    expect(deps.finishes.at(-1)).toEqual([
      2,
      {
        status: "failed",
        companiesCount: 2,
        skippedReason: "Export ZIP is empty — no companies exported successfully.",
      },
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);

    deps.artifact = { attachment: Buffer.alloc(0), names: ["Acme.xlsx"], skipped: [], sizeBytes: 0, dispose };
    await expect(runDailyExport()).resolves.toBe(false);
    expect(deps.email).not.toHaveBeenCalled();
  });

  it("emails the archive and marks the schedule as run", async () => {
    deps.artifact = {
      attachment: Buffer.from("zip"),
      names: ["Acme.xlsx"],
      skipped: ["Beta"],
      sizeBytes: 1024,
      dispose,
    };
    await expect(runDailyExport()).resolves.toBe(true);
    expect(deps.email).toHaveBeenCalledWith(Buffer.from("zip"), "2026-10-20", ["Acme.xlsx"]);
    expect(deps.retries).toEqual([{ label: "DailyExport/Email", attempts: 3, delayMs: 120_000 }]);
    expect(deps.updates).toEqual([
      [1, { companiesCount: 2, companyFilesCount: 1, zipSizeBytes: 1024, skippedCompanies: "Beta" }],
      [1, { emailAttempted: true }],
    ]);
    expect(deps.queries).toContain("UPDATE export_settings SET last_run_at = now() WHERE id = 1");
    expect(deps.whatsapp).not.toHaveBeenCalled();
    expect(deps.finishes).toEqual([
      [
        1,
        {
          status: "success",
          emailSuccess: true,
          emailError: null,
          emailAttempts: 1,
          whatsappSuccess: false,
          whatsappError: null,
          whatsappAttempts: 0,
        },
      ],
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("retries a transient email failure but not a configuration error", async () => {
    deps.email
      .mockResolvedValueOnce({ success: false, error: "SMTP timeout" })
      .mockResolvedValueOnce({ success: true });
    await runDailyExport();
    expect(deps.email).toHaveBeenCalledTimes(2);
    expect(deps.finishes.at(-1)?.[1]).toMatchObject({ status: "success", emailAttempts: 2 });

    deps.email.mockReset().mockResolvedValue({ success: false, error: "Email not configured" });
    await expect(runDailyExport()).resolves.toBe(false);
    expect(deps.email).toHaveBeenCalledTimes(1);
    expect(deps.finishes.at(-1)?.[1]).toMatchObject({
      status: "failed",
      emailSuccess: false,
      emailError: "Email not configured",
      emailAttempts: 1,
    });
    expect(deps.queries.filter((q) => q.startsWith("UPDATE export_settings"))).toHaveLength(1);
  });

  it("sends through WhatsApp alone and reports partial delivery", async () => {
    deps.emailEnabled = false;
    deps.wa = waReady;
    await expect(runDailyExport()).resolves.toBe(true);
    expect(deps.whatsapp).toHaveBeenCalledWith(Buffer.from("zip"), "2026-10-20", companies);
    expect(deps.updates.at(-1)).toEqual([1, { whatsappAttempted: true }]);
    expect(deps.finishes.at(-1)?.[1]).toMatchObject({ status: "success", whatsappSuccess: true, whatsappAttempts: 1 });

    deps.emailEnabled = true;
    deps.whatsapp.mockResolvedValue({ sent: false, skipped: false, error: "Green API 500" });
    await expect(runDailyExport()).resolves.toBe(true);
    expect(deps.whatsapp).toHaveBeenCalledTimes(4);
    expect(deps.finishes.at(-1)?.[1]).toMatchObject({
      status: "partial_failed",
      emailSuccess: true,
      whatsappSuccess: false,
      whatsappError: "Green API 500",
      whatsappAttempts: 3,
    });
    expect(deps.retries.slice(-2)).toEqual([
      { label: "DailyExport/Email", attempts: 3, delayMs: 120_000 },
      { label: "DailyExport/WhatsApp", attempts: 3, delayMs: 120_000 },
    ]);

    deps.email.mockResolvedValue({ success: false, error: "No email recipients" });
    deps.whatsapp.mockReset().mockResolvedValue({ sent: true, skipped: false });
    await runDailyExport();
    expect(deps.finishes.at(-1)?.[1]).toMatchObject({
      status: "partial_failed",
      emailSuccess: false,
      whatsappSuccess: true,
    });
  });

  it("does not retry a skipped or misconfigured WhatsApp send", async () => {
    deps.emailEnabled = false;
    deps.wa = waReady;
    deps.whatsapp.mockResolvedValue({ sent: false, skipped: true, skipReason: "WhatsApp is disabled" });
    await expect(runDailyExport()).resolves.toBe(false);
    expect(deps.whatsapp).toHaveBeenCalledTimes(1);
    expect(deps.finishes.at(-1)?.[1]).toMatchObject({ status: "failed", whatsappError: "WhatsApp is disabled" });
    expect(logger.info).toHaveBeenCalledWith("[DailyExport] WhatsApp skipped: WhatsApp is disabled.");

    deps.whatsapp
      .mockReset()
      .mockResolvedValue({ sent: false, skipped: false, error: "ZIP is too large for WhatsApp." });
    await runDailyExport();
    expect(deps.whatsapp).toHaveBeenCalledTimes(1);
  });

  it("fails the run on an unexpected error even if recording it fails", async () => {
    deps.artifactError = new Error("disk full");
    await expect(runDailyExport()).resolves.toBe(false);
    expect(deps.finishes.at(-1)).toEqual([1, { status: "failed", skippedReason: "disk full" }]);

    deps.finishError = new Error("tracker down");
    await expect(runDailyExport()).resolves.toBe(false);
  });

  it("disposes the archive when a send throws", async () => {
    deps.emailEnabled = false;
    deps.wa = waReady;
    deps.whatsapp.mockRejectedValue(new Error("boom"));
    await expect(runDailyExport()).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(deps.finishes.at(-1)?.[1]).toMatchObject({ status: "failed", skippedReason: "boom" });
  });
});

describe("buildNetPositionZip", () => {
  it("zips one workbook per company", async () => {
    vi.useRealTimers();
    deps.excel.mockImplementation(async (companyId: number) => Buffer.from(`workbook-${companyId}`));
    const zip = await buildNetPositionZip(
      [
        { id: 1, name: "Acme & Co" },
        { id: 2, name: "Beta" },
      ],
      "2025-10-20",
      "2026-10-20"
    );
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.includes(Buffer.from("NetPosition_Acme___Co_2026-10-20.xlsx"))).toBe(true);
    expect(zip.includes(Buffer.from("NetPosition_Beta_2026-10-20.xlsx"))).toBe(true);
    expect(deps.excel).toHaveBeenCalledWith(1, "Acme & Co", "2025-10-20", "2026-10-20");
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] Added Acme & Co");
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] Added Beta");
  });

  it("finishes the archive without a company whose workbook fails", async () => {
    vi.useRealTimers();
    deps.excel.mockImplementation(async (companyId: number) => {
      if (companyId === 1) throw new Error("query timeout");
      return Buffer.from(`workbook-${companyId}`);
    });
    const zip = await buildNetPositionZip(
      [
        { id: 1, name: "Acme" },
        { id: 2, name: "Beta" },
      ],
      "2025-10-20",
      "2026-10-20"
    );
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.includes(Buffer.from("NetPosition_Acme_2026-10-20.xlsx"))).toBe(false);
    expect(zip.includes(Buffer.from("NetPosition_Beta_2026-10-20.xlsx"))).toBe(true);
    expect(logger.error).toHaveBeenCalledWith("[NetPositionExport] Failed for Acme:", { error: "query timeout" });
  });
});
