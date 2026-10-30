import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stockSettings: [] as unknown[],
  npSettings: [] as unknown[],
  recipients: [] as unknown[],
  hangSettings: false,
  queries: [] as Array<{ sql: string; params?: unknown[] }>,
  companies: [] as Array<{ id: number; name: string }>,
  shouldSend: vi.fn(),
  claimRetryable: vi.fn(),
  claim: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  finalize: vi.fn(),
  log: vi.fn(),
  preparationFailure: vi.fn(),
  uncertain: vi.fn(),
  pdf: vi.fn(),
  excel: vi.fn(),
  send: vi.fn(),
  release: vi.fn(),
  zip: vi.fn(),
  email: vi.fn(),
  wa: null as unknown,
}));

vi.mock("../server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/db")>()),
  pool: {
    query: (sql: string, params?: unknown[]) => {
      h.queries.push({ sql, params });
      if (sql.includes("FROM whatsapp_stock_settings")) {
        return h.hangSettings ? new Promise(() => undefined) : Promise.resolve({ rows: h.stockSettings });
      }
      if (sql.includes("FROM net_position_export_settings")) return Promise.resolve({ rows: h.npSettings });
      if (sql.includes("FROM whatsapp_recipients")) return Promise.resolve({ rows: h.recipients });
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  },
}));
vi.mock("../server/storage", () => ({ storage: { getAllCompanies: async () => h.companies } }));
vi.mock("../server/services/scheduler/whatsapp-send", () => ({
  shouldSendStockReport: (...args: unknown[]) => h.shouldSend(...args),
}));
vi.mock("../server/services/scheduler/daily-export", () => ({
  buildNetPositionZip: (...args: unknown[]) => h.zip(...args),
  getTodayLabel: () => "2026-10-20",
}));
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
vi.mock("../server/helpers/generateStockPdf", () => ({ generateStockPdf: (...args: unknown[]) => h.pdf(...args) }));
vi.mock("../server/helpers/generateNetPositionExcel", () => ({
  generateNetPositionExcel: (...args: unknown[]) => h.excel(...args),
}));
vi.mock("../server/helpers/exportAttachmentSource", () => ({
  releaseManagedExportAttachment: (...args: unknown[]) => h.release(...args),
}));
vi.mock("../server/services/whatsappService", () => ({
  getWaSettings: async () => h.wa,
  sendWhatsAppFileToChatId: (...args: unknown[]) => h.send(...args),
}));
vi.mock("../server/services/emailService", () => ({ sendExportEmail: (...args: unknown[]) => h.email(...args) }));

import { checkAndRunNetPositionExport, checkAndRunStockReport } from "../server/services/scheduler/stock-report";
import { logger } from "../server/lib/logger";

const settings = {
  company_id: 3,
  recipient_id: 8,
  auto_send: true,
  enabled: true,
  frequency: null,
  send_hour: null,
  send_day_of_week: null,
  last_sent_at: null,
};
const claim = (
  attachments = [
    { key: "pdf", status: "pending" },
    { key: "excel", status: "pending" },
  ]
) => ({
  acquired: true,
  occurrenceKey: "stock_report:company-3:r:2026-10-20:18",
  scheduledLocalDate: "2026-10-20",
  scheduledLocalHour: 18,
  status: "claimed",
  attachments,
});
const pdfBuffer = Buffer.from("%PDF");
const xlsBuffer = Buffer.from("PK");
const recipientKey = "recipient:8:chat:120@g.us";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-21T02:30:00Z")); // 22:30 on the 20th in New York
  h.stockSettings = [settings];
  h.npSettings = [];
  h.recipients = [{ chat_id: "120@g.us" }];
  h.hangSettings = false;
  h.queries = [];
  h.companies = [
    { id: 3, name: "Acme & Co" },
    { id: 4, name: "Beta" },
  ];
  h.wa = { enabled: true };
  for (const fn of [
    h.shouldSend,
    h.claimRetryable,
    h.claim,
    h.begin,
    h.finish,
    h.finalize,
    h.log,
    h.preparationFailure,
    h.uncertain,
    h.pdf,
    h.excel,
    h.send,
    h.release,
    h.zip,
    h.email,
  ]) {
    fn.mockReset();
  }
  h.shouldSend.mockReturnValue(true);
  h.claimRetryable.mockResolvedValue(null);
  h.claim.mockResolvedValue(claim());
  h.begin.mockResolvedValue(1);
  h.pdf.mockResolvedValue({ buffer: pdfBuffer, rowCount: 40, pageCount: 3 });
  h.excel.mockResolvedValue(xlsBuffer);
  h.send.mockResolvedValue({ success: true, deliveryOutcome: "sent" });
  h.finalize.mockResolvedValue({ allSent: true, status: "sent", error: null });
  h.preparationFailure.mockResolvedValue(1);
  h.zip.mockResolvedValue(Buffer.from("zip"));
  h.email.mockResolvedValue({ success: true });
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const updates = () => h.queries.filter((q) => q.sql.startsWith("UPDATE")).map((q) => q.sql);

describe("checkAndRunStockReport", () => {
  it("needs enabled, auto-sending settings with a company, recipient and live chat", async () => {
    for (const rows of [
      [],
      [{ ...settings, enabled: false }],
      [{ ...settings, auto_send: false }],
      [{ ...settings, company_id: null }],
      [{ ...settings, recipient_id: null }],
    ]) {
      h.stockSettings = rows;
      await checkAndRunStockReport();
    }
    expect(h.queries.filter((q) => q.sql.includes("whatsapp_recipients"))).toEqual([]);

    h.stockSettings = [settings];
    h.recipients = [];
    await checkAndRunStockReport();
    expect(logger.info).toHaveBeenCalledWith("[StockReport] Recipient inactive — skipping.");
    h.recipients = [{ chat_id: "120@g.us" }];
    h.companies = [{ id: 4, name: "Beta" }];
    await checkAndRunStockReport();
    expect(logger.info).toHaveBeenCalledWith("[StockReport] Company 3 not found.");
    expect(h.claimRetryable).not.toHaveBeenCalled();
  });

  it("sends the stock PDF and net-position workbook for today's occurrence", async () => {
    await checkAndRunStockReport();
    expect(h.shouldSend).toHaveBeenCalledWith({
      frequency: "daily",
      sendHour: 18,
      sendDayOfWeek: null,
      lastSentAt: null,
    });
    expect(h.claimRetryable).toHaveBeenCalledWith({
      jobType: "stock_report",
      companyId: 3,
      recipientKey,
      recipientChatId: "120@g.us",
    });
    expect(h.claim).toHaveBeenCalledWith({
      jobType: "stock_report",
      companyId: 3,
      recipientKey,
      recipientChatId: "120@g.us",
      scheduledLocalDate: "2026-10-20",
      scheduledLocalHour: 18,
      attachmentKeys: ["pdf", "excel"],
    });
    expect(h.pdf).toHaveBeenCalledWith(3, "Acme & Co", undefined, undefined, true);
    expect(h.excel).toHaveBeenCalledWith(3, "Acme & Co", "2026-01-01", "2026-10-20");
    expect(h.send.mock.calls).toEqual([
      ["120@g.us", pdfBuffer, "Stock_Acme___Co_2026-10-20.pdf", "", "application/pdf"],
      [
        "120@g.us",
        xlsBuffer,
        "NetPosition_Acme___Co_2026-10-20.xlsx",
        "",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    ]);
    expect(h.finish.mock.calls.map(([input]) => [input.attachmentKey, input.success])).toEqual([
      ["pdf", true],
      ["excel", true],
    ]);
    expect(h.release.mock.calls).toEqual([[pdfBuffer], [xlsBuffer]]);
    expect(updates()).toEqual(["UPDATE whatsapp_stock_settings SET last_sent_at = now() WHERE id = 1"]);
  });

  it("passes stored schedule settings through and stops when it is not time", async () => {
    h.stockSettings = [
      { ...settings, frequency: "weekly", send_hour: 7, send_day_of_week: 2, last_sent_at: "2026-10-13T11:00:00Z" },
    ];
    h.shouldSend.mockReturnValue(false);
    await checkAndRunStockReport();
    expect(h.shouldSend).toHaveBeenCalledWith({
      frequency: "weekly",
      sendHour: 7,
      sendDayOfWeek: 2,
      lastSentAt: new Date("2026-10-13T11:00:00Z"),
    });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("resumes a retryable occurrence and skips what was already sent", async () => {
    h.claimRetryable.mockResolvedValue({
      ...claim([
        { key: "pdf", status: "sent" },
        { key: "excel", status: "failed" },
      ]),
      scheduledLocalDate: "2025-12-31",
    });
    h.shouldSend.mockReturnValue(false);
    await checkAndRunStockReport();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.pdf).not.toHaveBeenCalled();
    expect(h.excel).toHaveBeenCalledWith(3, "Acme & Co", "2025-01-01", "2025-12-31");

    h.excel.mockClear();
    h.claimRetryable.mockResolvedValue(
      claim([
        { key: "pdf", status: "failed" },
        { key: "excel", status: "sent" },
      ])
    );
    await checkAndRunStockReport();
    expect(h.pdf).toHaveBeenCalledTimes(1);
    expect(h.excel).not.toHaveBeenCalled();
  });

  it("does nothing for an occurrence another worker owns", async () => {
    h.claim.mockResolvedValue({ ...claim(), acquired: false, status: "sent" });
    await checkAndRunStockReport();
    expect(logger.info).toHaveBeenCalledWith("[StockReport] Occurrence already owned or completed — skipping.", {
      occurrenceKey: claim().occurrenceKey,
      recipient: recipientKey,
      result: "sent",
    });
    h.claim.mockResolvedValue(null);
    await checkAndRunStockReport();
    expect(h.pdf).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it("records attachments that could not be prepared", async () => {
    const error = new Error("render failed");
    h.pdf.mockRejectedValue(error);
    h.excel.mockRejectedValue(new Error("no data"));
    h.preparationFailure.mockResolvedValueOnce(2).mockResolvedValueOnce(null);
    h.finalize.mockResolvedValue({ allSent: false, status: "failed", error: "no data" });
    await checkAndRunStockReport();
    expect(h.preparationFailure.mock.calls.map(([input]) => input.attachmentKey)).toEqual(["pdf", "excel"]);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ attachment: "pdf", attempt: 2, success: false, error })
    );
    expect(h.send).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[StockReport] Occurrence incomplete — known failures remain retryable; uncertain sends stay blocked.",
      { occurrenceKey: claim().occurrenceKey, recipient: recipientKey, result: "failed", error: "no data" }
    );
  });

  it("rejects a PDF with far more pages than its rows need", async () => {
    // 40 rows allow ceil(40 / 20) + 5 = 7 pages.
    h.pdf.mockResolvedValue({ buffer: pdfBuffer, rowCount: 40, pageCount: 8 });
    h.preparationFailure.mockResolvedValueOnce(1);
    await checkAndRunStockReport();
    expect(h.preparationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentKey: "pdf", error: "PDF safety guard rejected 8 pages for 40 rows" })
    );
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ attachment: "pdf", error: "PDF safety guard rejected 8 pages for 40 rows" })
    );
    expect(h.send.mock.calls.map((call) => call[2])).toEqual(["NetPosition_Acme___Co_2026-10-20.xlsx"]);
    expect(h.release).toHaveBeenCalledWith(pdfBuffer);

    h.send.mockClear();
    h.pdf.mockResolvedValue({ buffer: pdfBuffer, rowCount: 40, pageCount: 7 });
    await checkAndRunStockReport();
    expect(h.send).toHaveBeenCalledTimes(2);

    h.send.mockClear();
    h.log.mockClear();
    h.preparationFailure.mockResolvedValueOnce(null);
    h.pdf.mockResolvedValue({ buffer: pdfBuffer, rowCount: 0, pageCount: 6 });
    await checkAndRunStockReport();
    expect(h.log).not.toHaveBeenCalledWith(expect.objectContaining({ attachment: "pdf" }));
  });

  it("does not send when an attempt cannot be started", async () => {
    h.begin.mockResolvedValue(null);
    await checkAndRunStockReport();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.release.mock.calls).toEqual([[pdfBuffer], [xlsBuffer]]);
  });

  it("records thrown sends as failures and uncertain uploads as blocked", async () => {
    h.send.mockRejectedValueOnce(new Error("pdf socket")).mockRejectedValueOnce(new Error("xls socket"));
    h.finalize.mockResolvedValue({ allSent: false, status: "failed", error: "xls socket" });
    await checkAndRunStockReport();
    expect(h.finish.mock.calls.map(([input]) => [input.attachmentKey, input.success, input.error])).toEqual([
      ["pdf", false, "pdf socket"],
      ["excel", false, "xls socket"],
    ]);
    expect(h.log).toHaveBeenCalledTimes(2);

    h.finish.mockClear();
    h.send.mockResolvedValue({ success: false, error: "timeout", deliveryOutcome: "uncertain" });
    await checkAndRunStockReport();
    expect(h.uncertain.mock.calls.map(([input]) => [input.attachmentKey, input.error])).toEqual([
      ["pdf", "timeout"],
      ["excel", "timeout"],
    ]);
    expect(h.finish).not.toHaveBeenCalled();

    h.send.mockResolvedValue({ success: false, error: "Green API 400", deliveryOutcome: "failed" });
    await checkAndRunStockReport();
    expect(h.finish.mock.calls.map(([input]) => [input.attachmentKey, input.success, input.error])).toEqual([
      ["pdf", false, "Green API 400"],
      ["excel", false, "Green API 400"],
    ]);
  });

  it("gives up on a settings read that hangs", async () => {
    h.hangSettings = true;
    const run = checkAndRunStockReport();
    await vi.advanceTimersByTimeAsync(20_000);
    await run;
    expect(logger.error).toHaveBeenCalledWith("[StockReport] Error:", {
      error: "StockReport settings read timed out after 20000ms",
    });
  });

  it("logs unexpected errors", async () => {
    h.claimRetryable.mockRejectedValue(new Error("db down"));
    await checkAndRunStockReport();
    expect(logger.error).toHaveBeenCalledWith("[StockReport] Error:", { error: "db down" });
  });
});

describe("checkAndRunNetPositionExport", () => {
  const np = {
    recipient_id: 5,
    frequency: null,
    send_hour: null,
    send_day_of_week: null,
    enabled: true,
    auto_send: true,
    last_sent_at: null,
  };

  beforeEach(() => {
    h.npSettings = [np];
  });

  it("needs enabled, auto-sending settings and a due schedule", async () => {
    for (const rows of [[], [{ ...np, enabled: false }], [{ ...np, auto_send: false }]]) {
      h.npSettings = rows;
      await checkAndRunNetPositionExport();
    }
    h.npSettings = [
      { ...np, frequency: "monthly", send_hour: 6, send_day_of_week: 1, last_sent_at: "2026-09-01T10:00:00Z" },
    ];
    h.shouldSend.mockReturnValue(false);
    await checkAndRunNetPositionExport();
    expect(h.shouldSend).toHaveBeenCalledWith({
      frequency: "monthly",
      sendHour: 6,
      sendDayOfWeek: 1,
      lastSentAt: new Date("2026-09-01T10:00:00Z"),
    });
    expect(h.zip).not.toHaveBeenCalled();

    h.shouldSend.mockReturnValue(true);
    h.companies = [];
    await checkAndRunNetPositionExport();
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] No companies found — skipping.");
    expect(h.zip).not.toHaveBeenCalled();
  });

  it("sends the year-to-date ZIP by WhatsApp and email, then marks it sent", async () => {
    await checkAndRunNetPositionExport();
    expect(h.shouldSend).toHaveBeenCalledWith({
      frequency: "daily",
      sendHour: 18,
      sendDayOfWeek: null,
      lastSentAt: null,
    });
    expect(h.zip).toHaveBeenCalledWith(h.companies, "2026-01-01", "2026-10-20");
    expect(h.send).toHaveBeenCalledWith(
      "120@g.us",
      Buffer.from("zip"),
      "NetPosition_AllCompanies_2026-10-20.zip",
      "",
      "application/zip"
    );
    expect(h.email).toHaveBeenCalledWith(Buffer.from("zip"), "2026-10-20", ["Acme & Co", "Beta"]);
    expect(updates()).toEqual(["UPDATE net_position_export_settings SET last_sent_at = now() WHERE id = 1"]);
    expect(h.release).toHaveBeenCalledWith(Buffer.from("zip"));
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] WhatsApp: sent");
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] Email: sent");
  });

  it("still emails when WhatsApp is off, inactive or unset", async () => {
    h.wa = { enabled: false };
    await checkAndRunNetPositionExport();
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] WhatsApp not enabled — skipping WhatsApp send.");
    h.recipients = [];
    await checkAndRunNetPositionExport();
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] Recipient id=5 inactive — skipping WhatsApp.");
    h.npSettings = [{ ...np, recipient_id: null }];
    await checkAndRunNetPositionExport();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.email).toHaveBeenCalledTimes(3);
  });

  it("logs delivery errors and releases the ZIP even when a send throws", async () => {
    h.send.mockResolvedValue({ success: false, error: "Green API 500" });
    h.email.mockResolvedValue({ success: false, error: "SMTP down" });
    await checkAndRunNetPositionExport();
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] WhatsApp: Green API 500");
    expect(logger.info).toHaveBeenCalledWith("[NetPositionExport] Email: SMTP down");

    h.release.mockClear();
    h.email.mockRejectedValue(new Error("mailer crashed"));
    await checkAndRunNetPositionExport();
    expect(h.release).toHaveBeenCalledWith(Buffer.from("zip"));
    expect(logger.error).toHaveBeenCalledWith("[NetPositionExport] Error:", { error: "mailer crashed" });
    expect(updates()).toHaveLength(1);
  });
});
