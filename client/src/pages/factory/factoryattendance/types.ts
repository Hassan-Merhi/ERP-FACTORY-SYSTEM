/**
 * Types for the FactoryAttendance page.
 *
 * Extracted from FactoryAttendance.tsx during the Phase 4 god-file split.
 */

export type AttendanceStatus = "Present" | "Absent" | "Late" | "Half Day" | "Leave";

export type ViewMode = "daily" | "perWorker";

export interface WorkerRow {
  id: number;
  fullName: string;
  employeeCode: string | null;
  department: string | null;
  position: string | null;
  shiftType: string | null;
  active?: boolean;
}

export interface AttendanceBulkRecord {
  workerId: number;
  attendanceDate: string;
  shift?: string;
  status: AttendanceStatus;
  notes?: string;
}

export interface AttendanceRecord {
  id: number;
  workerId: number;
  attendanceDate: string;
  shift: string | null;
  status: string;
  notes: string | null;
}

export type PrintLang = "en" | "ar";

export interface WeekDay {
  dayName: string;
  dayNameAr: string;
  date: Date;
  iso: string;
  dayNum: number;
}
