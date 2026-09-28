import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  connect: vi.fn(),
  getContainersWaSettings: vi.fn(),
  sendWhatsAppFileToChatId: vi.fn(),
  markContainersWaSent: vi.fn(),
  claimRetryableScheduledWhatsAppOccurrence: vi.fn(),
  claimScheduledWhatsAppOccurrence: vi.fn(),
  beginScheduledWhatsAppAttachmentAttempt: vi.fn(),
  finishScheduledWhatsAppAttachmentAttempt: vi.fn(),
  finalizeScheduledWhatsAppOccurrence: vi.fn(),
  logScheduledWhatsAppAttachmentResult: vi.fn(),
  recordScheduledWhatsAppAttachmentPreparationFailure: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { connect: harness.connect },
}));
vi.mock("../server/services/export-data", () => ({ fetchAllCompanies: vi.fn() }));
vi.mock("../server/helpers/buildFullExportZip", () => ({ buildFullExportZip: vi.fn() }));
vi.mock("../server/helpers/retryAsync", () => ({
  retryAsync: vi.fn(),
  isWaConfigError: vi.fn(() => false),
}));
vi.mock("../server/helpers/exportRunTracker", () => ({
  createExportRun: vi.fn(),
  updateExportRun: vi.fn(),
  finishExportRun: vi.fn(),
}));
vi.mock("../server/helpers/exportAttachmentSource", () => ({ getExportAttachmentSize: vi.fn() }));
vi.mock("../server/services/scheduler/daily-export", () => ({
  getTodayLabel: vi.fn(() => "2026-09-17"),
  runDailyExport: vi.fn(),
}));
vi.mock("../server/services/scheduler/whatsapp-send", () => ({ runDailyWhatsAppSend: vi.fn() }));
vi.mock("../server/services/scheduler/scheduledWhatsAppDelivery", () => ({
  claimRetryableScheduledWhatsAppOccurrence: harness.claimRetryableScheduledWhatsAppOccurrence,
  claimScheduledWhatsAppOccurrence: harness.claimScheduledWhatsAppOccurrence,
  beginScheduledWhatsAppAttachmentAttempt: harness.beginScheduledWhatsAppAttachmentAttempt,
  finishScheduledWhatsAppAttachmentAttempt: harness.finishScheduledWhatsAppAttachmentAttempt,
  finalizeScheduledWhatsAppOccurrence: harness.finalizeScheduledWhatsAppOccurrence,
  logScheduledWhatsAppAttachmentResult: harness.logScheduledWhatsAppAttachmentResult,
  recordScheduledWhatsAppAttachmentPreparationFailure: harness.recordScheduledWhatsAppAttachmentPreparationFailure,
}));
vi.mock("../server/services/whatsappService", () => ({
  getContainersWaSettings: harness.getContainersWaSettings,
  sendWhatsAppFileToChatId: harness.sendWhatsAppFileToChatId,
  markContainersWaSent: harness.markContainersWaSent,
}));

import { checkAndRunContainersWhatsApp, purgeOldSoftDeletes } from "../server/services/scheduler/maintenance";

function healthyClient() {
  const query = vi.fn(async (statement: string) => {
    const sql = String(statement);
    if (/SELECT id FROM stock_items/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id, company_id, batch_code/i.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return { query, release: vi.fn() };
}

describe("Phase 33F maintenance scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.claimRetryableScheduledWhatsAppOccurrence.mockResolvedValue(null);
  });

  it("commits and releases a no-op 30-day purge safely", async () => {
    const client = healthyClient();
    harness.connect.mockResolvedValue(client);

    await expect(purgeOldSoftDeletes()).resolves.toBeUndefined();

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements.some((sql) => sql.includes("SAVEPOINT soft_delete_purge_unit"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases when the purge transaction cannot start", async () => {
    const client = healthyClient();
    let first = true;
    client.query.mockImplementation(async (statement: string) => {
      if (first) {
        first = false;
        throw new Error("begin failed");
      }
      return { rows: [], rowCount: 0 };
    });
    harness.connect.mockResolvedValue(client);

    await expect(purgeOldSoftDeletes()).rejects.toThrow("begin failed");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("preserves the 12-hour duplicate-suppression window for successful container sends", async () => {
    const nowInNewYork = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    harness.getContainersWaSettings.mockResolvedValue({
      scheduleEnabled: true,
      groupChatId: "120000@g.us",
      instanceId: "instance",
      apiToken: "token",
      enabled: true,
      scheduleHour: nowInNewYork.getHours(),
      lastSentAt: new Date().toISOString(),
    });

    await expect(checkAndRunContainersWhatsApp()).resolves.toBeUndefined();

    expect(harness.claimRetryableScheduledWhatsAppOccurrence).toHaveBeenCalledOnce();
    expect(harness.claimScheduledWhatsAppOccurrence).not.toHaveBeenCalled();
    expect(harness.sendWhatsAppFileToChatId).not.toHaveBeenCalled();
    expect(harness.markContainersWaSent).not.toHaveBeenCalled();
  });

  it("skips scheduled container WhatsApp work when scheduling is disabled", async () => {
    harness.getContainersWaSettings.mockResolvedValue({
      scheduleEnabled: false,
      groupChatId: "120000@g.us",
      instanceId: "instance",
      apiToken: "token",
      enabled: true,
    });

    await expect(checkAndRunContainersWhatsApp()).resolves.toBeUndefined();
    expect(harness.sendWhatsAppFileToChatId).not.toHaveBeenCalled();
    expect(harness.markContainersWaSent).not.toHaveBeenCalled();
  });
});
