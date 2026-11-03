import { describe, expect, it } from "vitest";
import {
  ATTENDANCE_REPORT_MAX_DAYS,
  validateAttendanceReportDateRange,
} from "../shared/attendanceReportDateRange";

describe("attendance report date range safety", () => {
  it("accepts October 2026 and a full leap year", () => {
    expect(validateAttendanceReportDateRange("2026-10-01", "2026-10-31")).toBeNull();
    expect(validateAttendanceReportDateRange("2024-01-01", "2024-12-31")).toBeNull();
    expect(ATTENDANCE_REPORT_MAX_DAYS).toBe(366);
  });

  it("rejects a partial year that would generate hundreds of thousands of dates", () => {
    expect(validateAttendanceReportDateRange("0002-10-01", "2026-10-31")).toContain("no more than");
  });

  it("rejects reversed, malformed and impossible calendar dates", () => {
    expect(validateAttendanceReportDateRange("2026-11-01", "2026-10-01")).toContain("earlier");
    expect(validateAttendanceReportDateRange("", "2026-10-31")).toContain("valid");
    expect(validateAttendanceReportDateRange("2026-02-30", "2026-03-01")).toContain("valid");
  });

  it("rejects ranges longer than 366 calendar days", () => {
    expect(validateAttendanceReportDateRange("2024-01-01", "2025-01-01")).toContain("no more than");
  });
});
