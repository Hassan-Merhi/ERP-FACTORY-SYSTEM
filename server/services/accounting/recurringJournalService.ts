import { and, asc, eq, lte } from "drizzle-orm";
import {
  accountingPostingRequests,
  recurringJournals,
  voucherEntries,
  vouchers,
  type RecurringJournal,
  type RecurringJournalAccountType,
  type RecurringJournalEntryTemplate,
} from "@shared/schema";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { applyEmployeeBalanceDeltasTx } from "./employeeBalancePosting";
import { buildManualJournalPostingRequest } from "./manualJournalPosting";
import { postBalancedVoucherTx } from "./centralPostingEngine";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";

const postingDependencies = createDatabasePostingDependencies();

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
  const anchor = sourceMonthKey >= todayMonthKey ? sourceVoucherDate : localToday;
  return nextMonthEndIso(anchor);
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
  if (withFullMonth !== null) return withFullMonth;

  const withShortMonth = replaceFirstIgnoreCase(trimmed, shortMonth, "{{month_short}}");
  return withShortMonth ?? trimmed;
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
    const value = Number(raw ?? 0);
    if (Number.isFinite(value) && value > 0) return String(raw);
  }

  throw new RecurringJournalError(
    "RECURRING_ENTRY_AMOUNT_INVALID",
    `Voucher entry ${entry.id} has no positive ${side === "DR" ? "debit" : "credit"} amount`
  );
}

function entryToTemplate(entry: typeof voucherEntries.$inferSelect): RecurringJournalEntryTemplate {
  const populated = ACCOUNT_TARGETS.filter(({ field }) => Number(entry[field] ?? 0) > 0);
  if (populated.length !== 1) {
    throw new RecurringJournalError(
      "RECURRING_ENTRY_TARGET_UNSUPPORTED",
      `Voucher entry ${entry.id} must reference exactly one accounting target to become recurring`
    );
  }

  const debit = Number(entry.transactionDebitAmount ?? entry.baseDebitAmount ?? entry.debitAmount ?? 0);
  const credit = Number(entry.transactionCreditAmount ?? entry.baseCreditAmount ?? entry.creditAmount ?? 0);
  if (debit > 0 === credit > 0) {
    throw new RecurringJournalError(
      "RECURRING_ENTRY_SIDE_INVALID",
      `Voucher entry ${entry.id} must contain exactly one debit or credit amount`
    );
  }

  const target = populated[0];
  const side: "DR" | "CR" = debit > 0 ? "DR" : "CR";
  return {
    type: side,
    accountType: target.type,
    accountId: Number(entry[target.field]),
    amount: persistedEntryAmount(entry, side),
    narration: entry.narration ?? null,
  };
}

function validateEndDate(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  parseIsoDate(value);
  return value;
}

function normalizeTimeZone(value: string | null | undefined): string {
  const timeZone = String(value || "UTC").trim();
  if (!isValidRecurringTimeZone(timeZone)) {
    throw new RecurringJournalError("RECURRING_TIMEZONE_INVALID", `Invalid timezone: ${timeZone}`);
  }
  return timeZone;
}

export interface UpsertRecurringJournalFromVoucherInput {
  companyId: number;
  sourceVoucherId: number;
  userId: string | null;
  timezone?: string | null;
  endDate?: string | null;
  descriptionTemplate?: string | null;
}

export async function upsertRecurringJournalFromVoucher(
  input: UpsertRecurringJournalFromVoucherInput
): Promise<RecurringJournal> {
  const timeZone = normalizeTimeZone(input.timezone);
  const endDate = validateEndDate(input.endDate);

  return db.transaction(async (tx) => {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, input.sourceVoucherId), eq(vouchers.companyId, input.companyId)))
      .limit(1);

    if (!voucher || voucher.deletedAt) {
      throw new RecurringJournalError("RECURRING_SOURCE_NOT_FOUND", "Journal voucher not found", 404);
    }
    if (voucher.voucherType !== "Journal") {
      throw new RecurringJournalError("RECURRING_SOURCE_NOT_JOURNAL", "Only Journal vouchers can be made recurring");
    }
    if (voucher.optional) {
      throw new RecurringJournalError(
        "RECURRING_SOURCE_DRAFT",
        "Optional/draft journals must be posted before they can recur"
      );
    }

    const entries = await tx
      .select()
      .from(voucherEntries)
      .where(eq(voucherEntries.voucherId, voucher.id))
      .orderBy(asc(voucherEntries.id));
    if (entries.length < 2) {
      throw new RecurringJournalError(
        "RECURRING_SOURCE_ENTRIES_INVALID",
        "Recurring journals require at least two voucher entries"
      );
    }

    const entryTemplate = entries.map(entryToTemplate);
    const debitTotal = entryTemplate
      .filter((entry) => entry.type === "DR")
      .reduce((sum, entry) => sum + Number(entry.amount), 0);
    const creditTotal = entryTemplate
      .filter((entry) => entry.type === "CR")
      .reduce((sum, entry) => sum + Number(entry.amount), 0);
    if (Math.abs(debitTotal - creditTotal) > 0.000001 || debitTotal <= 0) {
      throw new RecurringJournalError(
        "RECURRING_SOURCE_UNBALANCED",
        "Source journal must be balanced before it can recur"
      );
    }

    const [existing] = await tx
      .select()
      .from(recurringJournals)
      .where(and(eq(recurringJournals.companyId, input.companyId), eq(recurringJournals.sourceVoucherId, voucher.id)))
      .limit(1);

    const descriptionTemplate =
      input.descriptionTemplate !== undefined
        ? String(input.descriptionTemplate || "").trim() || null
        : deriveRecurringDescriptionTemplate(voucher.description, voucher.voucherDate);

    if (existing) {
      const nextRunDate =
        existing.nextRunDate < localIsoDate(timeZone)
          ? firstRecurringRunDate(voucher.voucherDate, timeZone)
          : existing.nextRunDate;
      const [updated] = await tx
        .update(recurringJournals)
        .set({
          name: voucher.description || `Recurring ${voucher.voucherNumber}`,
          descriptionTemplate,
          timezone: timeZone,
          currency: voucher.currency || "USD",
          exchangeRate: voucher.exchangeRate,
          entryTemplate,
          endDate,
          nextRunDate,
          active: true,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(recurringJournals.id, existing.id))
        .returning();
      return updated;
    }

    const nextRunDate = firstRecurringRunDate(voucher.voucherDate, timeZone);
    if (endDate && endDate < nextRunDate) {
      throw new RecurringJournalError(
        "RECURRING_END_BEFORE_NEXT_RUN",
        `End date must be on or after the next run date (${nextRunDate})`
      );
    }

    const [created] = await tx
      .insert(recurringJournals)
      .values({
        companyId: input.companyId,
        sourceVoucherId: voucher.id,
        name: voucher.description || `Recurring ${voucher.voucherNumber}`,
        descriptionTemplate,
        frequency: "monthly",
        scheduleRule: "month_end",
        timezone: timeZone,
        currency: voucher.currency || "USD",
        exchangeRate: voucher.exchangeRate,
        entryTemplate,
        active: true,
        startDate: voucher.voucherDate,
        endDate,
        nextRunDate,
        createdByUserId: input.userId,
      })
      .returning();

    return created;
  });
}

export interface UpdateRecurringJournalInput {
  active?: boolean;
  timezone?: string | null;
  endDate?: string | null;
  descriptionTemplate?: string | null;
}

export async function updateRecurringJournal(
  companyId: number,
  recurringJournalId: number,
  patch: UpdateRecurringJournalInput
): Promise<RecurringJournal> {
  const [existing] = await db
    .select()
    .from(recurringJournals)
    .where(and(eq(recurringJournals.id, recurringJournalId), eq(recurringJournals.companyId, companyId)))
    .limit(1);
  if (!existing) throw new RecurringJournalError("RECURRING_NOT_FOUND", "Recurring journal not found", 404);

  const timeZone = patch.timezone !== undefined ? normalizeTimeZone(patch.timezone) : existing.timezone;
  const endDate = patch.endDate !== undefined ? validateEndDate(patch.endDate) : existing.endDate;
  const active = patch.active ?? existing.active;

  let nextRunDate = existing.nextRunDate;
  if (active && (!existing.active || nextRunDate < localIsoDate(timeZone))) {
    nextRunDate = firstRecurringRunDate(existing.lastRunDate || existing.startDate, timeZone);
  }
  if (endDate && endDate < nextRunDate && active) {
    throw new RecurringJournalError(
      "RECURRING_END_BEFORE_NEXT_RUN",
      `End date must be on or after the next run date (${nextRunDate})`
    );
  }

  const [updated] = await db
    .update(recurringJournals)
    .set({
      active,
      timezone: timeZone,
      endDate,
      descriptionTemplate:
        patch.descriptionTemplate !== undefined
          ? String(patch.descriptionTemplate || "").trim() || null
          : existing.descriptionTemplate,
      nextRunDate,
      lastError: active ? null : existing.lastError,
      updatedAt: new Date(),
    })
    .where(eq(recurringJournals.id, existing.id))
    .returning();

  return updated;
}

export async function getRecurringJournalForSource(companyId: number, sourceVoucherId: number) {
  const [recurring] = await db
    .select()
    .from(recurringJournals)
    .where(and(eq(recurringJournals.companyId, companyId), eq(recurringJournals.sourceVoucherId, sourceVoucherId)))
    .limit(1);
  if (!recurring) return { recurring: null, history: [] };

  return {
    recurring,
    history: await getRecurringJournalHistory(companyId, recurring.id),
  };
}

export async function getRecurringJournalHistory(companyId: number, recurringJournalId: number) {
  const rows = await db
    .select({
      sourceId: accountingPostingRequests.sourceId,
      id: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      voucherDate: vouchers.voucherDate,
      description: vouchers.description,
      totalAmount: vouchers.totalAmount,
      currency: vouchers.currency,
      createdAt: vouchers.createdAt,
    })
    .from(accountingPostingRequests)
    .innerJoin(vouchers, eq(accountingPostingRequests.voucherId, vouchers.id))
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.sourceType, "recurring-journal")
      )
    )
    .orderBy(asc(vouchers.voucherDate));

  const prefix = `${recurringJournalId}:`;
  return rows.filter((row) => row.sourceId.startsWith(prefix)).map(({ sourceId: _sourceId, ...row }) => row);
}

export async function runRecurringJournal(recurring: RecurringJournal): Promise<{
  posted: boolean;
  replayed: boolean;
  voucherId: number | null;
  scheduledFor: string;
}> {
  const scheduledFor = recurring.nextRunDate;
  const localToday = localIsoDate(recurring.timezone);
  if (!recurring.active || scheduledFor > localToday) {
    return { posted: false, replayed: false, voucherId: null, scheduledFor };
  }

  if (recurring.endDate && scheduledFor > recurring.endDate) {
    await db
      .update(recurringJournals)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(recurringJournals.id, recurring.id));
    return { posted: false, replayed: false, voucherId: null, scheduledFor };
  }

  const entries = recurring.entryTemplate as RecurringJournalEntryTemplate[];
  const description = renderRecurringDescription(recurring.descriptionTemplate, scheduledFor);
  const requestKey = `recurring-journal:${recurring.id}:${scheduledFor}`;
  const built = buildManualJournalPostingRequest({
    companyId: recurring.companyId,
    voucherNumber: `RJ-${recurring.id}-${scheduledFor.replaceAll("-", "")}`,
    voucherDate: scheduledFor,
    entries,
    notes: description,
    currency: recurring.currency,
    exchangeRate: recurring.exchangeRate,
    clientRequestId: `recurring-${recurring.id}-${scheduledFor}`,
    actor: {
      userId: recurring.createdByUserId ?? "system",
      username: "recurring-journal-scheduler",
      reason: `Recurring journal #${recurring.id} scheduled for ${scheduledFor}`,
    },
  });

  built.request.source = {
    sourceType: "recurring-journal",
    sourceId: `${recurring.id}:${scheduledFor}`,
    idempotencyKey: requestKey,
  };

  const nextRunDate = nextMonthEndIso(scheduledFor);
  const shouldRemainActive = !recurring.endDate || nextRunDate <= recurring.endDate;

  try {
    const result = await db.transaction(async (tx) => {
      await tx
        .update(recurringJournals)
        .set({ lastAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(recurringJournals.id, recurring.id));

      const posted = await postBalancedVoucherTx(tx, built.request, postingDependencies);
      if (!posted.replayed) {
        await applyEmployeeBalanceDeltasTx({
          tx,
          companyId: recurring.companyId,
          entries: posted.entries,
        });
      }

      await tx
        .update(recurringJournals)
        .set({
          lastRunDate: scheduledFor,
          lastGeneratedVoucherId: posted.voucher.id,
          nextRunDate,
          active: shouldRemainActive,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(recurringJournals.id, recurring.id));

      return posted;
    });

    logger.info("Recurring journal posted", {
      module: "accounting",
      action: "runRecurringJournal",
      recurringJournalId: recurring.id,
      companyId: recurring.companyId,
      scheduledFor,
      voucherId: result.voucher.id,
      replayed: result.replayed,
    });

    return {
      posted: true,
      replayed: result.replayed,
      voucherId: result.voucher.id,
      scheduledFor,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(recurringJournals)
      .set({ lastAttemptAt: new Date(), lastError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(recurringJournals.id, recurring.id))
      .catch(() => undefined);
    throw error;
  }
}

export async function runDueRecurringJournals(): Promise<void> {
  // This is only a broad prefilter. Each row is re-checked against its own
  // timezone before posting, so month-end boundaries remain correct worldwide.
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowUtc = tomorrow.toISOString().slice(0, 10);
  const candidates = await db
    .select()
    .from(recurringJournals)
    .where(and(eq(recurringJournals.active, true), lte(recurringJournals.nextRunDate, tomorrowUtc)))
    .orderBy(asc(recurringJournals.nextRunDate), asc(recurringJournals.id));

  let posted = 0;
  let failed = 0;

  for (const recurring of candidates) {
    try {
      const result = await runRecurringJournal(recurring);
      if (result.posted) posted += 1;
    } catch (error: unknown) {
      failed += 1;
      logger.error("Recurring journal run failed", {
        module: "accounting",
        action: "runDueRecurringJournals",
        recurringJournalId: recurring.id,
        companyId: recurring.companyId,
        nextRunDate: recurring.nextRunDate,
        error,
      });
    }
  }

  if (candidates.length > 0) {
    logger.info("Recurring journal scheduler pass complete", {
      module: "accounting",
      action: "runDueRecurringJournals",
      candidates: candidates.length,
      posted,
      failed,
    });
  }
}
