/**
 * Two scheduled WhatsApp jobs and the daily-export WhatsApp step:
 *
 * - runMonthlyWhatsAppNetPosition sends each company's net-position workbook
 *   for the last year, only when monthly auto-send is on and someone receives it,
 *   and one company's failure never stops the others.
 * - checkOverdueCustomers sends one reminder listing every customer whose
 *   oldest unpaid invoice is past its payment terms.
 * - runDailyWhatsAppSend sends the daily export ZIP to the configured group,
 *   refusing a ZIP above WhatsApp's attachment limit.
 * - shouldSendStockReport decides whether the stock report is due.
 */
const deps = vi.hoisted(() => ({
  settings: vi.fn(),
  recipients: vi.fn(),
  sendFile: vi.fn(),
  sendText: vi.fn(),
  sendFileToChat: vi.fn(),
  excel: vi.fn(),
  companies: vi.fn(),
  overdue: vi.fn(),
  size: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../server/services/whatsappService", () => ({
  getWaSettings: deps.settings,
  getActiveRecipients: deps.recipients,
  sendWhatsAppFile: deps.sendFile,
  sendWhatsAppText: deps.sendText,
  sendWhatsAppFileToChatId: deps.sendFileToChat,
}));
vi.mock("../server/helpers/generateNetPositionExcel", () => ({ generateNetPositionExcel: deps.excel }));
vi.mock("../server/storage", () => ({ storage: { getAllCompanies: deps.companies } }));
vi.mock("../server/services/scheduler/daily-export", () => ({
  getTodayLabel: () => "2026-10-21",
  WHATSAPP_ATTACHMENT_LIMIT_MB: 64,
}));
vi.mock("../server/services/scheduler/overdueCustomerQuery", () => ({ loadOverdueCustomerBalances: deps.overdue }));
vi.mock("../server/helpers/exportAttachmentSource", () => ({ getExportAttachmentSize: deps.size }));
vi.mock("../server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/db")>()),
  pool: { query: (...args: unknown[]) => deps.query(...args) },
}));

import { logger } from "../server/lib/logger";
import {
  checkOverdueCustomers,
  isScheduleEnabled,
  runMonthlyWhatsAppNetPosition,
} from "../server/services/scheduler/net-position";
import { runDailyWhatsAppSend, shouldSendStockReport } from "../server/services/scheduler/whatsapp-send";

beforeEach(() => {
  for (const fn of Object.values(deps)) fn.mockReset();
  vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
});
afterEach(() => vi.useRealTimers());

describe("export schedule flag", () => {
  it("is on only when the settings row says so, and off when it cannot be read", async () => {
    deps.query.mockResolvedValueOnce({ rows: [{ schedule_enabled: true }] });
    expect(await isScheduleEnabled()).toBe(true);
    deps.query.mockResolvedValueOnce({ rows: [{ schedule_enabled: "yes" }] });
    expect(await isScheduleEnabled()).toBe(false);
    deps.query.mockResolvedValueOnce({ rows: [] });
    expect(await isScheduleEnabled()).toBe(false);
    deps.query.mockRejectedValueOnce(new Error("db down"));
    expect(await isScheduleEnabled()).toBe(false);
  });
});

describe("monthly net-position send", () => {
  it("sends each company's last-year workbook and carries on past a failure", async () => {
    deps.settings.mockResolvedValue({ enabled: true, monthlyAutoSend: true });
    deps.recipients.mockResolvedValue([{ id: 1 }]);
    deps.companies.mockResolvedValue([
      { id: 1, name: "Acme Ltd." },
      { id: 2, name: "Broken" },
      { id: 3, name: "Zed & Co" },
    ]);
    deps.excel.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error("no data");
      return Buffer.from(`xlsx-${id}`);
    });
    deps.sendFile.mockResolvedValue({ sent: 1, failed: 0 });

    await runMonthlyWhatsAppNetPosition();

    expect(deps.excel).toHaveBeenCalledWith(1, "Acme Ltd.", "2025-10-21", "2026-10-21");
    expect(deps.sendFile.mock.calls.map(([, name]) => name)).toEqual([
      "NetPosition_Acme_Ltd__2026-10-21.xlsx",
      "NetPosition_Zed___Co_2026-10-21.xlsx",
    ]);
    expect(logger.error).toHaveBeenCalledWith("[WhatsApp] Failed for Broken:", { error: "no data" });
  });

  it.each([
    ["WhatsApp is off", { enabled: false, monthlyAutoSend: true }, [{ id: 1 }]],
    ["monthly auto-send is off", { enabled: true, monthlyAutoSend: false }, [{ id: 1 }]],
    ["nobody receives it", { enabled: true, monthlyAutoSend: true }, []],
  ])("sends nothing when %s", async (_label, settings, recipients) => {
    deps.settings.mockResolvedValue(settings);
    deps.recipients.mockResolvedValue(recipients);

    await runMonthlyWhatsAppNetPosition();

    expect(deps.companies).not.toHaveBeenCalled();
    expect(deps.sendFile).not.toHaveBeenCalled();
  });

  it("logs instead of throwing when the settings cannot be read", async () => {
    deps.settings.mockRejectedValue(new Error("db down"));

    await expect(runMonthlyWhatsAppNetPosition()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("[WhatsApp] Monthly send error:", expect.anything());
  });
});

describe("overdue customer reminder", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 21, 12));
    deps.settings.mockResolvedValue({ enabled: true });
  });

  it("lists every customer past their payment terms in one message", async () => {
    deps.overdue.mockResolvedValue([
      {
        legal_name: "Late Co",
        net_balance: "1234.5",
        payment_terms_days: 30,
        earliest_invoice_date: new Date(2026, 8, 1),
      },
      {
        legal_name: "Today Co",
        net_balance: "10",
        payment_terms_days: 20,
        earliest_invoice_date: new Date(2026, 9, 1),
      },
      {
        legal_name: "Early Co",
        net_balance: "99",
        payment_terms_days: 30,
        earliest_invoice_date: new Date(2026, 9, 10),
      },
      { legal_name: "No Invoice", net_balance: "5", payment_terms_days: 7, earliest_invoice_date: null },
    ]);
    deps.sendText.mockResolvedValue({ success: true });

    await checkOverdueCustomers();

    const [message] = deps.sendText.mock.calls[0];
    expect(message).toContain("*Payment Reminder*");
    expect(message).toContain("• Late Co: $1,234.50 — due");
    expect(message).toContain("(20d overdue)");
    expect(message).toContain("• Today Co: $10.00");
    expect(message).toContain("(due today)");
    expect(message).not.toContain("Early Co");
    expect(message).not.toContain("No Invoice");
    expect(logger.info).toHaveBeenCalledWith("[OverdueCheck] Reminder sent for 2 overdue customer(s).");
  });

  it("sends nothing when no one is overdue or WhatsApp is off, and logs a failed send", async () => {
    deps.overdue.mockResolvedValue([]);
    await checkOverdueCustomers();
    expect(deps.sendText).not.toHaveBeenCalled();

    deps.settings.mockResolvedValue({ enabled: false });
    await checkOverdueCustomers();
    expect(deps.overdue).toHaveBeenCalledTimes(1);

    deps.settings.mockResolvedValue({ enabled: true });
    deps.overdue.mockResolvedValue([
      { legal_name: "Late Co", net_balance: "1", payment_terms_days: 1, earliest_invoice_date: new Date(2026, 8, 1) },
    ]);
    deps.sendText.mockResolvedValue({ success: false, errors: ["bad token"] });
    await checkOverdueCustomers();
    expect(logger.error).toHaveBeenCalledWith("[OverdueCheck] Failed to send WhatsApp reminder:", {
      error: ["bad token"],
    });

    deps.overdue.mockRejectedValue(new Error("query failed"));
    await expect(checkOverdueCustomers()).resolves.toBeUndefined();
  });
});

describe("daily export WhatsApp send", () => {
  const zip = { kind: "buffer" } as never;
  const companies = [{ id: 1, name: "Acme" }];

  beforeEach(() => {
    deps.settings.mockResolvedValue({ enabled: true, dailyAutoSend: true, dailyRecipientId: 5 });
    deps.query.mockResolvedValue({ rows: [{ chat_id: "group@g.us" }] });
    deps.size.mockReturnValue(10 * 1024 * 1024);
  });

  it("sends the ZIP to the configured group", async () => {
    deps.sendFileToChat.mockResolvedValue({ success: true });

    expect(await runDailyWhatsAppSend(zip, "2026-10-21", companies)).toEqual({ sent: true, skipped: false });
    expect(deps.query).toHaveBeenCalledWith(expect.stringContaining("FROM whatsapp_recipients"), [5]);
    expect(deps.sendFileToChat).toHaveBeenCalledWith(
      "group@g.us",
      zip,
      "DailyExport_2026-10-21.zip",
      "",
      "application/zip"
    );
  });

  it.each([
    ["WhatsApp is disabled", { enabled: false }],
    ["Daily auto-send toggle is off", { enabled: true, dailyAutoSend: false, dailyRecipientId: 5 }],
    ["No daily export WhatsApp group configured", { enabled: true, dailyAutoSend: true, dailyRecipientId: null }],
  ])("skips: %s", async (reason, settings) => {
    deps.settings.mockResolvedValue(settings);

    expect(await runDailyWhatsAppSend(zip, "d", companies)).toEqual({ sent: false, skipped: true, skipReason: reason });
  });

  it("lets a manual run bypass the auto-send toggle", async () => {
    deps.settings.mockResolvedValue({ enabled: true, dailyAutoSend: false, dailyRecipientId: 5 });
    deps.sendFileToChat.mockResolvedValue({ success: true });

    expect(await runDailyWhatsAppSend(zip, "d", companies, { bypassAutoSendCheck: true })).toMatchObject({
      sent: true,
    });
  });

  it("skips an inactive recipient and refuses a ZIP over the limit", async () => {
    deps.query.mockResolvedValueOnce({ rows: [] });
    expect(await runDailyWhatsAppSend(zip, "d", companies)).toMatchObject({
      skipped: true,
      skipReason: "Daily export recipient id=5 not found or inactive",
    });

    deps.size.mockReturnValue(65 * 1024 * 1024);
    expect(await runDailyWhatsAppSend(zip, "d", companies)).toEqual({
      sent: false,
      skipped: false,
      error: "ZIP is too large for WhatsApp. Size: 65.0 MB (limit: 64 MB).",
    });
    expect(deps.sendFileToChat).not.toHaveBeenCalled();
  });

  it("reports a refused or crashed send", async () => {
    deps.sendFileToChat.mockResolvedValueOnce({ success: false, error: "Quota" });
    expect(await runDailyWhatsAppSend(zip, "d", companies)).toEqual({ sent: false, skipped: false, error: "Quota" });
    deps.sendFileToChat.mockResolvedValueOnce({ success: false });
    expect(await runDailyWhatsAppSend(zip, "d", companies)).toMatchObject({ error: "Send failed" });
    deps.sendFileToChat.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await runDailyWhatsAppSend(zip, "d", companies)).toMatchObject({ error: "socket hang up" });
  });
});

describe("stock report due check", () => {
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };
  const due = (frequency: string, lastSentAt: Date | null = null, sendDayOfWeek: number | null = null) =>
    shouldSendStockReport({ frequency, sendHour: 18, sendDayOfWeek, lastSentAt });

  it("is due daily at the send hour, once a day", () => {
    at("2026-10-21T22:00:00Z"); // 18:00 New York
    expect(due("daily")).toBe(true);
    expect(due("daily", new Date("2026-10-21T22:00:00Z"))).toBe(false);
    expect(due("daily", new Date("2026-10-20T22:00:00Z"))).toBe(true);
    at("2026-10-21T21:00:00Z");
    expect(due("daily")).toBe(false);
  });

  it("is due weekly on its day (Monday by default), once that week", () => {
    at("2026-10-19T22:00:00Z"); // Monday
    expect(due("weekly")).toBe(true);
    expect(due("weekly", null, 3)).toBe(false);
    at("2026-10-21T22:00:00Z"); // Wednesday
    expect(due("weekly", null, 3)).toBe(true);
    expect(due("weekly", new Date("2026-10-19T22:00:00Z"), 3)).toBe(false);
  });

  it("is due monthly on the first, once that month, and never for an unknown frequency", () => {
    at("2026-10-01T22:00:00Z");
    expect(due("monthly")).toBe(true);
    expect(due("monthly", new Date("2026-10-01T22:00:00Z"))).toBe(false);
    expect(due("hourly")).toBe(false);
    at("2026-10-02T22:00:00Z");
    expect(due("monthly")).toBe(false);
  });
});
