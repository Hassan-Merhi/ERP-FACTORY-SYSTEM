import { describe, expect, it } from "vitest";
import { AttendanceReportRequestError, readAttendanceReportResponse } from "../client/src/pages/factory/factoryworkerattendancereport/reportResponse";

describe("attendance report API response", () => {
  const valid = { startDate: "2026-10-01", endDate: "2026-10-31", dates: [], workers: [], totals: { workers: 0 } };

  it("reads valid JSON report responses", async () => {
    const response = new Response(JSON.stringify(valid), { status: 200, headers: { "Content-Type": "application/json" } });
    expect(await readAttendanceReportResponse(response)).toEqual(valid);
  });

  it("does not parse a successful SPA HTML fallback as JSON", async () => {
    const response = new Response("<!DOCTYPE html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    await expect(readAttendanceReportResponse(response)).rejects.toMatchObject({
      name: "AttendanceReportRequestError", status: 200, retryable: false,
      message: expect.stringContaining("backend route"),
    });
  });

  it("marks upstream HTML 502 errors as retryable", async () => {
    const response = new Response("<!DOCTYPE html><html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    await expect(readAttendanceReportResponse(response)).rejects.toMatchObject({
      name: "AttendanceReportRequestError", status: 502, retryable: true,
      message: expect.stringContaining("temporarily unavailable"),
    });
  });

  it("preserves JSON permission errors without retrying", async () => {
    const response = new Response(JSON.stringify({ message: "Access denied" }), { status: 403, headers: { "Content-Type": "application/json" } });
    await expect(readAttendanceReportResponse(response)).rejects.toMatchObject({
      message: "Access denied", status: 403, retryable: false,
    });
  });

  it("does not silently accept malformed report data", async () => {
    const response = new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    await expect(readAttendanceReportResponse(response)).rejects.toBeInstanceOf(AttendanceReportRequestError);
  });
});
