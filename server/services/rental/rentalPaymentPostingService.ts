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
import { writeAuditEvent } from "../audit";
import { propertyPayments, propertyMonthlyLedger } from "@shared/schema";
import { eq, and, sql, inArray, like } from "drizzle-orm";
import Decimal from "decimal.js";
import { parseMoneyInput, sumMoney, toMoney } from "../../lib/money";
import type { RentalModule } from "../../routes/rental/shared";
import { postErpVoucherTx, type ErpVoucherLine } from "../accounting/erpVoucherPosting";
import { findOrCreateLedgerAccount, maybeRunAutoTransfer } from "../../routes/rental/shared";
import { isRentalPeriodDue, getRentalBillingDay, getRentalPeriodDueDate } from "./rentalPeriodService";
import { buildAllocationsForPayment, findEarliestOutstandingMonth } from "./rentalPaymentAllocationService";
import { recordedRentalPaymentRate } from "./rentalPaymentRate";
import { rentalPaymentGroupIdentity, rentalPaymentVoucherSuffix } from "./rentalPostingIdentity";

export { buildAllocationsForPayment, findEarliestOutstandingMonth } from "./rentalPaymentAllocationService";

/** The rental contract fields this posting flow reads. */
export type RentalContractRef = {
  id: number;
  companyId: number;
  unitId: number;
  rentalAmount: string;
  startDate: string;
};

/** The rental unit fields this posting flow reads. */
export type RentalUnitRef = {
  unitNumber: string;
  unitType: string | null;
  locationGroup: string | null;
};

/** A posting failure that carries the HTTP status the route should return. */
type RentalPostingError = Error & { status?: number };

export {
  RENTAL_RATE_REQUIRED_CODE,
  RENTAL_RATE_REQUIRED_MESSAGE,
  isRentalRateRequiredError,
  recordedRentalPaymentRate,
} from "./rentalPaymentRate";

export interface RentalPaymentGroupOptions {
  companyId: number;
  contractCompanyId: number;
  module: RentalModule;
  contract: RentalContractRef;
  unit: RentalUnitRef | null;
  cashAccountId: number | null;
  amount: string;
  paymentDate: string;
  clientDate: string;
  scheduleFuturePayment?: boolean;
  currency: string;
  exchangeRate: string;
  notes: string | null;
  shopExpenseAccountName: string;
  incomeAccountName: string;
  isSharedPayment?: boolean;
  /** Stable client identity for retries; omitted by legacy callers. */
  clientRequestId?: string | null;
  /** Phase 19 (B): the request's actor, audited with the posting. */
  audit?: { actor: { userId: string; username: string }; trigger: string };
}

/** Deterministic int64 advisory-lock key for a payment group ID. */
function hashGroupId(groupId: string): bigint {
  let h = 5381n;
  for (let i = 0; i < groupId.length; i++) {
    h = ((h << 5n) + h + BigInt(groupId.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  if (h > 9223372036854775807n) h -= 18446744073709551616n;
  return h;
}

// ── Core accounting engine ────────────────────────────────────────────────────

/**
 * Creates and posts one payment group's accounting inside a provided
 * transaction. Shared by createRentalPaymentGroup and postScheduledGroup.
 * Returns the created voucherId (or null if no cashAccountId).
 */
async function postGroupCore(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  opts: {
    companyId: number;
    module: RentalModule;
    contract: RentalContractRef;
    unit: RentalUnitRef | null;
    cashAccountId: number | null;
    allocs: Array<{
      forYear: number;
      forMonth: number;
      chunk: string;
      ledgerRowId: number | null;
    }>;
    totalAmountStr: string;
    paymentDate: string;
    asOfDate: string;
    currency: string;
    /** ERP TRANSACTION_PER_BASE rate (foreign-per-USD). "1" for USD contracts. */
    exchangeRate: string;
    narration: string;
    shopExpenseAccountName: string;
    incomeAccountName: string;
    isSharedPayment?: boolean;
    groupId: string;
  }
): Promise<number | null> {
  const {
    companyId,
    module: mod,
    contract,
    unit,
    cashAccountId,
    allocs,
    totalAmountStr,
    paymentDate,
    currency,
    exchangeRate,
    narration,
    shopExpenseAccountName,
    incomeAccountName,
    isSharedPayment,
    groupId,
  } = opts;

  /**
   * Phase 22 (B): one line in the payment's currency (native amount; a non-USD
   * line carries its rate), posted through the central engine.
   */
  const foreign = String(currency || "USD").toUpperCase() !== "USD";
  function line(
    ledgerAccountId: number,
    side: "debit" | "credit",
    native: Decimal.Value,
    text: string
  ): ErpVoucherLine {
    const amount = toMoney(native);
    return {
      ledgerAccountId,
      debit: side === "debit" ? amount : 0,
      credit: side === "credit" ? amount : 0,
      narration: text,
      transaction: foreign ? { currency, amount, rate: exchangeRate } : null,
    };
  }
  async function post(input: {
    voucherNumber: string;
    voucherType: string;
    description: string;
    phase: string;
    lines: ErpVoucherLine[];
  }) {
    const posted = await postErpVoucherTx(tx, {
      companyId,
      voucherNumber: input.voucherNumber,
      voucherType: input.voucherType,
      voucherDate: paymentDate,
      description: input.description,
      currency,
      exchangeRate: foreign ? exchangeRate : null,
      lines: input.lines,
      source: { type: "rental-payment", id: `${companyId}:${groupId}`, revision: input.phase },
    });
    return posted.voucher;
  }

  if (!cashAccountId) return null;

  const isShop = isSharedPayment || unit?.unitType === "SHOP";

  if (isShop) {
    const billingDay = contract ? getRentalBillingDay(contract.startDate as string) : 1;

    let accrualAmt = new Decimal(0);
    let advanceAmt = new Decimal(0);
    let prepaidAmt = new Decimal(0);

    const accrualLedgerIds: number[] = [];
    const advanceLedgerIds: number[] = [];
    const prepaidLedgerIds: number[] = [];

    for (const alloc of allocs) {
      const chunk = new Decimal(alloc.chunk);
      const due = isRentalPeriodDue(alloc.forYear, alloc.forMonth, billingDay, paymentDate);

      if (due) {
        let wasAccrued = false;
        if (alloc.ledgerRowId) {
          const [lr] = await tx
            .select({ accrualVoucherId: propertyMonthlyLedger.accrualVoucherId })
            .from(propertyMonthlyLedger)
            .where(eq(propertyMonthlyLedger.id, alloc.ledgerRowId));
          wasAccrued = !!lr?.accrualVoucherId;
        }
        if (wasAccrued) {
          accrualAmt = accrualAmt.plus(chunk);
          if (alloc.ledgerRowId) accrualLedgerIds.push(alloc.ledgerRowId);
        } else {
          advanceAmt = advanceAmt.plus(chunk);
          if (alloc.ledgerRowId) advanceLedgerIds.push(alloc.ledgerRowId);
        }
      } else {
        prepaidAmt = prepaidAmt.plus(chunk);
        if (alloc.ledgerRowId) prepaidLedgerIds.push(alloc.ledgerRowId);
      }
    }

    const sumCheck = accrualAmt.plus(advanceAmt).plus(prepaidAmt);
    if (sumCheck.lt(0.005) && new Decimal(totalAmountStr).gt(0.005)) {
      advanceAmt = new Decimal(totalAmountStr);
      for (const alloc of allocs) {
        if (alloc.ledgerRowId) advanceLedgerIds.push(alloc.ledgerRowId);
      }
    }

    // RENT- / ADV-REC- numbers are kept (deterministic, read by the payment
    // deletion service to find the recognition journal).
    const voucherNum = `RENT-${paymentDate.replace(/-/g, "")}-${rentalPaymentVoucherSuffix(groupId)}`;
    const payLines: ErpVoucherLine[] = [line(cashAccountId, "credit", totalAmountStr, narration)];
    if (accrualAmt.gt(0.005)) {
      const accPayId = await findOrCreateLedgerAccount(
        tx,
        companyId,
        "Accrued Rent Payable",
        "Liability",
        "ACC-RENT-PAY"
      );
      payLines.push(line(accPayId, "debit", accrualAmt.toFixed(2), narration));
    }
    if (advanceAmt.gt(0.005)) {
      const advId = await findOrCreateLedgerAccount(tx, companyId, "Advance Rent Paid", "Asset", "ADV-RENT-PAID");
      payLines.push(line(advId, "debit", advanceAmt.toFixed(2), narration));
    }
    if (prepaidAmt.gt(0.005)) {
      const prepId = await findOrCreateLedgerAccount(tx, companyId, "Prepaid Rent", "Asset", "PREPAID-RENT");
      payLines.push(line(prepId, "debit", prepaidAmt.toFixed(2), narration));
    }
    const v = await post({
      voucherNumber: voucherNum,
      voucherType: "Payment",
      description: narration,
      phase: "payment",
      lines: payLines,
    });

    let recognitionVoucherId: number | null = null;
    if (advanceAmt.gt(0.005)) {
      const recNarr = `Advance rent recognition - ${narration}`;
      const expId = await findOrCreateLedgerAccount(
        tx,
        companyId,
        shopExpenseAccountName,
        "Indirect Expense",
        "SHOP-RENT-EXP"
      );
      const advId = await findOrCreateLedgerAccount(tx, companyId, "Advance Rent Paid", "Asset", "ADV-RENT-PAID");
      const rv = await post({
        voucherNumber: `ADV-REC-${paymentDate.replace(/-/g, "")}-${rentalPaymentVoucherSuffix(groupId)}`,
        voucherType: "Journal",
        description: recNarr,
        phase: "advance-recognition",
        lines: [
          line(expId, "debit", advanceAmt.toFixed(2), recNarr),
          line(advId, "credit", advanceAmt.toFixed(2), recNarr),
        ],
      });
      recognitionVoucherId = rv.id;
    }

    if (advanceLedgerIds.length > 0) {
      await tx
        .update(propertyMonthlyLedger)
        .set({
          usedAdvanceAccount: true,
          usedPrepaidAccount: false,
          accrualVoucherId: recognitionVoucherId,
        })
        .where(inArray(propertyMonthlyLedger.id, advanceLedgerIds));
    }
    if (prepaidLedgerIds.length > 0) {
      await tx
        .update(propertyMonthlyLedger)
        .set({ usedPrepaidAccount: true, usedAdvanceAccount: false })
        .where(inArray(propertyMonthlyLedger.id, prepaidLedgerIds));
    }
    if (accrualLedgerIds.length > 0) {
      await tx
        .update(propertyMonthlyLedger)
        .set({ usedPrepaidAccount: false, usedAdvanceAccount: false })
        .where(inArray(propertyMonthlyLedger.id, accrualLedgerIds));
    }

    return v.id;
  } else {
    const incomeAccountId = await findOrCreateLedgerAccount(
      tx,
      companyId,
      incomeAccountName,
      "Income",
      "RENT-INC",
      "Indirect Income"
    );

    if (mod === "PROPERTIES") {
      const voucherNum = `RENT-${paymentDate.replace(/-/g, "")}-${rentalPaymentVoucherSuffix(groupId)}`;
      const v = await post({
        voucherNumber: voucherNum,
        voucherType: "Receipt",
        description: narration,
        phase: "payment",
        lines: [
          line(cashAccountId, "debit", totalAmountStr, narration),
          line(incomeAccountId, "credit", totalAmountStr, narration),
        ],
      });

      const landlordLedgerIds = allocs.map((a) => a.ledgerRowId).filter(Boolean) as number[];
      if (landlordLedgerIds.length > 0) {
        await tx
          .update(propertyMonthlyLedger)
          .set({ usedPrepaidAccount: false, usedAdvanceAccount: false })
          .where(inArray(propertyMonthlyLedger.id, landlordLedgerIds));
      }

      return v.id;
    }

    const pd = new Date(paymentDate + "T00:00:00Z");
    const payYear = pd.getUTCFullYear();
    const payMonth = pd.getUTCMonth() + 1;
    const futureAllocs = allocs.filter((a) => a.forYear > payYear || (a.forYear === payYear && a.forMonth > payMonth));
    // Exact: the earned and deferred credits add up to the cash debit to the cent.
    const deferredChunk = sumMoney(futureAllocs.map((a) => a.chunk));
    const earnedChunk = toMoney(totalAmountStr).minus(deferredChunk);

    const voucherNum = `RENT-${paymentDate.replace(/-/g, "")}-${rentalPaymentVoucherSuffix(groupId)}`;
    const lLines: ErpVoucherLine[] = [line(cashAccountId, "debit", totalAmountStr, narration)];
    if (earnedChunk.gt("0.005")) lLines.push(line(incomeAccountId, "credit", earnedChunk.toFixed(2), narration));
    if (deferredChunk.gt("0.005")) {
      const deferredId = await findOrCreateLedgerAccount(
        tx,
        companyId,
        "Deferred Rent Revenue",
        "Liability",
        "DEF-RENT-REV"
      );
      lLines.push(line(deferredId, "credit", deferredChunk.toFixed(2), narration));
      const futureIds = futureAllocs.map((a) => a.ledgerRowId).filter(Boolean) as number[];
      if (futureIds.length > 0) {
        await tx
          .update(propertyMonthlyLedger)
          .set({ usedPrepaidAccount: true })
          .where(inArray(propertyMonthlyLedger.id, futureIds));
      }
    }
    const v = await post({
      voucherNumber: voucherNum,
      voucherType: "Receipt",
      description: narration,
      phase: "payment",
      lines: lLines,
    });

    return v.id;
  }
}

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
    // The cross-company auto-transfer is a distinct optional business action
    // and must never fire inside a transaction that might later roll back.
    try {
      if (cashAccountId && unit && scheduledRows.length > 0) {
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
  const lockKey = hashGroupId(groupId);
  let groupRows: (typeof propertyPayments.$inferSelect)[] = [];

  // Immediate payments use their caller's transaction so payment rows, monthly
  // balances, and accounting entries commit or roll back together.
  const applyPosting = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

    groupRows = await tx
      .select()
      .from(propertyPayments)
      .where(
        and(
          eq(propertyPayments.companyId, companyId),
          eq(propertyPayments.module, module),
          eq(propertyPayments.paymentGroupId, groupId),
          sql`${propertyPayments.postingStatus} = 'SCHEDULED'`
        )
      )
      .orderBy(propertyPayments.id)
      .for("update");

    if (groupRows.length === 0) return;

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
    const narration = `Rent paid - ${unitLabel} - ${monthSpan}`;

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
  // optional cross-company auto-transfer only *after* successful commit.
  if (existingTx) return true;

  try {
    const firstRow = groupRows[0];
    if (firstRow.cashAccountId && unit) {
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
