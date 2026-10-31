/** Pure value helpers for staff tracking routes (no I/O). */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isNew(joinDate: string | null | undefined, start: string, end: string): boolean {
  return Boolean(joinDate && joinDate >= start && joinDate <= end);
}

export function joinedByPeriodEnd(joinDate: string | null | undefined, periodEnd: string): boolean {
  return !joinDate || joinDate <= periodEnd;
}

export function parseWorkerIds(value: unknown): number[] {
  const parsed = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
      const json = JSON.parse(value);
      return Array.isArray(json) ? json : [];
    } catch {
      return [];
    }
  })();

  return parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

export function addIsoDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
