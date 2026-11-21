// Extracted from ./crud.ts
import type { Database } from "../../db";
import { factoryAttendance } from "@shared/schema";

/**
 * Persist absence for the closed inactive interval. Use calendar dates (not local
 * Date increments) and upsert so a previously defaulted Present cannot survive
 * an inactive interval. The interval ends *before* the reactivation date.
 */
export async function recordInactiveDays(
  db: Database,
  companyId: number,
  workerId: number,
  startDate: string,
  endExclusive: string
) {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(startDate) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(endExclusive)) return;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endExclusive}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return;
  const batch: { companyId: number; workerId: number; attendanceDate: string; status: string; notes: string }[] = [];
  for (let day = start; day < end; day += 86_400_000) {
    batch.push({
      companyId,
      workerId,
      attendanceDate: new Date(day).toISOString().slice(0, 10),
      status: "Absent",
      notes: "Auto-absent (inactive)",
    });
    if (batch.length === 500 || day + 86_400_000 >= end) {
      await db
        .insert(factoryAttendance)
        .values(batch)
        .onConflictDoUpdate({
          target: [factoryAttendance.workerId, factoryAttendance.attendanceDate],
          set: { status: "Absent", notes: "Auto-absent (inactive)", updatedAt: new Date() },
        });
      batch.length = 0;
    }
  }
}
