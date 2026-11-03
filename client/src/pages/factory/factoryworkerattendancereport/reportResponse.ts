import type { AttendanceReportData } from "./types";

/**
 * API responses can be replaced by an upstream HTML 502/503 page or the SPA
 * index.html when a backend route is missing. Never feed that markup to JSON.parse.
 */
export class AttendanceReportRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryable: boolean) {
    super(message);
    this.name = "AttendanceReportRequestError";
  }
}

export async function readAttendanceReportResponse(response: Response): Promise<AttendanceReportData> {
  const status = response.status;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw new AttendanceReportRequestError(
      status >= 500
        ? `Attendance report server is temporarily unavailable (HTTP ${status}). Please try again.`
        : `Attendance report API returned a web page instead of report data (HTTP ${status}). The backend route or deployment needs attention.`,
      status,
      status >= 500
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AttendanceReportRequestError(
      `Attendance report returned an invalid response (HTTP ${status}). Please try again.`,
      status,
      status >= 500
    );
  }

  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;

  if (!response.ok) {
    throw new AttendanceReportRequestError(
      typeof record?.message === "string" && record.message.trim()
        ? record.message
        : `Unable to load attendance report (HTTP ${status}).`,
      status,
      status === 429 || status >= 500
    );
  }

  if (
    !record ||
    !Array.isArray(record.dates) ||
    !Array.isArray(record.workers) ||
    typeof record.startDate !== "string" ||
    typeof record.endDate !== "string" ||
    !record.totals ||
    typeof record.totals !== "object"
  ) {
    throw new AttendanceReportRequestError(
      "Attendance report response is incomplete. Please try again.",
      status,
      false
    );
  }

  return record as unknown as AttendanceReportData;
}
