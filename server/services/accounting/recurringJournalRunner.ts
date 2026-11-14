/** Recurring journal scheduled posting, with original tenant and transaction boundaries. */
import { and, asc, eq, lte } from "drizzle-orm";
import {
  factoryDaybookEntries,
  factorySettings,
  recurringJournals,
  type RecurringJournal,
  type RecurringJournalEntryTemplate,
} from "@shared/schema";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { isClosedPeriodError } from "../../lib/closedPeriodError";
import { writeAuditEvent } from "../audit";
import { erpRateToDaybookFxRateToUsd } from "./currencyAmounts";
import { applyEmployeeBalanceDeltasTx } from "./employeeBalancePosting";
import { buildManualJournalPostingRequest } from "./manualJournalPosting";
import { postBalancedVoucherTx } from "./centralPostingEngine";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import {
  companyClosedThrough,
  isDateInClosedPeriod,
  runInCompanyPostingScope,
  type ScheduledPostingSkip,
} from "./scheduledPostingScope";
import { localIsoDate, nextMonthEndIso, renderRecurringDescription } from "./recurringJournalDates";

const postingDependencies = createDatabasePostingDependencies();

export interface RecurringJournalRunResult {
  posted: boolean;
  replayed: boolean;
  voucherId: number | null;
  scheduledFor: string;
  /** Set when the scheduled date is in a closed period: nothing posted, nothing advanced. */
  skipped?: ScheduledPostingSkip;
}

const RECURRING_ACTOR = { userId: "system", username: "recurring-journal-scheduler" } as const;

function periodClosedSkip(recurring: RecurringJournal, closedThrough: string | null): ScheduledPostingSkip {
  return {
    companyId: recurring.companyId,
    reference: `recurring-journal:${recurring.id}`,
    date: recurring.nextRunDate,
    reason: "PERIOD_CLOSED",
    closedThrough,
  };
}

/**
 * Posts one recurrence. It runs in the template company's tenant database
 * scope (wave 18 A): the closed-period guard and the opening lock apply. A
 * scheduled date in a closed period is skipped (PERIOD_CLOSED, recorded in
 * lastError, the recurrence not advanced) and never forced; Pause/Resume moves
 * it to the next open month end.
 */
export function runRecurringJournal(recurring: RecurringJournal): Promise<RecurringJournalRunResult> {
  return runInCompanyPostingScope(recurring.companyId, () => runRecurringJournalInScope(recurring));
}

async function runRecurringJournalInScope(recurring: RecurringJournal): Promise<RecurringJournalRunResult> {
  const scheduledFor = recurring.nextRunDate;

  try {
    const result = await db.transaction(async (tx) => {
      // The scheduler candidate can become stale while waiting to run. Lock and
      // reload the recurrence so a concurrent Pause/Resume/settings change or a
      // second scheduler instance cannot post against stale state.
      // This row lock is also the cross-instance serialization point for month-end posting.
      const [locked] = await tx
        .select()
        .from(recurringJournals)
        .where(and(eq(recurringJournals.id, recurring.id), eq(recurringJournals.companyId, recurring.companyId)))
        .for("update");

      if (!locked || !locked.active || locked.nextRunDate !== scheduledFor) {
        return {
          posted: false as const,
          replayed: false,
          voucherId: null,
          scheduledFor,
        };
      }

      const localToday = localIsoDate(locked.timezone);
      if (scheduledFor > localToday) {
        return {
          posted: false as const,
          replayed: false,
          voucherId: null,
          scheduledFor,
        };
      }

      if (locked.endDate && scheduledFor > locked.endDate) {
        await tx
          .update(recurringJournals)
          .set({ active: false, updatedAt: new Date() })
          .where(eq(recurringJournals.id, locked.id));
        return {
          posted: false as const,
          replayed: false,
          voucherId: null,
          scheduledFor,
        };
      }

      const closedThrough = await companyClosedThrough(locked.companyId, tx);
      if (isDateInClosedPeriod(closedThrough, scheduledFor)) {
        const skipped = periodClosedSkip(locked, closedThrough);
        await tx
          .update(recurringJournals)
          .set({
            lastAttemptAt: new Date(),
            lastError: `PERIOD_CLOSED: the books are closed through ${closedThrough}; the run of ${scheduledFor} was skipped`,
            updatedAt: new Date(),
          })
          .where(eq(recurringJournals.id, locked.id));
        return { posted: false as const, replayed: false, voucherId: null, scheduledFor, skipped };
      }

      const entries = locked.entryTemplate as RecurringJournalEntryTemplate[];
      const description = renderRecurringDescription(locked.descriptionTemplate, scheduledFor);
      const requestKey = `recurring-journal:${locked.id}:${scheduledFor}`;
      const built = buildManualJournalPostingRequest({
        companyId: locked.companyId,
        voucherDate: scheduledFor,
        entries,
        notes: description,
        currency: locked.currency,
        exchangeRate: locked.exchangeRate,
        clientRequestId: `recurring-${locked.id}-${scheduledFor}`,
        actor: {
          userId: locked.createdByUserId ?? "system",
          username: "recurring-journal-scheduler",
          reason: `Recurring journal #${locked.id} scheduled for ${scheduledFor}`,
        },
      });

      built.request.source = {
        sourceType: "recurring-journal",
        sourceId: `${locked.id}:${scheduledFor}`,
        idempotencyKey: requestKey,
      };

      await tx
        .update(recurringJournals)
        .set({ lastAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(recurringJournals.id, locked.id));

      const posted = await postBalancedVoucherTx(tx, built.request, postingDependencies);
      if (!posted.replayed) {
        await applyEmployeeBalanceDeltasTx({
          tx,
          companyId: locked.companyId,
          entries: posted.entries,
        });

        // Match normal journal posting behavior for Factory Mode. Keeping the
        // mirror in this transaction prevents the fallback daybook path from
        // misinterpreting a base-currency total as transaction currency.
        const [factorySetting] = await tx
          .select({ companyId: factorySettings.companyId })
          .from(factorySettings)
          .where(eq(factorySettings.companyId, locked.companyId))
          .limit(1);

        if (factorySetting) {
          const currency = posted.voucher.currency || "USD";
          const baseTotal = toMoney(posted.voucher.totalAmount);
          const rate = posted.voucher.exchangeRate ? toMoney(posted.voucher.exchangeRate) : new MoneyDecimal(1);
          const transactionTotal = currency !== "USD" && rate.gt(0) ? baseTotal.times(rate) : baseTotal;

          await tx.insert(factoryDaybookEntries).values({
            companyId: locked.companyId,
            txDate: posted.voucher.voucherDate,
            txType: "JOURNAL",
            referenceId: posted.voucher.id,
            referenceTable: "vouchers",
            description: posted.voucher.description || `Journal voucher #${posted.voucher.voucherNumber}`,
            currencyCode: currency,
            amountCurrency: transactionTotal.toFixed(),
            fxRateToUsd: erpRateToDaybookFxRateToUsd(currency, "USD", posted.voucher.exchangeRate),
            amountUsd: baseTotal.toFixed(),
            createdBy: null,
          });
        }
      }

      const nextRunDate = nextMonthEndIso(scheduledFor);
      const shouldRemainActive = !locked.endDate || nextRunDate <= locked.endDate;

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
        .where(eq(recurringJournals.id, locked.id));

      await writeAuditEvent(
        {
          ...RECURRING_ACTOR,
          companyId: locked.companyId,
          action: "update",
          tableName: "recurring_journals",
          recordId: locked.id,
          recordIdentifier: requestKey,
          changes: {
            lastRunDate: { old: locked.lastRunDate, new: scheduledFor },
            nextRunDate: { old: locked.nextRunDate, new: nextRunDate },
            active: { old: locked.active, new: shouldRemainActive },
            lastGeneratedVoucherId: { old: locked.lastGeneratedVoucherId, new: posted.voucher.id },
            voucher: {
              new: {
                voucherId: posted.voucher.id,
                voucherNumber: posted.voucher.voucherNumber,
                voucherDate: posted.voucher.voucherDate,
                totalAmount: posted.voucher.totalAmount,
                replayed: posted.replayed,
              },
            },
            trigger: { new: "scheduler" },
          },
        },
        tx
      );

      return {
        posted: true as const,
        replayed: posted.replayed,
        voucherId: posted.voucher.id,
        scheduledFor,
      };
    });

    if (!result.posted) {
      if (result.skipped) {
        logger.warn("Recurring journal skipped: scheduled date in a closed period", {
          module: "accounting",
          action: "runRecurringJournal",
          recurringJournalId: recurring.id,
          companyId: recurring.companyId,
          scheduledFor,
          closedThrough: result.skipped.closedThrough,
        });
      }
      return result;
    }

    logger.info("Recurring journal posted", {
      module: "accounting",
      action: "runRecurringJournal",
      recurringJournalId: recurring.id,
      companyId: recurring.companyId,
      scheduledFor,
      voucherId: result.voucherId,
      replayed: result.replayed,
    });

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const closed = isClosedPeriodError(error);
    await db
      .update(recurringJournals)
      .set({
        lastAttemptAt: new Date(),
        lastError: (closed ? `PERIOD_CLOSED: ${message}` : message).slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(recurringJournals.id, recurring.id))
      .catch(() => undefined);
    // The database guard is the backstop: a closed-period rejection is a skip, not a failure.
    if (closed) {
      return {
        posted: false,
        replayed: false,
        voucherId: null,
        scheduledFor,
        skipped: periodClosedSkip(recurring, null),
      };
    }
    throw error;
  }
}

export interface RecurringJournalSchedulerResult {
  candidates: number;
  posted: number;
  failed: number;
  skipped: ScheduledPostingSkip[];
}

/**
 * The hourly pass. Candidates are read across companies (the scheduler's
 * maintenance scope); each recurrence posts in its own company's tenant scope.
 */
export async function runDueRecurringJournals(): Promise<RecurringJournalSchedulerResult> {
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
  const skipped: ScheduledPostingSkip[] = [];

  for (const recurring of candidates) {
    try {
      const result = await runRecurringJournal(recurring);
      if (result.posted) posted += 1;
      if (result.skipped) skipped.push(result.skipped);
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
      skipped,
    });
  }
  return { candidates: candidates.length, posted, failed, skipped };
}
