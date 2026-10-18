import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ pool: { query: vi.fn() } }));
vi.mock("../server/services/whatsappService", () => ({
  getWaSettings: vi.fn(),
  sendWhatsAppTextToChatId: vi.fn(),
}));

import {
  parseWeeklyTimes,
  getScheduledMessageLocalParts,
  shouldSendScheduledMessage,
} from "../server/services/scheduledWhatsAppMessages";

const monday = new Date("2026-10-19T06:01:00.000Z"); // 09:01 Asia/Beirut
const base = {
  id: "1",
  company_id: 1,
  message: "Daily reminder",
  timezone: "Asia/Beirut",
  weekly_times: { "1": "09:00" },
  start_date: null,
  end_date: null,
  created_at: new Date("2026-10-17T06:00:00.000Z"),
  updated_at: new Date("2026-10-17T06:00:00.000Z"),
};

describe("scheduled WhatsApp custom messages", () => {
  it("validates day-specific times and disabled days", () => {
    expect(parseWeeklyTimes({ "1": "09:00", "2": null, "5": "17:45" })).toEqual({
      "1": "09:00",
      "5": "17:45",
    });
    expect(() => parseWeeklyTimes({ "1": "26:00" })).toThrow();
    expect(() => parseWeeklyTimes({})).toThrow();
  });

  it("uses the schedule timezone rather than the server timezone", () => {
    expect(getScheduledMessageLocalParts(monday, "Asia/Beirut")).toEqual({
      localDate: "2026-10-19",
      dayOfWeek: 1,
      localTime: "09:01",
    });
  });

  it("sends once due on an enabled weekday and not before the configured time", () => {
    expect(shouldSendScheduledMessage(base, monday)).toBe("2026-10-19");
    expect(shouldSendScheduledMessage(base, new Date("2026-10-19T05:59:00Z"))).toBeNull();
  });

  it("does not send on disabled days or outside the allowed date range", () => {
    expect(shouldSendScheduledMessage(base, new Date("2026-10-18T06:01:00Z"))).toBeNull();
    expect(shouldSendScheduledMessage({ ...base, start_date: "2026-10-20" }, monday)).toBeNull();
    expect(shouldSendScheduledMessage({ ...base, end_date: "2026-10-18" }, monday)).toBeNull();
  });

  it("does not unexpectedly send today's morning message after editing it later", () => {
    expect(
      shouldSendScheduledMessage(
        {
          ...base,
          updated_at: new Date("2026-10-19T07:00:00Z"),
        },
        monday
      )
    ).toBeNull();
  });
});
