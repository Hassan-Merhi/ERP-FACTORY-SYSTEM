// Extracted from ./rentalPaymentPostingService.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { writeAuditEvent } from "../audit";
import { propertyPayments } from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { sumMoney, toMoney } from "../../lib/money";
import { maybeRunAutoTransfer, type RentalModule } from "../../routes/rental/shared";
import { approvedLegacyNonCashBillingAdjustment } from "./rentalPaymentAllocationService";
import { shouldRunRentalAutoTransfer } from "./rentalCashboxPolicy";
import { appendRentalTenantName } from "./rentalVoucherTenantDescription";
import { isValidRentalBusinessDate } from "./rentalPaymentClassification";
import {
  hashGroupId,
  type RentalContractRef,
  type RentalPostingError,
  type RentalUnitRef,
} from "./rentalPaymentPostingServiceTypes";
import { postGroupCore } from "./rentalPaymentPostingServicePostGroupCore";

/**
 * Posts one SCHEDULED payment group. Exported for the due-payment runner in
 * rentalDueScheduledPaymentService.ts; payment creation also calls it with its
 * own transaction for immediate payments.
 */
export async function postScheduledGroup(
  companyId: number,
  contractCompanyId: number,
  module: RentalModule,
  contract: RentalContractRef,
  unit: RentalUnitRef | null,
  groupId: string,
  paymentDate: string,
  asOfDate: string,
  cashAccountId: number | null,
  currency: string,
  exchangeRate: string,
  notes: string | null,
  shopExpenseAccountName: string,
  incomeAccountName: string,
  isSharedPayment: boolean,
  audit?: { actor: { userId: string; username: string }; trigger: string },
  existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]
): Promise<boolean> {
  if (!isValidRentalBusinessDate(paymentDate) || !isValidRentalBusinessDate(asOfDate)) {
    const error: RentalPostingError = new Error("RENTAL_SCHEDULED_PAYMENT_DATE_INVALID");
    error.status = 400;
    throw error;
  }
  const lockKey = hashGroupId(groupId);
  let groupRows: (typeof propertyPayments.$inferSelect)[] = [];

  // Immediate payments use their caller's transaction so payment rows, monthly
  // balances, and accounting entries commit or roll back together.
  const applyPosting = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    // Use the SAME contract lock order as immediate payment creation so that
    // scheduled groups cannot race each other (or a new cash receipt) into
    // paying the same rental month twice.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`rental-contract:${contractCompanyId}:${contract.id}`}))`
    );
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

    // Lock the WHOLE group, not just rows still marked SCHEDULED. A mixed
    // POSTED/SCHEDULED group is inconsistent and must not create another
    // cash voucher for the remaining rows.
    groupRows = await tx
      .select()
      .from(propertyPayments)
      .where(
        and(
          eq(propertyPayments.companyId, companyId),
          eq(propertyPayments.module, module),
          eq(propertyPayments.paymentGroupId, groupId)
        )
      )
      .orderBy(propertyPayments.id)
      .for("update");

    if (groupRows.length === 0 || groupRows.every((r) => r.postingStatus === "POSTED")) {
      groupRows = [];
      return;
    }
    if (
      groupRows.some(
        (r) =>
          r.postingStatus !== "SCHEDULED" ||
          r.voucherId !== null ||
          r.contractId !== contract.id ||
          r.paymentDate !== paymentDate ||
          r.cashAccountId !== cashAccountId ||
          String(r.currency ?? "USD").toUpperCase() !== String(currency ?? "USD").toUpperCase() ||
          r.ledgerRowId === null
      )
    ) {
      const error: RentalPostingError = new Error("RENTAL_PAYMENT_GROUP_CHANGED_OR_PARTIALLY_POSTED");
      error.status = 409;
      throw error;
    }
    if (paymentDate > asOfDate) {
      const error: RentalPostingError = new Error("RENTAL_SCHEDULED_PAYMENT_NOT_YET_DUE");
      error.status = 409;
      throw error;
    }

    // Scheduled allocations were planned on their creation date. Another
    // payment can settle the same period before its posting date arrives.
    // Re-evaluate CURRENT live posted vouchers under locked month rows.
    // Reject stale scheduled groups without touching cash, vouchers or flags.
    const monthIds = groupRows.map((r) => r.ledgerRowId as number);
    if (new Set(monthIds).size !== monthIds.length) {
      const error: RentalPostingError = new Error("RENTAL_SCHEDULED_PAYMENT_DUPLICATE_MONTH");
      error.status = 409;
      throw error;
    }
    const lockedMonths = (
      await tx.execute(sql`
      SELECT ml.id,ml.year,ml.month,ml.expected_amount
      FROM property_monthly_ledger ml
      WHERE ml.id IN (${sql.raw(monthIds.join(","))})
        AND ml.company_id=${contractCompanyId}
        AND ml.contract_id=${contract.id}
      ORDER BY ml.id FOR UPDATE OF ml
    `)
    ).rows as Array<{ id: number; year: number; month: number; expected_amount: string }>;
    if (lockedMonths.length !== monthIds.length) {
      const error: RentalPostingError = new Error("RENTAL_SCHEDULED_PAYMENT_MONTH_MISSING");
      error.status = 409;
      throw error;
    }
    const lockedById = new Map(lockedMonths.map((row) => [Number(row.id), row]));
    const bookedAmounts = (
      await tx.execute(sql`
      SELECT p.ledger_row_id,COALESCE(SUM(p.amount::numeric),0) AS paid
      FROM property_payments p
      LEFT JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=p.company_id
        AND v.deleted_at IS NULL AND v.optional=FALSE
      WHERE p.company_id=${companyId} AND p.module=${module}
        AND p.contract_id=${contract.id}
        AND p.posting_status='POSTED'
        AND (v.id IS NOT NULL OR (${approvedLegacyNonCashBillingAdjustment}))
        AND p.ledger_row_id IN (${sql.raw(monthIds.join(","))})
      GROUP BY p.ledger_row_id
    `)
    ).rows as Array<{ ledger_row_id: number; paid: string }>;
    const paidByMonth = new Map(bookedAmounts.map((row) => [Number(row.ledger_row_id), toMoney(row.paid)]));
    for (const row of groupRows) {
      const locked = lockedById.get(row.ledgerRowId as number);
      if (!locked || locked.year !== row.forYear || locked.month !== row.forMonth) {
        const error: RentalPostingError = new Error("RENTAL_SCHEDULED_PAYMENT_MONTH_CHANGED");
        error.status = 409;
        throw error;
      }
      const expected = toMoney(locked.expected_amount).gt(0)
        ? toMoney(locked.expected_amount)
        : toMoney(contract.rentalAmount);
      const prior = paidByMonth.get(locked.id) ?? new Decimal(0);
      if (prior.plus(toMoney(row.amount)).gt(expected.plus("0.005"))) {
        const error: RentalPostingError = new Error("RENTAL_SCHEDULED_PAYMENT_ALLOCATION_STALE");
        error.status = 409;
        throw error;
      }
    }

    const totalAmountStr = sumMoney(groupRows.map((r) => r.amount as string)).toFixed(2);

    const allocs = groupRows.map((r) => ({
      forYear: r.forYear,
      forMonth: r.forMonth,
      chunk: r.amount as string,
      ledgerRowId: r.ledgerRowId,
    }));

    const unitLabel = unit ? `${unit.locationGroup}/${unit.unitNumber}` : `Unit#${groupRows[0].unitId}`;
    const monthSpan =
      allocs.length > 1
        ? `${String(allocs[0].forMonth).padStart(2, "0")}/${allocs[0].forYear}–${String(allocs[allocs.length - 1].forMonth).padStart(2, "0")}/${allocs[allocs.length - 1].forYear}`
        : `${String(allocs[0].forMonth).padStart(2, "0")}/${allocs[0].forYear}`;
    const baseNarration = `Rent paid - ${unitLabel} - ${monthSpan}`;
    const narration =
      module === "PROPERTIES"
        ? (appendRentalTenantName(baseNarration, contract.tenantName) ?? baseNarration)
        : baseNarration;

    // Phase 19 (B), PE2: the caller resolved the recorded dated rate.
    const groupExchangeRate = exchangeRate;

    const voucherId = await postGroupCore(tx, {
      companyId,
      module,
      contract,
      unit,
      cashAccountId,
      allocs,
      totalAmountStr,
      paymentDate,
      asOfDate,
      currency: currency || "USD",
      exchangeRate: groupExchangeRate,
      narration,
      shopExpenseAccountName,
      incomeAccountName,
      isSharedPayment,
      groupId,
    });

    for (const alloc of allocs) {
      if (alloc.ledgerRowId) {
        await tx.execute(sql`
          UPDATE property_monthly_ledger
          SET paid_amount = paid_amount + ${alloc.chunk}::numeric
          WHERE id = ${alloc.ledgerRowId}
        `);
      }
    }

    const rowIds = groupRows.map((r) => r.id);
    await tx
      .update(propertyPayments)
      .set({
        postingStatus: "POSTED",
        postedAt: new Date(),
        voucherId: voucherId ?? null,
        exchangeRate: groupExchangeRate,
      })
      .where(inArray(propertyPayments.id, rowIds));

    if (audit) {
      await writeAuditEvent(
        {
          userId: audit.actor.userId,
          username: audit.actor.username,
          companyId,
          action: "update",
          tableName: "property_payments",
          recordId: voucherId ?? null,
          recordIdentifier: `rental-scheduled-payment:${groupId}`,
          changes: {
            payments: {
              old: groupRows.map((r) => ({ id: r.id, postingStatus: "SCHEDULED", voucherId: r.voucherId ?? null })),
              new: groupRows.map((r) => ({ id: r.id, postingStatus: "POSTED", voucherId: voucherId ?? null })),
            },
            paymentDate: { new: paymentDate },
            totalAmount: { new: totalAmountStr },
            trigger: { new: audit.trigger },
          },
        },
        tx
      );
    }
  };

  if (existingTx) {
    await applyPosting(existingTx);
  } else {
    await db.transaction(applyPosting);
  }

  if (groupRows.length === 0) return false;
  // An outer transaction has not committed yet. Its caller performs the
  // Legacy ERP/Factory auto-transfer only *after* successful commit.
  if (existingTx) return true;

  try {
    const firstRow = groupRows[0];
    if (shouldRunRentalAutoTransfer(module) && firstRow.cashAccountId && unit) {
      const unitLabel = `${unit.locationGroup}/${unit.unitNumber}`;
      await maybeRunAutoTransfer(
        companyId,
        module,
        firstRow.cashAccountId,
        sumMoney(groupRows.map((r) => r.amount as string)).toFixed(2),
        paymentDate,
        unitLabel,
        firstRow.id,
        notes ?? undefined
      );
    }
  } catch (e: unknown) {
    logger.warn("[rentalPostingService] auto-transfer failed:", {
      error: getErrorMessage(e).split("\n")[0],
    });
  }

  return true;
}
