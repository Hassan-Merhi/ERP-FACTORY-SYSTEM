import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  isScheduleEnabled: vi.fn(),
  getWaSettings: vi.fn(),
  fetchAllCompanies: vi.fn(),
  createExportRun: vi.fn(),
  updateExportRun: vi.fn(),
  finishExportRun: vi.fn(),
  createScheduledExportArtifact: vi.fn(),
  sendExportEmail: vi.fn(),
  runDailyWhatsAppSend: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { query: harness.poolQuery },
}));
vi.mock("../server/services/export-data", () => ({
  fetchAllCompanies: harness.fetchAllCompanies,
}));
vi.mock("../server/services/emailService", () => ({
  sendExportEmail: harness.sendExportEmail,
}));
vi.mock("../server/services/whatsappService", () => ({
  getWaSettings: harness.getWaSettings,
}));
vi.mock("../server/helpers/exportRunTracker", () => ({
  createExportRun: harness.createExportRun,
  updateExportRun: harness.updateExportRun,
  finishExportRun: harness.finishExportRun,
}));
vi.mock("../server/helpers/scheduledExportArtifact", () => ({
  createScheduledExportArtifact: harness.createScheduledExportArtifact,
}));
vi.mock("../server/services/scheduler/net-position", () => ({
  isScheduleEnabled: harness.isScheduleEnabled,
}));
vi.mock("../server/services/scheduler/whatsapp-send", () => ({
  runDailyWhatsAppSend: harness.runDailyWhatsAppSend,
}));
vi.mock("../server/services/security/databaseScopeRuntimeContext", () => ({
  runWithDatabaseMaintenanceScope: async (_label: string, fn: () => unknown) => fn(),
}));

import {
  checkAndRecoverDailyExport,
  getTodayLabel,
  hasTodayExportSucceeded,
  isTodayExportRunning,
  runDailyExport,
} from "../server/services/scheduler/daily-export";

describe("Phase 33F scheduler daily-export behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    harness.isScheduleEnabled.mockResolvedValue(false);
    harness.getWaSettings.mockResolvedValue(null);
    harness.fetchAllCompanies.mockResolvedValue([]);
    harness.createExportRun.mockResolvedValue(101);
    harness.updateExportRun.mockResolvedValue(undefined);
    harness.finishExportRun.mockResolvedValue(undefined);
  });

  it("produces a stable YYYY-MM-DD scheduler label", () => {
    expect(getTodayLabel()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("treats successful/running lookup failures as false instead of crashing the scheduler", async () => {
    harness.poolQuery.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(hasTodayExportSucceeded()).resolves.toBe(false);

    harness.poolQuery.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(isTodayExportRunning()).resolves.toBe(false);
  });

  it("recognizes completed and running scheduled export rows", async () => {
    harness.poolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await expect(hasTodayExportSucceeded()).resolves.toBe(true);

    harness.poolQuery.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 });
    await expect(isTodayExportRunning()).resolves.toBe(true);
  });

  it("records a skipped run when both email and WhatsApp delivery are disabled", async () => {
    harness.isScheduleEnabled.mockResolvedValue(false);
    harness.getWaSettings.mockResolvedValue({ enabled: false, dailyAutoSend: false, dailyRecipientId: null });

    await expect(runDailyExport()).resolves.toBe(true);
    expect(harness.createExportRun).toHaveBeenCalledWith("scheduled");
    expect(harness.finishExportRun).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ status: "skipped" })
    );
    expect(harness.fetchAllCompanies).not.toHaveBeenCalled();
  });

  it("fails cleanly when delivery is enabled but no companies exist", async () => {
    harness.isScheduleEnabled.mockResolvedValue(true);
    harness.getWaSettings.mockResolvedValue(null);
    harness.fetchAllCompanies.mockResolvedValue([]);

    await expect(runDailyExport()).resolves.toBe(false);
    expect(harness.finishExportRun).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ status: "failed", skippedReason: "No companies found." })
    );
  });

  it("does not recover a scheduled export while the schedule is disabled", async () => {
    harness.poolQuery.mockResolvedValueOnce({
      rows: [{ schedule_enabled: false, schedule_hour: 18, schedule_timezone: "Africa/Lubumbashi" }],
      rowCount: 1,
    });

    await expect(checkAndRecoverDailyExport()).resolves.toBeUndefined();
    expect(harness.isScheduleEnabled).not.toHaveBeenCalled();
    expect(harness.createExportRun).not.toHaveBeenCalled();
  });
});
