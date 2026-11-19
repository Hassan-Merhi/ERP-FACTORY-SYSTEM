/**
 * rentalPaymentPostingService.ts
 *
 * Single authoritative source for rental payment accounting.
 * Allocation selection lives in rentalPaymentAllocationService so this service
 * stays focused on posting and scheduling behavior.
 */

import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { propertyPayments } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { sumMoney } from "../../lib/money";
import { maybeRunAutoTransfer } from "../../routes/rental/shared";
import { shouldRunRentalAutoTransfer } from "./rentalCashboxPolicy";
import type { RentalPaymentGroupOptions } from "./rentalPaymentPostingServiceTypes";
import { createRentalPaymentGroupPart1 } from "./createRentalPaymentGroupPart1";
export type { RentalContractRef, RentalPaymentGroupOptions, RentalUnitRef } from "./rentalPaymentPostingServiceTypes";
export { postScheduledGroup } from "./rentalPaymentPostingServicePostScheduledGroup";

export { buildAllocationsForPayment, findEarliestOutstandingMonth } from "./rentalPaymentAllocationService";

export {
  RENTAL_RATE_REQUIRED_CODE,
  RENTAL_RATE_REQUIRED_MESSAGE,
  isRentalRateRequiredError,
  recordedRentalPaymentRate,
} from "./rentalPaymentRate";

// ── Public API ────────────────────────────────────────────────────────────────

export async function createRentalPaymentGroup(opts: RentalPaymentGroupOptions) {
  const {
    paymentDate,
    clientDate,
    mod,
    cashAccountId,
    unit,
    companyId,
    notes,
    paymentGroupId,
    replayed,
    scheduledRows,
    postedNow,
  } = await createRentalPaymentGroupPart1(opts);

  if (replayed) {
    const posted = scheduledRows.every((row) => row.postingStatus === "POSTED");
    // A retry must not duplicate downstream auto-transfer effects.
    return { paymentGroupId, scheduled: !posted, payments: scheduledRows };
  }

  if (paymentDate <= clientDate) {
    if (!postedNow) throw new Error("Rental payment group was not posted");
    // Properties landlord receipts remain in their own cash account; only
    // ERP/Factory legacy flows may still use an optional auto-transfer.
    // A transfer must never fire inside a transaction that might roll back.
    try {
      if (shouldRunRentalAutoTransfer(mod) && cashAccountId && unit && scheduledRows.length > 0) {
        await maybeRunAutoTransfer(
          companyId,
          mod,
          cashAccountId,
          sumMoney(scheduledRows.map((row) => row.amount as string)).toFixed(2),
          paymentDate,
          `${unit.locationGroup}/${unit.unitNumber}`,
          scheduledRows[0].id,
          notes ?? undefined
        );
      }
    } catch (error: unknown) {
      logger.warn("[rentalPostingService] auto-transfer failed:", {
        error: getErrorMessage(error).split("\\n")[0],
      });
    }

    const posted = await db
      .select()
      .from(propertyPayments)
      .where(
        and(eq(propertyPayments.paymentGroupId, paymentGroupId), sql`${propertyPayments.postingStatus} = 'POSTED'`)
      );

    return { paymentGroupId, scheduled: false, payments: posted };
  }

  return { paymentGroupId, scheduled: true, payments: scheduledRows };
}
