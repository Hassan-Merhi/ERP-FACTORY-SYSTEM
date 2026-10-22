/**
 * Factory Net Position date contract, shared between browser and API.
 *
 * Historical reports are inclusive of the chosen business day. When the
 * caller can supply both the effective date and a real recorded-at timestamp,
 * movements must satisfy BOTH cutoffs ("known by that day", not retroactively
 * invented history). Legacy rows without adequate events are an audit gap,
 * not permission to guess event times.
 */
export type FactoryNetPositionValuationMode = "cost" | "selling";
export type FactoryNetPositionHistoryBasis = "known-at-cutoff";

export interface FactoryNetPositionAsOf {
  /** Company-local ISO business date, inclusive. */
  asOf: string;
  /** Today's date in the same company timezone. */
  businessToday: string;
  /** Validated IANA timezone, or UTC when none is configured. */
  timeZone: string;
  isHistorical: boolean;
  historyBasis: FactoryNetPositionHistoryBasis;
}

export function isValidNetPositionDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T12:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidNetPositionTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value === "browser") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** No locale-dependent en-CA date formatting or UTC-day rollover. */
export function netPositionBusinessDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value;
  return [pick("year"), pick("month"), pick("day")].join("-");
}

export function resolveFactoryNetPositionDay(input: unknown, businessToday: string): string {
  if (!isValidNetPositionDate(businessToday)) throw new Error("Invalid company business date");
  if (input === undefined || input === null) return businessToday;
  if (!isValidNetPositionDate(input)) throw new FactoryNetPositionDateError("INVALID_AS_OF_DATE");
  if (input > businessToday) throw new FactoryNetPositionDateError("FUTURE_AS_OF_DATE");
  return input;
}

export class FactoryNetPositionDateError extends Error {
  readonly status = 400;
  constructor(readonly code: "INVALID_AS_OF_DATE" | "FUTURE_AS_OF_DATE") {
    super(
      code === "FUTURE_AS_OF_DATE"
        ? "The selected date cannot be later than the company business date."
        : "Use a real calendar date in YYYY-MM-DD format."
    );
    this.name = "FactoryNetPositionDateError";
  }
}
