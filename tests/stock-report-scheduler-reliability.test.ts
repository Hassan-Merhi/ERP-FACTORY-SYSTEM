import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  query: vi.fn(),
  sendWhatsAppFileToChatId: vi.fn(),
  generateStockPdf: vi.fn(),
  generateNetPositionExcel: vi.fn(),
  releaseManagedExportAttachment: vi.fn(),
  getAllCompanies: vi.fn(),
  shouldSendStockReport: vi.fn(),
  claimRetryableScheduledWhatsAppOccurrence: vi.fn(),
  claimScheduledWhatsAppOccurrence: vi.fn(),
  beginScheduledWhatsAppAttachmentAttempt: vi.fn(),
  finishScheduledWhatsAppAttachmentAttempt: vi.fn(),
  finalizeScheduledWhatsAppOccurrence: vi.fn(),
  logScheduledWhatsAppAttachmentResult: vi.fn(),
  recordScheduledWhatsAppAttachmentPreparationFailure: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { query: harness.query },
}));

vi.mock("../server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../server/services/emailService", () => ({
  sendExportEmail: vi.fn(),
}));

vi.mock("../server/services/whatsappService", () => ({
  getWaSettings: vi.fn(),
  sendWhatsAppFileToChatId: harness.sendWhatsAppFileToChatId,
}));

vi.mock("../server/helpers/generateNetPositionExcel", () => ({
  generateNetPositionExcel: harness.generateNetPositionExcel,
}));

vi.mock("../server/helpers/generateStockPdf", () => ({
  generateStockPdf: harness.generateStockPdf,
}));

vi.mock("../server/helpers/exportAttachmentSource", () => ({
  getExportAttachmentSize: vi.fn(() => 128),
  releaseManagedExportAttachment: harness.releaseManagedExportAttachment,
}));

vi.mock("../server/storage", () => ({
  storage: { getAllCompanies: harness.getAllCompanies },
}));

vi.mock("../server/services/scheduler/daily-export", () => ({
  buildNetPositionZip: vi.fn(),
  getTodayLabel: vi.fn(() => "2026-09-28"),
}));

vi.mock("../server/services/scheduler/whatsapp-send", () => ({
  shouldSendStockReport: harness.shouldSendStockReport,
}));

vi.mock("../server/services/scheduler/scheduledWhatsAppDelivery", () => ({
  claimRetryableScheduledWhatsAppOccurrence: harness.claimRetryableScheduledWhatsAppOccurrence,
  claimScheduledWhatsAppOccurrence: harness.claimScheduledWhatsAppOccurrence,
  beginScheduledWhatsAppAttachmentAttempt: harness.beginScheduledWhatsAppAttachmentAttempt,
  finishScheduledWhatsAppAttachmentAttempt: harness.finishScheduledWhatsAppAttachmentAttempt,
  finalizeScheduledWhatsAppOccurrence: harness.finalizeScheduledWhatsAppOccurrence,
  logScheduledWhatsAppAttachmentResult: harness.logScheduledWhatsAppAttachmentResult,
  recordScheduledWhatsAppAttachmentPreparationFailure: harness.recordScheduledWhatsAppAttachmentPreparationFailure,
}));

import { checkAndRunStockReport } from "../server/services/scheduler/stock-report";

type AttachmentStatus = "pending" | "sending" | "failed" | "sent";

function claim(
  attachments: Array<{ key: string; status: AttachmentStatus; attemptCount?: number; lastError?: string | null }>
) {
  return {
    id: 44,
    occurrenceKey: "stock_report:company-7:recipient:9:chat:120000@g.us:2026-09-28:18",
    acquired: true,
    status: "claimed" as const,
    recipientChatId: "120000@g.us",
    scheduledLocalDate: "2026-09-28",
    scheduledLocalHour: 18,
    claimToken: "claim-token",
    attachments: attachments.map((attachment) => ({
      key: attachment.key,
      status: attachment.status,
      attemptCount: attachment.attemptCount ?? 0,
      lastError: attachment.lastError ?? null,
      sentAt: attachment.status === "sent" ? new Date("2026-09-28T18:00:00Z") : null,
    })),
  };
}

function lastSentUpdateCalls() {
  return harness.query.mock.calls.filter(([sql]) =>
    String(sql).includes("UPDATE whatsapp_stock_settings SET last_sent_at = now()")
  );
}

describe("scheduled stock WhatsApp reliability", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    harness.query.mockImplementation(async (statement: string) => {
      const sql = String(statement);
      if (sql.includes("FROM whatsapp_stock_settings")) {
        return {
          rows: [
            {
              company_id: 7,
              recipient_id: 9,
              auto_send: true,
              enabled: true,
              frequency: "daily",
              send_hour: 18,
              send_day_of_week: null,
              last_sent_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM whatsapp_recipients")) {
        return { rows: [{ chat_id: "120000@g.us" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    harness.getAllCompanies.mockResolvedValue([{ id: 7, name: "Acme" }]);
    harness.shouldSendStockReport.mockReturnValue(true);
    harness.claimRetryableScheduledWhatsAppOccurrence.mockResolvedValue(null);
    harness.claimScheduledWhatsAppOccurrence.mockResolvedValue(
      claim([
        { key: "pdf", status: "pending" },
        { key: "excel", status: "pending" },
      ])
    );
    harness.beginScheduledWhatsAppAttachmentAttempt.mockResolvedValue(1);
    harness.finishScheduledWhatsAppAttachmentAttempt.mockResolvedValue(undefined);
    harness.logScheduledWhatsAppAttachmentResult.mockResolvedValue(undefined);
    harness.recordScheduledWhatsAppAttachmentPreparationFailure.mockResolvedValue(1);
    harness.releaseManagedExportAttachment.mockResolvedValue(undefined);
    harness.generateStockPdf.mockResolvedValue({
      buffer: Buffer.from("pdf"),
      pageCount: 1,
      rowCount: 1,
    });
    harness.generateNetPositionExcel.mockResolvedValue(Buffer.from("xlsx"));
  });

  it("updates last_sent_at only after both PDF and Excel succeed", async () => {
    harness.sendWhatsAppFileToChatId.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: true });
    harness.finalizeScheduledWhatsAppOccurrence.mockResolvedValue({
      allSent: true,
      status: "sent",
      error: null,
    });

    await checkAndRunStockReport();

    expect(harness.sendWhatsAppFileToChatId).toHaveBeenCalledTimes(2);
    expect(lastSentUpdateCalls()).toHaveLength(1);
  });

  it("does not update last_sent_at when PDF delivery fails", async () => {
    harness.sendWhatsAppFileToChatId
      .mockResolvedValueOnce({ success: false, error: "pdf failed" })
      .mockResolvedValueOnce({ success: true });
    harness.finalizeScheduledWhatsAppOccurrence.mockResolvedValue({
      allSent: false,
      status: "partial",
      error: "pdf failed",
    });

    await checkAndRunStockReport();

    expect(lastSentUpdateCalls()).toHaveLength(0);
    expect(harness.finishScheduledWhatsAppAttachmentAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentKey: "pdf", success: false, error: "pdf failed" })
    );
  });

  it("does not update last_sent_at when Excel delivery fails", async () => {
    harness.sendWhatsAppFileToChatId
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "excel failed" });
    harness.finalizeScheduledWhatsAppOccurrence.mockResolvedValue({
      allSent: false,
      status: "partial",
      error: "excel failed",
    });

    await checkAndRunStockReport();

    expect(lastSentUpdateCalls()).toHaveLength(0);
    expect(harness.finishScheduledWhatsAppAttachmentAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentKey: "excel", success: false, error: "excel failed" })
    );
  });

  it("retries only Excel after PDF already succeeded", async () => {
    harness.claimRetryableScheduledWhatsAppOccurrence.mockResolvedValue(
      claim([
        { key: "pdf", status: "sent", attemptCount: 1 },
        { key: "excel", status: "failed", attemptCount: 1, lastError: "excel failed" },
      ])
    );
    harness.sendWhatsAppFileToChatId.mockResolvedValueOnce({ success: true });
    harness.finalizeScheduledWhatsAppOccurrence.mockResolvedValue({
      allSent: true,
      status: "sent",
      error: null,
    });

    await checkAndRunStockReport();

    expect(harness.claimScheduledWhatsAppOccurrence).not.toHaveBeenCalled();
    expect(harness.generateStockPdf).not.toHaveBeenCalled();
    expect(harness.generateNetPositionExcel).toHaveBeenCalledOnce();
    expect(harness.sendWhatsAppFileToChatId).toHaveBeenCalledOnce();
    expect(harness.beginScheduledWhatsAppAttachmentAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceKey: expect.any(String) }),
      "excel"
    );
    expect(lastSentUpdateCalls()).toHaveLength(1);
  });
});
