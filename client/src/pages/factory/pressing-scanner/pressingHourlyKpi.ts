import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";

// Reuse the server's authoritative hourly result for all daily dashboard KPIs.
// The pressing report/export remains a separate date-range history view.
export type PressingHourlySnapshot = {
  day: string;
  serverNow: string;
  canEdit: boolean;
  workers: Array<{ userId: string; slot: string; name: string; targetKgPerHour: number }>;
  hours: Array<{ hourStart: string; userId: string; kg: string; bales: number }>;
  hourlyTargetsKg: Record<string, number>;
  dailyScheduleKg?: Record<string, number>;
  dailyScheduleEffectiveDay?: string | null;
  editableDailyScheduleKg?: Record<string, number>;
  editableDailyScheduleEffectiveDay?: string | null;
};

const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: PRESSING_TIME_ZONE, hour: "2-digit", hourCycle: "h23",
});

export function pressingHourlyKpiTotals(snapshot?: PressingHourlySnapshot) {
  if (!snapshot) return [];
  const totals = new Map<string, { bales: number; kg: number }>();
  const workerIds = new Set(snapshot.workers.map(worker => worker.userId));
  for (const row of snapshot.hours) {
    if (!workerIds.has(row.userId)) continue;
    const hour = Number(hourFormatter.format(new Date(row.hourStart)));
    if (hour < 7 || hour >= 17) continue;
    const current = totals.get(row.userId) ?? { bales: 0, kg: 0 };
    current.bales += Number(row.bales) || 0;
    current.kg += Number(row.kg) || 0;
    totals.set(row.userId, current);
  }
  return snapshot.workers.map(worker => ({
    userId: worker.userId,
    name: worker.name,
    totalBales: totals.get(worker.userId)?.bales ?? 0,
    totalKg: (totals.get(worker.userId)?.kg ?? 0).toFixed(3),
  }));
}
