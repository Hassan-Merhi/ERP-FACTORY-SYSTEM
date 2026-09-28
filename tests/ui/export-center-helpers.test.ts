import { describe, expect, it, vi } from "vitest";
import {
  currentYearDateRange,
  fmt12h,
  fmtBytes,
  fmtTime,
  formatHour,
  runTypeBadgeClass,
  runTypeLabel,
  scheduleLabel,
  tzLabel,
} from "../../client/src/pages/settings/ExportCenterHelpers";

describe("ExportCenterHelpers behavioral formatting", () => {
  it("formats export sizes across empty, KB, and MB states", () => {
    expect(fmtBytes()).toBe("—");
    expect(fmtBytes(0)).toBe("—");
    expect(fmtBytes(512 * 1024)).toBe("512 KB");
    expect(fmtBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("formats run labels and badge classes for every supported delivery path", () => {
    expect(runTypeLabel("scheduled")).toBe("Scheduled");
    expect(runTypeLabel("manual_email")).toBe("Manual — Email");
    expect(runTypeLabel("manual_whatsapp")).toBe("Manual — WhatsApp");
    expect(runTypeLabel("manual_download")).toBe("Manual — Download");
    expect(runTypeLabel("future_mode")).toBe("future_mode");

    expect(runTypeBadgeClass("scheduled")).toContain("bg-blue-100");
    expect(runTypeBadgeClass("manual_email")).toContain("bg-violet-100");
    expect(runTypeBadgeClass("manual_whatsapp")).toContain("bg-green-100");
    expect(runTypeBadgeClass("manual_download")).toContain("bg-slate-100");
    expect(runTypeBadgeClass("future_mode")).toBe("bg-muted text-muted-foreground");
  });

  it("formats midnight, morning, noon, and evening schedule hours", () => {
    expect(fmt12h(0)).toBe("12:00 AM");
    expect(fmt12h(9)).toBe("9:00 AM");
    expect(fmt12h(12)).toBe("12:00 PM");
    expect(fmt12h(18)).toBe("6:00 PM");

    expect(formatHour(0)).toBe("12:00 AM");
    expect(formatHour(9)).toBe("9:00 AM");
    expect(formatHour(12)).toBe("12:00 PM");
    expect(formatHour(18)).toBe("6:00 PM");
  });

  it("resolves configured timezones and safely preserves unknown zones", () => {
    expect(tzLabel("Asia/Dubai")).toBe("Dubai (GST, UTC+4)");
    expect(tzLabel("Custom/Zone")).toBe("Custom/Zone");
  });

  it("describes disabled, daily, monthly, weekly, and future schedules", () => {
    expect(scheduleLabel(undefined)).toBe("");
    expect(scheduleLabel({ enabled: true, autoSend: false } as any)).toBe("");
    expect(
      scheduleLabel({ enabled: true, autoSend: true, frequency: "daily", sendHour: 0 } as any),
    ).toBe("Daily at 12:00 AM EST");
    expect(
      scheduleLabel({ enabled: true, autoSend: true, frequency: "monthly", sendHour: 12 } as any),
    ).toBe("Monthly (1st) at 12:00 PM EST");
    expect(
      scheduleLabel({
        enabled: true,
        autoSend: true,
        frequency: "weekly",
        sendHour: 18,
        sendDayOfWeek: 5,
      } as any),
    ).toBe("Every Friday at 6:00 PM EST");
    expect(
      scheduleLabel({
        enabled: true,
        autoSend: true,
        frequency: "weekly",
        sendHour: 18,
        sendDayOfWeek: 99,
      } as any),
    ).toBe("Every Monday at 6:00 PM EST");
    expect(
      scheduleLabel({ enabled: true, autoSend: true, frequency: "yearly", sendHour: 18 } as any),
    ).toBe("Auto-Send On");
  });

  it("returns a parseable localized timestamp and the current-year export range", () => {
    expect(fmtTime()).toBe("—");
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime("2026-09-28T00:00:00.000Z")).not.toBe("—");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T04:30:00.000Z"));
    expect(currentYearDateRange()).toEqual({ start: "2026-01-01", end: "2026-09-28" });
    vi.useRealTimers();
  });
});
