/** Recurring journal configuration/read operations, with original database semantics. */
import { and, asc, eq } from "drizzle-orm";
import { accountingPostingRequests, recurringJournals, voucherEntries, vouchers, type RecurringJournal } from "@shared/schema";
import { db } from "../../db";
import { sumMoney } from "../../lib/money";
import {
  RecurringJournalError,
  firstRecurringRunDate,
  deriveRecurringDescriptionTemplate,
  entryToTemplate,
  validateEndDate,
  normalizeTimeZone,
} from "./recurringJournalDates";

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
    const debitTotal = sumMoney(entryTemplate.filter((entry) => entry.type === "DR").map((entry) => entry.amount));
    const creditTotal = sumMoney(entryTemplate.filter((entry) => entry.type === "CR").map((entry) => entry.amount));
    if (!debitTotal.eq(creditTotal) || debitTotal.lte(0)) {
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
  if (active && !existing.active) {
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

export async function listRecurringJournals(companyId: number) {
  return db
    .select({
      id: recurringJournals.id,
      sourceVoucherId: recurringJournals.sourceVoucherId,
      sourceVoucherNumber: vouchers.voucherNumber,
      sourceVoucherDescription: vouchers.description,
      name: recurringJournals.name,
      descriptionTemplate: recurringJournals.descriptionTemplate,
      frequency: recurringJournals.frequency,
      scheduleRule: recurringJournals.scheduleRule,
      timezone: recurringJournals.timezone,
      currency: recurringJournals.currency,
      active: recurringJournals.active,
      startDate: recurringJournals.startDate,
      endDate: recurringJournals.endDate,
      nextRunDate: recurringJournals.nextRunDate,
      lastRunDate: recurringJournals.lastRunDate,
      lastAttemptAt: recurringJournals.lastAttemptAt,
      lastError: recurringJournals.lastError,
    })
    .from(recurringJournals)
    .innerJoin(vouchers, eq(recurringJournals.sourceVoucherId, vouchers.id))
    .where(eq(recurringJournals.companyId, companyId))
    .orderBy(asc(recurringJournals.nextRunDate), asc(recurringJournals.id));
}

export async function upsertRecurringJournalFromVoucherNumber(
  input: Omit<UpsertRecurringJournalFromVoucherInput, "sourceVoucherId"> & { voucherNumber: string }
): Promise<RecurringJournal> {
  const voucherNumber = String(input.voucherNumber || "").trim();
  if (!voucherNumber) {
    throw new RecurringJournalError("RECURRING_SOURCE_NUMBER_REQUIRED", "Journal voucher number is required");
  }

  const [voucher] = await db
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(and(eq(vouchers.companyId, input.companyId), eq(vouchers.voucherNumber, voucherNumber)))
    .limit(1);

  if (!voucher) {
    throw new RecurringJournalError(
      "RECURRING_SOURCE_NOT_FOUND",
      `Journal voucher ${voucherNumber} was not found in the selected company`,
      404
    );
  }

  return upsertRecurringJournalFromVoucher({
    companyId: input.companyId,
    sourceVoucherId: voucher.id,
    userId: input.userId,
    timezone: input.timezone,
    endDate: input.endDate,
    descriptionTemplate: input.descriptionTemplate,
  });
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
