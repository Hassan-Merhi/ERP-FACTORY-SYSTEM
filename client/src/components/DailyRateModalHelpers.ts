// Extracted from ./DailyRateModal.tsx

export interface DailyRateCompany {
  baseCurrency?: string | null;
  displayCurrency?: string | null;
}

export interface DailyExchangeRate {
  rate?: string | number | null;
  effectiveDate?: string | Date | null;
}

export interface DailyRateModalProps {
  companyId: number;
}

// ---------------------------------------------------------------------------
// localStorage helpers — persist "rate was set today" across remounts / tabs.
// Key format:  daily-rate-done-{companyId}-{YYYY-MM-DD}
// The check is per-company and per-calendar-day so it expires automatically
// when the date changes (no need for explicit cleanup of the current day's key).
// ---------------------------------------------------------------------------
const LS_PREFIX = "daily-rate-done";

function lsKey(companyId: number, date: string) {
  return `${LS_PREFIX}-${companyId}-${date}`;
}

export function isDoneToday(companyId: number, date: string): boolean {
  try {
    return localStorage.getItem(lsKey(companyId, date)) === "1";
  } catch {
    return false;
  }
}

export function markDoneToday(companyId: number, date: string): void {
  try {
    localStorage.setItem(lsKey(companyId, date), "1");
    // Prune stale entries for this company (keep only today's).
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`${LS_PREFIX}-${companyId}-`) && key !== lsKey(companyId, date)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // localStorage may be unavailable (private browsing, quota, etc.) — silent fallback.
  }
}
