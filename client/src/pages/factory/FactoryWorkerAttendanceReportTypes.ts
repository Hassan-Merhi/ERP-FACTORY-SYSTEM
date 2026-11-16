// Extracted from ./FactoryWorkerAttendanceReport.tsx to keep that module under the source-size cap.
import type { AttendanceAdminCredentials } from "./factoryattendance/attendanceEditPolicy";

export type AttendanceReportRecord = { workerId: number; attendanceDate: string; status: string };

export type AttendanceReportSavePayload = {
  records: AttendanceReportRecord[];
  credentials?: AttendanceAdminCredentials;
};
