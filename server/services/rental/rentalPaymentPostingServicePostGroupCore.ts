// Extracted from ./rentalPaymentPostingService.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { propertyMonthlyLedger } from "@shared/schema";
import { inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { sumMoney, toMoney } from "../../lib/money";
import { findOrCreateLedgerAccount, type RentalModule } from "../../routes/rental/shared";
import { type ErpVoucherLine, postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { getRentalBillingDay, getRentalPeriodDueDate, isRentalPeriodDue } from "./rentalPeriodService";
import { rentalPaymentVoucherSuffix } from "./rentalPostingIdentity";
import { shouldSettleAccruedRentPayable } from "./rentalPaymentClassification";
import { isRentRecognitionHeld } from "./rentRecognitionHold";
import { postAccrualPassTx } from "../../routes/rental/shared/accrual-posting";
import type { RentalContractRef, RentalPostingError, RentalUnitRef } from "./rentalPaymentPostingServiceTypes";

// ── Core accounting engine ────────────────────────────────────────────────────

/**
 * Creates and posts one payment group's accounting inside a provided
 * transaction. Shared by createRentalPaymentGroup and postScheduledGroup.
 * Returns the created voucherId (or null if no cashAccountId).
 */
export async function postGroupCore(
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

  // Never mark a rent payment POSTED without a cash/bank counterpart.
  // Historically this returned null yet the caller still marked monthly
  // allocations as paid, leaving a missing cash voucher and phantom settlement.
  if (!cashAccountId || !Number.isSafeInteger(cashAccountId) || cashAccountId <= 0) {
    const error: RentalPostingError = new Error("RENTAL_PAYMENT_CASH_ACCOUNT_REQUIRED");
    error.status = 409;
    throw error;
  }

  const accountValid = (
    await tx.execute(sql`
    SELECT id FROM ledger_accounts
    WHERE id=${cashAccountId} AND company_id=${companyId}
      AND active=TRUE AND deleted_at IS NULL
    LIMIT 1
  `)
  ).rows;
  if (accountValid.length !== 1) {
    const error: RentalPostingError = new Error("RENTAL_PAYMENT_CASH_ACCOUNT_NOT_AVAILABLE_IN_COMPANY");
    error.status = 409;
    throw error;
  }

  const isShop = isSharedPayment || unit?.unitType === "SHOP";

  if (isShop) {
    const billingDay = contract ? getRentalBillingDay(contract.startDate as string) : 1;

    let accrualAmt = new Decimal(0);
    let advanceAmt = new Decimal(0);
    // A new due month is fully recognized at first partial payment, with the
    // unpaid balance posted to AP; not just the small cash amount received.
    let advanceExpectedAmt = new Decimal(0);
    let prepaidAmt = new Decimal(0);

    const accrualLedgerIds: number[] = [];
    const advanceLedgerIds: number[] = [];
    const prepaidLedgerIds: number[] = [];

    for (const alloc of allocs) {
      const chunk = new Decimal(alloc.chunk);
      const due = isRentalPeriodDue(alloc.forYear, alloc.forMonth, billingDay, paymentDate);

      if (due) {
        // A non-null monthly accrual link does NOT establish an AP liability.
        // It may point to a prepaid/advance recognition journal, a deleted
        // voucher, or a control account in a different company. Confirm an
        // actual live credit to this payer's Accrued Rent Payable before
        // debiting that account in the payment voucher.
        let wasAccrued = false;
        if (alloc.ledgerRowId) {
          const evidence = (
            await tx.execute(sql`
            SELECT ml.id, ml.notes, ml.expected_amount, ml.paid_amount,
              ml.used_prepaid_account, ml.used_advance_account, ml.accrual_voucher_id,
              v.id IS NOT NULL AS accrual_live,
              EXISTS (
                SELECT 1 FROM voucher_entries ve
                JOIN ledger_accounts la ON la.id=ve.ledger_account_id
                  AND la.company_id=${companyId} AND la.deleted_at IS NULL
                WHERE ve.company_id=${companyId} AND ve.voucher_id=v.id
                  AND ve.credit_amount::numeric > 0
                  AND la.account_type='Liability'
                  AND (
                    la.name='Accrued Rent Payable'
                    OR la.code='ACC-RENT-PAY' OR la.code LIKE 'ACC-RENT-PAY-%'
                    OR la.code='ACCR-RENT-PAY' OR la.code LIKE 'ACCR-RENT-PAY-%'
                  )
              ) AS credited_payable
            FROM property_monthly_ledger ml
            LEFT JOIN vouchers v ON v.id=ml.accrual_voucher_id
              AND v.company_id=${companyId} AND v.deleted_at IS NULL
              AND v.optional=FALSE
            WHERE ml.id=${alloc.ledgerRowId}
              AND ml.company_id=${contract.companyId}
              AND ml.contract_id=${contract.id}
              AND ml.year=${alloc.forYear} AND ml.month=${alloc.forMonth}
            LIMIT 1
          `)
          ).rows as Array<{
            id: number;
            notes: string | null;
            accrual_live: boolean;
            credited_payable: boolean;
            expected_amount: string;
            paid_amount: string;
            used_prepaid_account: boolean;
            used_advance_account: boolean;
            accrual_voucher_id: number | null;
          }>;
          if (evidence.length !== 1) {
            throw new Error("RENTAL_PAYMENT_MONTH_LINK_CHANGED");
          }
          wasAccrued = shouldSettleAccruedRentPayable({
            dueOnPaymentDate: due,
            accrualVoucherLive: evidence[0].accrual_live,
            creditedAccruedPayable: evidence[0].credited_payable,
            recognitionHold: isRentRecognitionHeld(evidence[0].notes),
          });
          if (
            !wasAccrued &&
            evidence[0].used_prepaid_account &&
            evidence[0].accrual_voucher_id === null &&
            !isRentRecognitionHeld(evidence[0].notes) &&
            toMoney(evidence[0].paid_amount).gt("0.005")
          ) {
            // Prepaid month becomes due while another payment is being made.
            // Recognize only the original, live PRE-BILLING payment into
            // expense; establish AP for the remaining rent, then settle the
            // new payment against AP in THIS transaction. No unrelated rent
            // months are accrued, and no existing voucher is modified.
            const prior = toMoney(evidence[0].paid_amount).toDecimalPlaces(2);
            const expected = toMoney(evidence[0].expected_amount).toDecimalPlaces(2);
            const dueDate = getRentalPeriodDueDate(alloc.forYear, alloc.forMonth, billingDay);
            const paidBeforeBilling = (
              await tx.execute(sql`
              SELECT COALESCE(SUM(p.amount::numeric),0) AS amount
              FROM property_payments p
              JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=p.company_id
                AND v.deleted_at IS NULL AND v.optional=FALSE
              WHERE p.ledger_row_id=${alloc.ledgerRowId} AND p.company_id=${companyId}
                AND p.posting_status='POSTED'
                AND p.payment_date < ${dueDate}::date
            `)
            ).rows as Array<{ amount: string }>;
            const actualPrepaid = toMoney(paidBeforeBilling[0]?.amount ?? 0).toDecimalPlaces(2);
            const remainingPayable = expected.minus(actualPrepaid);
            if (!actualPrepaid.eq(prior) || remainingPayable.lt(chunk) || !remainingPayable.gt("0.005")) {
              const error: RentalPostingError = new Error(
                "RENTAL_PREPAID_SOURCE_REQUIRES_REVIEW: posted prepaid vouchers and monthly rent do not agree"
              );
              error.status = 409;
              throw error;
            }
            const expenseId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              shopExpenseAccountName,
              "Indirect Expense",
              "SHOP-RENT-EXP"
            );
            const prepaidId = await findOrCreateLedgerAccount(tx, companyId, "Prepaid Rent", "Asset", "PREP-RENT");
            const payableId = await findOrCreateLedgerAccount(
              tx,
              companyId,
              "Accrued Rent Payable",
              "Liability",
              "ACCR-RENT-PAY"
            );
            const desc = `Prepaid rent recognized - ${companyId} - ${String(alloc.forMonth).padStart(2, "0")}/${alloc.forYear}`;
            await postAccrualPassTx(tx, {
              companyId,
              module: mod,
              pass: "prepaid-recognition",
              voucherDate: paymentDate,
              description: desc,
              currency,
              lines: [
                { ledgerAccountId: expenseId, debit: expected, narration: desc },
                { ledgerAccountId: prepaidId, credit: actualPrepaid, narration: desc },
                { ledgerAccountId: payableId, credit: remainingPayable, narration: desc },
              ],
              ledgerRowIds: [alloc.ledgerRowId],
              options: { trigger: "route" },
            });
            wasAccrued = true;
          }
          if (!wasAccrued) {
            // Do not silently treat deleted accruals, historical holds, or
            // previously paid prepaid/advance months as new rent. They need
            // existing-voucher review or normal scheduled recognition FIRST.
            const lr = evidence[0];
            if (
              isRentRecognitionHeld(lr.notes) ||
              lr.accrual_voucher_id !== null ||
              lr.used_prepaid_account ||
              lr.used_advance_account ||
              toMoney(lr.paid_amount).gt("0.005") ||
              toMoney(lr.expected_amount).lt(chunk)
            ) {
              const error: RentalPostingError = new Error(
                "RENTAL_MONTH_RECOGNITION_REQUIRES_REVIEW: cannot settle or re-accrue this existing month until its posted voucher is reconciled"
              );
              error.status = 409;
              throw error;
            }
            advanceExpectedAmt = advanceExpectedAmt.plus(toMoney(lr.expected_amount));
          }
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
    if (sumCheck.minus(toMoney(totalAmountStr)).abs().gt("0.005")) {
      const error: RentalPostingError = new Error("RENTAL_PAYMENT_CLASSIFICATION_AMOUNT_MISMATCH");
      error.status = 409;
      throw error;
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
          // Recognize ALL due rent once, including the yet-unpaid portion.
          // The new payment clears the advance asset. A later payment debits
          // the credited AP rather than generating another expense voucher.
          line(expId, "debit", advanceExpectedAmt.toFixed(2), recNarr),
          line(advId, "credit", advanceAmt.toFixed(2), recNarr),
          ...(advanceExpectedAmt.minus(advanceAmt).gt("0.005")
            ? [
                line(
                  await findOrCreateLedgerAccount(tx, companyId, "Accrued Rent Payable", "Liability", "ACCR-RENT-PAY"),
                  "credit",
                  advanceExpectedAmt.minus(advanceAmt).toFixed(2),
                  recNarr
                ),
              ]
            : []),
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
