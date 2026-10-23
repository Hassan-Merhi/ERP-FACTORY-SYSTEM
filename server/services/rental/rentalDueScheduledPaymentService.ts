/**
 * Posts every due SCHEDULED rental payment group for a company/module.
 *
 * The batch runner only selects due groups, resolves their contract, unit and
 * recorded rate, and reports skips and failures. Each group's accounting is
 * posted by postScheduledGroup in rentalPaymentPostingService.ts, inside that
 * group's own transaction, so this file writes nothing itself.
 */
import { db, pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { isClosedPeriodError } from "../../lib/closedPeriodError";
import { propertyPayments, propertyContracts, propertyUnits } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import type { RentalModule } from "../../routes/rental/shared";
import { isRentalRateRequiredError, recordedRentalPaymentRate } from "./rentalPaymentRate";
import { postScheduledGroup } from "./rentalPaymentPostingService";

const SCHEDULED_PAYMENT_ACTOR = { userId: "system", username: "rental-scheduled-payments" } as const;

/** Who posts due scheduled payments, and the company's closed-books date (wave 18 A). */
export interface DueScheduledPaymentOptions {
  /** Groups dated on or before this date are skipped (PERIOD_CLOSED), never forced. */
  closedThrough?: string | null;
  actor?: { userId: string; username: string };
  trigger?: "scheduler" | "manual" | "route";
}

export interface DueScheduledPaymentResult {
  posted: number;
  skipped: Array<{
    paymentGroupId: string;
    paymentDate: string;
    reason: "PERIOD_CLOSED";
    closedThrough: string | null;
  }>;
  failed: number;
}

export async function postDueScheduledRentalPayments(
  companyId: number,
  module: RentalModule,
  asOfDate: string,
  shopExpenseAccountName: string = "Rent Expense - Shops",
  incomeAccountName: string = "Rental Income"
): Promise<number> {
  const result = await postDueScheduledRentalPaymentsDetailed(
    companyId,
    module,
    asOfDate,
    shopExpenseAccountName,
    incomeAccountName,
    { trigger: "route" }
  );
  return result.posted;
}

/**
 * Posts every SCHEDULED payment group of the company/module dated on or before
 * asOfDate. A group dated in a closed period is skipped and reported; a
 * closed-period rejection from the database guard is reported the same way.
 * Each posted group has an audit row in its posting transaction.
 */
export async function postDueScheduledRentalPaymentsDetailed(
  companyId: number,
  module: RentalModule,
  asOfDate: string,
  shopExpenseAccountName: string,
  incomeAccountName: string,
  options: DueScheduledPaymentOptions
): Promise<DueScheduledPaymentResult> {
  const { rows } = await pool.query<{
    payment_group_id: string;
    payment_date: string;
    cash_account_id: number | null;
    currency: string;
    exchange_rate: string | null;
  }>(
    // payment_date as text: node-postgres returns a DATE as a JS Date, which the
    // posting code (voucher numbers, closed-period check) cannot use (wave 18 A).
    `SELECT DISTINCT payment_group_id, payment_date::text AS payment_date, cash_account_id,
            COALESCE(currency, 'USD') AS currency,
            exchange_rate::text AS exchange_rate
     FROM property_payments
     WHERE company_id = $1
       AND module = $2
       AND posting_status = 'SCHEDULED'
       AND payment_group_id IS NOT NULL
       AND payment_date <= $3
     ORDER BY payment_date`,
    [companyId, module, asOfDate]
  );

  let posted = 0;
  let failed = 0;
  const skipped: DueScheduledPaymentResult["skipped"] = [];
  const closedThrough = options.closedThrough ?? null;
  for (const row of rows) {
    const paymentDate = String(row.payment_date).slice(0, 10);
    if (closedThrough !== null && paymentDate <= closedThrough) {
      skipped.push({ paymentGroupId: row.payment_group_id, paymentDate, reason: "PERIOD_CLOSED", closedThrough });
      continue;
    }
    try {
      const groupRows = await db
        .select()
        .from(propertyPayments)
        .where(
          and(
            eq(propertyPayments.companyId, companyId),
            eq(propertyPayments.module, module),
            eq(propertyPayments.paymentGroupId, row.payment_group_id),
            eq(propertyPayments.postingStatus, "SCHEDULED")
          )
        );

      if (groupRows.length === 0) continue;
      const firstRow = groupRows[0];

      const [contract] = await db
        .select()
        .from(propertyContracts)
        .where(and(eq(propertyContracts.id, firstRow.contractId), eq(propertyContracts.module, module)));
      if (!contract || (contract.companyId !== companyId && contract.linkedCompanyId !== companyId)) {
        throw new Error(`Rental payment group ${row.payment_group_id} does not belong to an accessible contract`);
      }
      const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));

      const isShared = !!contract?.linkedCompanyId;

      const didPost = await postScheduledGroup(
        companyId,
        contract.companyId,
        module,
        contract,
        unit,
        row.payment_group_id,
        row.payment_date,
        asOfDate,
        row.cash_account_id,
        row.currency,
        // Phase 19 (B), PE2: the recorded rate on or before the payment date
        // (the stored row rate was the client's, defaulted to "1").
        await recordedRentalPaymentRate(companyId, row.currency, paymentDate),
        firstRow.notes as string | null,
        shopExpenseAccountName,
        incomeAccountName,
        isShared,
        { actor: options.actor ?? SCHEDULED_PAYMENT_ACTOR, trigger: options.trigger ?? "route" }
      );
      if (didPost) posted++;
    } catch (err: unknown) {
      if (isClosedPeriodError(err)) {
        skipped.push({ paymentGroupId: row.payment_group_id, paymentDate, reason: "PERIOD_CLOSED", closedThrough });
        continue;
      }
      if (isRentalRateRequiredError(err)) {
        failed++;
        logger.warn(`[rentalPostingService] Group ${row.payment_group_id} not posted: no recorded rate`, {
          currency: err.currency,
          paymentDate,
        });
        continue;
      }
      failed++;
      logger.error(`[rentalPostingService] Failed to post group ${row.payment_group_id}:`, {
        error: getErrorMessage(err).split("\n")[0],
      });
    }
  }
  return { posted, skipped, failed };
}
