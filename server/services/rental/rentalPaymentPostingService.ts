import { randomUUID } from "node:crypto";
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
import { propertyPayments, propertyMonthlyLedger } from "@shared/schema";
import { eq, and, sql, like } from "drizzle-orm";
import { parseMoneyInput, sumMoney, toMoney } from "../../lib/money";
import { maybeRunAutoTransfer } from "../../routes/rental/shared";
import { getRentalBillingDay, getRentalPeriodDueDate } from "./rentalPeriodService";
import {
  approvedLegacyNonCashBillingAdjustment,
  buildAllocationsForPayment,
  findEarliestOutstandingMonth,
} from "./rentalPaymentAllocationService";
import { recordedRentalPaymentRate } from "./rentalPaymentRate";
import { rentalPaymentGroupIdentity } from "./rentalPostingIdentity";
import { shouldRunRentalAutoTransfer } from "./rentalCashboxPolicy";
import { isValidRentalBusinessDate } from "./rentalPaymentClassification";
import type { RentalPaymentGroupOptions, RentalPostingError } from "./rentalPaymentPostingServiceTypes";
import { postScheduledGroup } from "./rentalPaymentPostingServicePostScheduledGroup";
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
    companyId,
    contractCompanyId,
    module: mod,
    contract,
    unit,
    cashAccountId,
    amount,
    paymentDate,
    clientDate,
    scheduleFuturePayment,
    currency,
    exchangeRate,
    notes,
    shopExpenseAccountName,
    incomeAccountName,
    isSharedPayment,
  } = opts;

  if (!isValidRentalBusinessDate(paymentDate) || !isValidRentalBusinessDate(clientDate)) {
    const error: RentalPostingError = new Error("RENTAL_PAYMENT_DATE_INVALID: use a real YYYY-MM-DD calendar date");
    error.status = 400;
    throw error;
  }
  if (!isValidRentalBusinessDate(String(contract.startDate).slice(0, 10))) {
    const error: RentalPostingError = new Error("RENTAL_CONTRACT_BILLING_START_INVALID");
    error.status = 409;
    throw error;
  }
  if (parseMoneyInput(amount) === null || toMoney(amount).lte(0)) {
    const error: RentalPostingError = new Error("RENTAL_PAYMENT_AMOUNT_MUST_BE_POSITIVE");
    error.status = 400;
    throw error;
  }

  if (!cashAccountId || !Number.isSafeInteger(cashAccountId) || cashAccountId <= 0) {
    const error: RentalPostingError = new Error("RENTAL_PAYMENT_CASH_ACCOUNT_REQUIRED");
    error.status = 400;
    throw error;
  }

  if (paymentDate > clientDate && !scheduleFuturePayment) {
    const err: RentalPostingError = new Error("Future payment dates require Schedule future payment.");
    err.status = 400;
    throw err;
  }
  // The client-supplied FX rate is never trusted; a dated recorded rate is used.
  void exchangeRate;

  const identity = rentalPaymentGroupIdentity({
    companyId,
    module: mod,
    contractId: contract.id,
    requestId: opts.clientRequestId,
    financialPayload: {
      contractCompanyId,
      cashAccountId: cashAccountId ?? null,
      amount: String(amount).trim(),
      paymentDate,
      currency: (currency || "USD").trim().toUpperCase(),
      scheduleFuturePayment: Boolean(scheduleFuturePayment),
      notes: notes ?? null,
      isSharedPayment: Boolean(isSharedPayment),
    },
  });
  const paymentGroupId =
    identity.groupId ?? `PG-${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 10)}-${contract.id}`;

  const { scheduledRows, postedNow, replayed } = await db.transaction(async (tx) => {
    if (identity.prefix) {
      // Lock all attempts of one client request before any inserts or posting.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`rental-payment:${companyId}:${identity.prefix}`}))`
      );
      const previous = await tx
        .select()
        .from(propertyPayments)
        .where(
          and(
            eq(propertyPayments.companyId, companyId),
            eq(propertyPayments.module, mod),
            like(propertyPayments.paymentGroupId, `${identity.prefix}%`)
          )
        )
        .orderBy(propertyPayments.id);
      if (previous.length > 0) {
        if (previous.some((row) => row.paymentGroupId !== paymentGroupId)) {
          const error: RentalPostingError = new Error(
            "RENTAL_PAYMENT_IDEMPOTENCY_CONFLICT: this clientRequestId was used for different payment details"
          );
          error.status = 409;
          throw error;
        }
        return { scheduledRows: previous, postedNow: false, replayed: true };
      }
    }
    // Serializing allocation on the contract prevents two payment requests
    // from selecting the same outstanding months concurrently.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`rental-contract:${contractCompanyId}:${contract.id}`}))`
    );
    // Never allocate more rent over a POSTED cash payment whose original
    // voucher is missing or retired. The audited $800 historical noncash
    // billing transition is valid for allocation, not for cash.
    // All other voucherless POSTED rows must fail closed.
    const invalidPosted = (
      await tx.execute(sql`
      SELECT p.id FROM property_payments p
      LEFT JOIN vouchers v ON v.id=p.voucher_id
        AND v.company_id=p.company_id AND v.deleted_at IS NULL
        AND v.optional=FALSE
      WHERE p.company_id=${companyId} AND p.module=${mod}
        AND p.contract_id=${contract.id} AND p.ledger_row_id IS NOT NULL
        AND p.posting_status='POSTED' AND v.id IS NULL
        AND NOT (${approvedLegacyNonCashBillingAdjustment})
      LIMIT 1
    `)
    ).rows;
    if (invalidPosted.length > 0) {
      const error: RentalPostingError = new Error("RENTAL_PAYMENT_HISTORICAL_VOUCHER_MISSING");
      error.status = 409;
      throw error;
    }
    const recordedRate = await recordedRentalPaymentRate(companyId, currency || "USD", paymentDate, tx);
    const billingDay = getRentalBillingDay(contract.startDate as string);
    const totalAmountExact = parseMoneyInput(amount) ?? 0;
    const { year: startY, month: startM } = await findEarliestOutstandingMonth(
      contract.id,
      billingDay,
      paymentDate,
      tx
    );
    const allocations = await buildAllocationsForPayment(
      contract.id,
      startY,
      startM,
      totalAmountExact,
      contract.rentalAmount as string,
      billingDay,
      paymentDate,
      tx
    );

    // Never accept a silently truncated (120-month limit) or empty allocation.
    // Otherwise the cash voucher would disagree with the requested amount and
    // a retry could post a different set of monthly lines.
    const allocatedTotal = sumMoney(allocations.map((a) => a.chunk));
    if (
      allocations.length === 0 ||
      !allocatedTotal.eq(toMoney(totalAmountExact).toDecimalPlaces(2)) ||
      allocations.some((a) => toMoney(a.chunk).lte(0))
    ) {
      const error: RentalPostingError = new Error("RENTAL_PAYMENT_ALLOCATION_INCOMPLETE");
      error.status = 409;
      throw error;
    }

    for (const alloc of allocations) {
      const allocDueDate = getRentalPeriodDueDate(alloc.year, alloc.month, billingDay);
      const allocIsDue = allocDueDate <= paymentDate;
      const expectedForAlloc = allocIsDue ? contract.rentalAmount : "0";
      await tx.execute(sql`
        INSERT INTO property_monthly_ledger (
          company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount
        ) VALUES (
          ${contractCompanyId}, ${mod}, ${contract.id}, ${contract.unitId},
          ${alloc.year}, ${alloc.month}, ${expectedForAlloc}, 0
        )
        ON CONFLICT (contract_id, year, month)
        DO UPDATE SET
          expected_amount = CASE
            WHEN property_monthly_ledger.expected_amount::numeric = 0
            THEN EXCLUDED.expected_amount
            ELSE property_monthly_ledger.expected_amount
          END
      `);
    }

    const created: (typeof propertyPayments.$inferSelect)[] = [];
    for (const alloc of allocations) {
      const [lr] = await tx
        .select({ id: propertyMonthlyLedger.id })
        .from(propertyMonthlyLedger)
        .where(
          and(
            eq(propertyMonthlyLedger.contractId, contract.id),
            eq(propertyMonthlyLedger.year, alloc.year),
            eq(propertyMonthlyLedger.month, alloc.month)
          )
        );

      const [p] = await tx
        .insert(propertyPayments)
        .values({
          companyId: companyId,
          module: mod,
          contractId: contract.id,
          unitId: contract.unitId,
          ledgerRowId: lr?.id ?? null,
          cashAccountId: cashAccountId ?? null,
          voucherId: null,
          amount: alloc.chunk,
          paymentDate: paymentDate,
          forYear: alloc.year,
          forMonth: alloc.month,
          currency: currency || "USD",
          exchangeRate: recordedRate,
          notes: allocations.length > 1 ? `${notes ? notes + " | " : ""}Split from ${amount} payment` : (notes ?? null),
          postingStatus: "SCHEDULED",
          paymentGroupId,
        })
        .returning();
      created.push(p);
    }
    // Previously the inserts committed first, then voucher posting ran in a
    // second transaction. An error left scheduled payments and ledger rows
    // behind. Immediate payments now post inside this same transaction.
    const postedNow =
      paymentDate <= clientDate
        ? await postScheduledGroup(
            companyId,
            contractCompanyId,
            mod,
            contract,
            unit,
            paymentGroupId,
            paymentDate,
            clientDate,
            cashAccountId,
            currency,
            recordedRate,
            notes,
            shopExpenseAccountName,
            incomeAccountName,
            isSharedPayment ?? false,
            opts.audit,
            tx
          )
        : false;
    return { scheduledRows: created, postedNow, replayed: false };
  });

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
