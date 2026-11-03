import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: null as unknown,
  claimRetryable: vi.fn(),
  claim: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  finalize: vi.fn(),
  log: vi.fn(),
  preparationFailure: vi.fn(),
  uncertain: vi.fn(),
  pdf: vi.fn(),
  send: vi.fn(),
  markSent: vi.fn(),
  companies: [] as Array<{ id: number; name: string }>,
  zip: vi.fn(),
  runs: [] as Array<{ id: number; type: string }>,
  updates: [] as Array<[number, Record<string, unknown>]>,
  finishes: [] as Array<[number, Record<string, unknown>]>,
  whatsapp: vi.fn(),
  retries: [] as Array<{ label: string; attempts: number; delayMs: number }>,
}));

vi.mock("../server/services/whatsappService", () => ({
  getContainersWaSettings: async () => h.settings,
  sendWhatsAppFileToChatId: (...args: unknown[]) => h.send(...args),
  markContainersWaSent: (...args: unknown[]) => h.markSent(...args),
}));
vi.mock("../server/helpers/generateContainersPdf", () => ({ generateContainersPdf: () => h.pdf() }));
vi.mock("../server/services/scheduler/scheduledWhatsAppDelivery", () => ({
  claimRetryableScheduledWhatsAppOccurrence: (...args: unknown[]) => h.claimRetryable(...args),
  claimScheduledWhatsAppOccurrence: (...args: unknown[]) => h.claim(...args),
  beginScheduledWhatsAppAttachmentAttempt: (...args: unknown[]) => h.begin(...args),
  finishScheduledWhatsAppAttachmentAttempt: (...args: unknown[]) => h.finish(...args),
  finalizeScheduledWhatsAppOccurrence: (...args: unknown[]) => h.finalize(...args),
  logScheduledWhatsAppAttachmentResult: (...args: unknown[]) => h.log(...args),
  recordScheduledWhatsAppAttachmentPreparationFailure: (...args: unknown[]) => h.preparationFailure(...args),
  recordScheduledWhatsAppAttachmentUncertain: (...args: unknown[]) => h.uncertain(...args),
}));
vi.mock("../server/services/export-data", () => ({ fetchAllCompanies: async () => h.companies }));
vi.mock("../server/helpers/buildFullExportZip", () => ({ buildFullExportZip: (...args: unknown[]) => h.zip(...args) }));
vi.mock("../server/helpers/exportRunTracker", () => ({
  createExportRun: async (type: string) => {
    const id = h.runs.length + 1;
    h.runs.push({ id, type });
    return id;
  },
  updateExportRun: async (id: number, data: Record<string, unknown>) => {
    h.updates.push([id, data]);
  },
  finishExportRun: async (id: number, data: Record<string, unknown>) => {
    h.finishes.push([id, data]);
  },
}));
vi.mock("../server/helpers/retryAsync", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/helpers/retryAsync")>();
  return {
    ...original,
    retryAsync: (options: Parameters<typeof original.retryAsync>[0]) => {
      h.retries.push({ label: options.label, attempts: options.attempts, delayMs: options.delayMs });
      return original.retryAsync({ ...options, delayMs: 0 });
    },
  };
});
vi.mock("../server/services/scheduler/daily-export", () => ({
  getTodayLabel: () => "2026-10-20",
  runDailyExport: vi.fn(),
}));
vi.mock("../server/services/scheduler/whatsapp-send", () => ({
  runDailyWhatsAppSend: (...args: unknown[]) => h.whatsapp(...args),
}));

import { checkAndRunContainersWhatsApp, triggerDailyWhatsAppSendNow } from "../server/services/scheduler/maintenance";
import { logger } from "../server/lib/logger";

const ready = {
  scheduleEnabled: true,
  groupChatId: "120@g.us",
  scheduleHour: 16,
  lastSentAt: null,
  instanceId: "1101",
  apiToken: "tok",
  enabled: true,
};
const claim = (over: Record<string, unknown> = {}) => ({
  acquired: true,
  occurrenceKey: "containers:2026-10-20:16",
  scheduledLocalDate: "2026-10-20",
  status: "claimed",
  attachments: [{ key: "pdf", status: "pending" }],
  ...over,
});
const pdf = { buffer: Buffer.from("%PDF"), rowCount: 12, pageCount: 1 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 16:30 in New York (EDT).
  vi.setSystemTime(new Date("2026-10-20T20:30:00Z"));
  h.settings = ready;
  for (const fn of [
    h.claimRetryable,
    h.claim,
    h.begin,
    h.finish,
    h.finalize,
    h.log,
    h.preparationFailure,
    h.uncertain,
    h.pdf,
    h.send,
    h.markSent,
    h.zip,
    h.whatsapp,
  ]) {
    fn.mockReset();
  }
  h.claimRetryable.mockResolvedValue(null);
  h.claim.mockResolvedValue(claim());
  h.begin.mockResolvedValue(1);
  h.pdf.mockResolvedValue(pdf);
  h.send.mockResolvedValue({ success: true, deliveryOutcome: "sent" });
  h.finalize.mockResolvedValue({ allSent: true, status: "sent" });
  h.companies = [
    { id: 1, name: "Acme" },
    { id: 2, name: "Beta" },
  ];
  h.zip.mockResolvedValue({ zip: Buffer.from("zip"), names: ["Acme.xlsx", "Beta.xlsx"], skipped: [] });
  h.whatsapp.mockResolvedValue({ sent: true, skipped: false });
  h.runs = [];
  h.updates = [];
  h.finishes = [];
  h.retries = [];
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("checkAndRunContainersWhatsApp", () => {
  it("needs a scheduled group and working credentials", async () => {
    for (const settings of [
      null,
      { ...ready, scheduleEnabled: false },
      { ...ready, groupChatId: "" },
      { ...ready, instanceId: "" },
      { ...ready, apiToken: "" },
      { ...ready, enabled: false },
    ]) {
      h.settings = settings;
      await checkAndRunContainersWhatsApp();
    }
    expect(h.claimRetryable).not.toHaveBeenCalled();
  });

  it("claims today's occurrence at the scheduled New York hour and sends the PDF", async () => {
    await checkAndRunContainersWhatsApp();
    expect(h.claimRetryable).toHaveBeenCalledWith({
      jobType: "containers_report",
      recipientKey: "group:120@g.us",
      recipientChatId: "120@g.us",
    });
    expect(h.claim).toHaveBeenCalledWith({
      jobType: "containers_report",
      recipientKey: "group:120@g.us",
      recipientChatId: "120@g.us",
      scheduledLocalDate: "2026-10-20",
      scheduledLocalHour: 16,
      attachmentKeys: ["pdf"],
    });
    expect(h.send).toHaveBeenCalledWith("120@g.us", pdf.buffer, "Containers_2026-10-20.pdf", "", "application/pdf");
    expect(h.finish).toHaveBeenCalledWith({ claim: claim(), attachmentKey: "pdf", success: true, error: undefined });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ attachment: "pdf", attempt: 1, success: true, recipient: "group:120@g.us" })
    );
    expect(logger.info).toHaveBeenCalledWith("[ContainersWA] PDF sent.", expect.objectContaining({ rowCount: 12 }));
    expect(h.markSent).toHaveBeenCalledTimes(1);
  });

  it("waits for the hour and respects a send in the last 12 hours", async () => {
    h.settings = { ...ready, scheduleHour: 9 };
    await checkAndRunContainersWhatsApp();
    h.settings = { ...ready, lastSentAt: "2026-10-20T10:00:00Z" };
    await checkAndRunContainersWhatsApp();
    expect(h.claim).not.toHaveBeenCalled();

    h.settings = { ...ready, lastSentAt: "2026-10-20T08:00:00Z" };
    await checkAndRunContainersWhatsApp();
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("resumes a retryable occurrence at any hour", async () => {
    h.settings = { ...ready, scheduleHour: 3 };
    h.claimRetryable.mockResolvedValue(claim({ scheduledLocalDate: "2026-10-19" }));
    await checkAndRunContainersWhatsApp();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith("120@g.us", pdf.buffer, "Containers_2026-10-19.pdf", "", "application/pdf");
  });

  it("does nothing for an occurrence another worker owns", async () => {
    h.claim.mockResolvedValue(claim({ acquired: false, status: "completed" }));
    await checkAndRunContainersWhatsApp();
    expect(logger.info).toHaveBeenCalledWith("[ContainersWA] Occurrence already owned or completed — skipping.", {
      occurrenceKey: "containers:2026-10-20:16",
      recipient: "group:120@g.us",
      result: "completed",
    });
    h.claim.mockResolvedValue(null);
    await checkAndRunContainersWhatsApp();
    expect(h.pdf).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it("skips an attachment already sent and only finalizes", async () => {
    h.claim.mockResolvedValue(claim({ attachments: [{ key: "pdf", status: "sent" }] }));
    await checkAndRunContainersWhatsApp();
    expect(h.pdf).not.toHaveBeenCalled();
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.markSent).toHaveBeenCalledTimes(1);
  });

  it("records a PDF that could not be generated", async () => {
    const error = new Error("render failed");
    h.pdf.mockRejectedValue(error);
    h.preparationFailure.mockResolvedValueOnce(2).mockResolvedValueOnce(null);
    h.finalize.mockResolvedValue({ allSent: false, status: "failed", error: "render failed" });
    await checkAndRunContainersWhatsApp();
    expect(h.preparationFailure).toHaveBeenCalledWith({ claim: claim(), attachmentKey: "pdf", error });
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2, success: false, error }));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[ContainersWA] Occurrence incomplete — known failures may retry; uncertain sends stay blocked.",
      {
        occurrenceKey: "containers:2026-10-20:16",
        recipient: "group:120@g.us",
        result: "failed",
        error: "render failed",
      }
    );

    h.log.mockClear();
    await checkAndRunContainersWhatsApp();
    expect(h.log).not.toHaveBeenCalled();
  });

  it("does not send when no attempt could be started", async () => {
    h.begin.mockResolvedValue(null);
    await checkAndRunContainersWhatsApp();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.finalize).toHaveBeenCalled();
  });

  it("records a thrown send as a known failure and a rejected one with its error", async () => {
    h.send.mockRejectedValueOnce(new Error("socket closed"));
    h.finalize.mockResolvedValue({ allSent: false, status: "failed" });
    await checkAndRunContainersWhatsApp();
    expect(h.finish).toHaveBeenCalledWith({
      claim: claim(),
      attachmentKey: "pdf",
      success: false,
      error: "socket closed",
    });
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: expect.any(Error) }));

    h.finish.mockClear();
    h.send.mockResolvedValueOnce({ success: false, error: "Green API 400", deliveryOutcome: "failed" });
    await checkAndRunContainersWhatsApp();
    expect(h.finish).toHaveBeenCalledWith({
      claim: claim(),
      attachmentKey: "pdf",
      success: false,
      error: "Green API 400",
    });
    expect(logger.info).not.toHaveBeenCalledWith("[ContainersWA] PDF sent.", expect.anything());
  });

  it("blocks an uncertain upload from automatic resend", async () => {
    h.send.mockResolvedValue({ success: false, error: "timeout", deliveryOutcome: "uncertain" });
    h.finalize.mockResolvedValue({ allSent: false, status: "uncertain" });
    await checkAndRunContainersWhatsApp();
    expect(h.uncertain).toHaveBeenCalledWith({ claim: claim(), attachmentKey: "pdf", error: "timeout" });
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: "timeout" }));
  });

  it("logs unexpected errors", async () => {
    h.claimRetryable.mockRejectedValue(new Error("db down"));
    await expect(checkAndRunContainersWhatsApp()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("[ContainersWA] Error:", { error: "db down" });
  });
});

describe("triggerDailyWhatsAppSendNow", () => {
  it("sends the full-history archive and records the run", async () => {
    await expect(triggerDailyWhatsAppSendNow()).resolves.toEqual({
      message: "Daily ZIP sent to WhatsApp — 2 companies (full history).",
    });
    expect(h.runs).toEqual([{ id: 1, type: "manual_whatsapp" }]);
    expect(h.zip).toHaveBeenCalledWith(h.companies, undefined, undefined);
    expect(h.updates).toEqual([
      [
        1,
        { companiesCount: 2, companyFilesCount: 2, zipSizeBytes: 3, skippedCompanies: null, whatsappAttempted: true },
      ],
    ]);
    expect(h.whatsapp).toHaveBeenCalledWith(Buffer.from("zip"), "2026-10-20", h.companies, {
      bypassAutoSendCheck: true,
    });
    expect(h.retries).toEqual([{ label: "ManualWhatsApp", attempts: 3, delayMs: 30_000 }]);
    expect(h.finishes).toEqual([[1, { status: "success", whatsappSuccess: true, whatsappAttempts: 1 }]]);
  });

  it("describes a date range and skipped companies", async () => {
    h.zip.mockResolvedValue({ zip: Buffer.from("zip"), names: ["Acme.xlsx"], skipped: ["Beta"] });
    await expect(triggerDailyWhatsAppSendNow("2026-01-01")).resolves.toEqual({
      message: "Daily ZIP sent to WhatsApp — 1 companies (2026-01-01 → today) (1 skipped).",
    });
    expect(h.updates[0][1]).toMatchObject({ skippedCompanies: "Beta" });
    await expect(triggerDailyWhatsAppSendNow(undefined, "2026-06-30")).resolves.toMatchObject({
      message: expect.stringContaining("(start → 2026-06-30)"),
    });
  });

  it("fails without companies or when the archive cannot be built", async () => {
    h.companies = [];
    await expect(triggerDailyWhatsAppSendNow()).rejects.toThrow("No companies found.");
    expect(h.finishes.at(-1)).toEqual([1, { status: "failed", skippedReason: "No companies found." }]);

    h.companies = [{ id: 1, name: "Acme" }];
    h.zip.mockRejectedValue(new Error("export crashed"));
    await expect(triggerDailyWhatsAppSendNow()).rejects.toThrow("export crashed");
    expect(h.finishes.at(-1)).toEqual([2, { status: "failed", skippedReason: "export crashed" }]);
  });

  it("explains a WhatsApp setup that is not ready, without retrying", async () => {
    h.whatsapp.mockResolvedValue({
      sent: false,
      skipped: true,
      skipReason: "No daily export WhatsApp group configured",
    });
    await expect(triggerDailyWhatsAppSendNow()).rejects.toThrow(
      "WhatsApp not configured or not ready: No daily export WhatsApp group configured. Please enable WhatsApp and select a Daily Export recipient in WhatsApp settings."
    );
    expect(h.whatsapp).toHaveBeenCalledTimes(1);
    expect(h.finishes.at(-1)?.[1]).toEqual({
      status: "failed",
      whatsappSuccess: false,
      whatsappError: "No daily export WhatsApp group configured",
      whatsappAttempts: 1,
    });
  });

  it("retries a failed send and reports the last error", async () => {
    h.whatsapp.mockResolvedValue({ sent: false, skipped: false, error: "Green API 500" });
    await expect(triggerDailyWhatsAppSendNow()).rejects.toThrow(
      "WhatsApp send failed after 3 attempt(s): Green API 500"
    );
    expect(h.whatsapp).toHaveBeenCalledTimes(3);
    expect(h.finishes.at(-1)?.[1]).toMatchObject({ whatsappError: "Green API 500", whatsappAttempts: 3 });

    h.whatsapp.mockReset().mockResolvedValue({ sent: false, skipped: false });
    await expect(triggerDailyWhatsAppSendNow()).rejects.toThrow(
      "WhatsApp send failed after 3 attempt(s): Unknown error"
    );
    expect(h.finishes.at(-1)?.[1]).toMatchObject({ whatsappError: "Unknown error" });

    h.whatsapp.mockReset().mockResolvedValue({ sent: false, skipped: false, error: "ZIP is too large for WhatsApp." });
    await expect(triggerDailyWhatsAppSendNow()).rejects.toThrow("after 1 attempt(s)");
  });
});
