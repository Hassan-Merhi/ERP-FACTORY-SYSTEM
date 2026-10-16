/** Date-only utilities. Parse as UTC midnight to avoid daylight-saving shifts. */
export function getLocalTodayISO(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateToUTC(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const time = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return null;
  return time;
}

export function daysSincePortDeparture(departureDate: string | null | undefined, todayISO: string): number | null {
  if (!departureDate) return null;
  const departure = dateToUTC(departureDate);
  const today = dateToUTC(todayISO);
  if (departure === null || today === null || departure > today) return null;
  return Math.round((today - departure) / 86_400_000);
}
