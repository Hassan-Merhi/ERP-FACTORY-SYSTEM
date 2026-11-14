/** Pure recurrence dates, entry templates and validation. */
import { voucherEntries, type RecurringJournalAccountType, type RecurringJournalEntryTemplate } from "@shared/schema";
import { toMoney } from "../../lib/money";

const ACCOUNT_TARGETS: Array<{
  type: RecurringJournalAccountType;
  field:
    | "ledgerAccountId"
    | "bankAccountId"
    | "supplierId"
    | "factorySupplierId"
    | "employeeId"
    | "fixedAssetId"
    | "customerId";
}> = [
  { type: "ledger", field: "ledgerAccountId" },
  { type: "bank", field: "bankAccountId" },
  { type: "supplier", field: "supplierId" },
  { type: "factorySupplier", field: "factorySupplierId" },
  { type: "employee", field: "employeeId" },
  { type: "fixedAsset", field: "fixedAssetId" },
  { type: "customer", field: "customerId" },
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RecurringJournalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "RecurringJournalError";
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseIsoDate(value: string): { year: number; month: number; day: number } {
  if (!ISO_DATE_RE.test(value)) {
    throw new RecurringJournalError("RECURRING_DATE_INVALID", `Invalid date: ${value}`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RecurringJournalError("RECURRING_DATE_INVALID", `Invalid date: ${value}`);
  }
  return { year, month, day };
}

export function isValidRecurringTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localIsoDate(timeZone: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function monthEndIso(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function nextMonthEndIso(date: string): string {
  const { year, month } = parseIsoDate(date);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return monthEndIso(nextYear, nextMonth);
}

export function firstRecurringRunDate(sourceVoucherDate: string, timeZone: string, now = new Date()): string {
  const localToday = localIsoDate(timeZone, now);
  const source = parseIsoDate(sourceVoucherDate);
  const today = parseIsoDate(localToday);

  const sourceMonthKey = source.year * 12 + source.month;
  const todayMonthKey = today.year * 12 + today.month;

  if (sourceMonthKey >= todayMonthKey) {
    return nextMonthEndIso(sourceVoucherDate);
  }

  return monthEndIso(today.year, today.month);
}

function replaceFirstIgnoreCase(value: string, search: string, replacement: string): string | null {
  const index = value.toLocaleLowerCase("en-US").indexOf(search.toLocaleLowerCase("en-US"));
  if (index < 0) return null;
  return value.slice(0, index) + replacement + value.slice(index + search.length);
}

export function deriveRecurringDescriptionTemplate(description: string | null, voucherDate: string): string {
  const trimmed = String(description ?? "").trim();
  if (!trimmed) return "Recurring journal — {{month}} {{year}}";

  const { year, month, day } = parseIsoDate(voucherDate);
  const date = new Date(Date.UTC(year, month - 1, day));
  const fullMonth = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
  const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);

  const withFullMonth = replaceFirstIgnoreCase(trimmed, fullMonth, "{{month}}");
  const withMonth =
    withFullMonth !== null
      ? withFullMonth
      : (replaceFirstIgnoreCase(trimmed, shortMonth, "{{month_short}}") ?? trimmed);

  return replaceFirstIgnoreCase(withMonth, String(year), "{{year}}") ?? withMonth;
}

export function renderRecurringDescription(template: string | null, scheduledFor: string): string {
  const { year, month, day } = parseIsoDate(scheduledFor);
  const date = new Date(Date.UTC(year, month - 1, day));
  const fullMonth = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
  const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);

  return String(template || "Recurring journal — {{month}} {{year}}")
    .replaceAll("{{month}}", fullMonth)
    .replaceAll("{{month_short}}", shortMonth)
    .replaceAll("{{year}}", String(year))
    .replaceAll("{{yyyy_mm}}", `${year}-${pad2(month)}`)
    .replaceAll("{{date}}", scheduledFor);
}

function persistedEntryAmount(entry: typeof voucherEntries.$inferSelect, side: "DR" | "CR"): string {
  const candidates =
    side === "DR"
      ? [entry.transactionDebitAmount, entry.baseDebitAmount, entry.debitAmount]
      : [entry.transactionCreditAmount, entry.baseCreditAmount, entry.creditAmount];

  for (const raw of candidates) {
    if (toMoney(raw).gt(0)) return String(raw);
  }

  throw new RecurringJournalError(
    "RECURRING_ENTRY_AMOUNT_INVALID",
    `Voucher entry ${entry.id} has no positive ${side === "DR" ? "debit" : "credit"} amount`
  );
}

export function entryToTemplate(entry: typeof voucherEntries.$inferSelect): RecurringJournalEntryTemplate {
  const populated = ACCOUNT_TARGETS.filter(({ field }) => Number(entry[field] ?? 0) > 0);
  if (populated.length !== 1) {
    throw new RecurringJournalError(
      "RECURRING_ENTRY_TARGET_UNSUPPORTED",
      `Voucher entry ${entry.id} must reference exactly one accounting target to become recurring`
    );
  }

  const debit = toMoney(entry.transactionDebitAmount ?? entry.baseDebitAmount ?? entry.debitAmount ?? 0);
  const credit = toMoney(entry.transactionCreditAmount ?? entry.baseCreditAmount ?? entry.creditAmount ?? 0);
  if (debit.gt(0) === credit.gt(0)) {
    throw new RecurringJournalError(
      "RECURRING_ENTRY_SIDE_INVALID",
      `Voucher entry ${entry.id} must contain exactly one debit or credit amount`
    );
  }

  const target = populated[0];
  const side: "DR" | "CR" = debit.gt(0) ? "DR" : "CR";
  return {
    type: side,
    accountType: target.type,
    accountId: Number(entry[target.field]),
    amount: persistedEntryAmount(entry, side),
    narration: entry.narration ?? null,
  };
}

export function validateEndDate(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  parseIsoDate(value);
  return value;
}

export function normalizeTimeZone(value: string | null | undefined): string {
  const timeZone = String(value || "UTC").trim();
  if (!isValidRecurringTimeZone(timeZone)) {
    throw new RecurringJournalError("RECURRING_TIMEZONE_INVALID", `Invalid timezone: ${timeZone}`);
  }
  return timeZone;
}
