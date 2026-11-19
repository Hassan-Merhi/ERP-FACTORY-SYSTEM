// Extracted from ./accrual.ts: a stage of postRentAccrualForCompany.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { propertyMonthlyLedger } from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { findOrCreateLedgerAccount } from "./ledger";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { isRentRecognitionHeld } from "../../../services/rental/rentRecognitionHold";
import { postAccrualPassTx } from "./accrual-posting";
import type { RentAccrualPostingOptions } from "./accrual-posting";
import type { loadRentAccrualContext } from "./accrualContext";

type LoadRentAccrualContextResult = Awaited<ReturnType<typeof loadRentAccrualContext>>;

export async function rentAccrualPass3({
  acx,
  companyId,
  shopExpenseAccountName,
  moduleParam,
  options,
}: {
  acx: LoadRentAccrualContextResult;
  companyId: number;
  shopExpenseAccountName: string;
  moduleParam: string;
  options: RentAccrualPostingOptions;
}) {
  const { contractIds, isDue, effectiveAsOf, batchCurrency, unitNameById, totals } = acx; // end Pass 1.5

  // ── Pass 2: Tenant prepaid rent recognition ──────────────────────────────
  // For rows where usedPrepaidAccount=true, accrualVoucherId IS NULL, and isDue:
  //   Dr Rent Expense (expectedAmount)
  //     Cr Prepaid Rent          (paidAmount  — reverses the asset)
  //     Cr Accrued Rent Payable  (unpaidPortion, if any — normal liability for remainder)
  // Using paidAmount (not expectedAmount) for the Prepaid Rent credit ensures we
  // never over-credit the asset for partial advance payments.
  if (contractIds.length > 0) {
    try {
      const prepaidUnaccrued = await db
        .select()
        .from(propertyMonthlyLedger)
        .where(
          and(
            inArray(propertyMonthlyLedger.contractId, contractIds),
            isNull(propertyMonthlyLedger.accrualVoucherId),
            eq(propertyMonthlyLedger.usedPrepaidAccount, true),
            // A paid future month may have expected_amount=0 until the due
            // schedule is populated. Do not stamp a zero-dollar recognition.
            sql`${propertyMonthlyLedger.expectedAmount}::numeric > 0`
          )
        );
      const heldDuePrepaid = prepaidUnaccrued.filter((r) => isDue(r) && isRentRecognitionHeld(r.notes));
      if (heldDuePrepaid.length > 0) {
        logger.warn("[ERP/rental] Rent recognition held pending accounting reconciliation", {
          companyId,
          rentalMonthIds: heldDuePrepaid.map((r) => r.id),
        });
      }
      const duePrepaid = prepaidUnaccrued.filter((r) => isDue(r) && !isRentRecognitionHeld(r.notes));
      if (duePrepaid.length > 0) {
        await db.transaction(async (tx) => {
          // PREPAY RECOGNITION: lock the month first and prove the actual
          // posted pre-billing cash vouchers. A stale paid_amount cache or
          // payment posted after the billing day must never over-credit
          // Prepaid Rent (or silently create a duplicate expense).
          const prepaidIds = duePrepaid.map((r) => r.id);
          if (prepaidIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
            throw new Error("RENTAL_PREPAID_INVALID_MONTH_ID");
          }
          const lockedPrepaid = (
            await tx.execute(sql`
            SELECT ml.id, ml.paid_amount, ml.expected_amount, ml.notes,
              ml.accrual_voucher_id, ml.used_prepaid_account
            FROM property_monthly_ledger ml
            WHERE ml.id IN (${sql.join(
              prepaidIds.map((id) => sql`${id}`),
              sql`, `
            )})
              AND ml.accrual_voucher_id IS NULL
              AND ml.used_prepaid_account=TRUE
            ORDER BY ml.id FOR UPDATE OF ml
          `)
          ).rows as Array<{
            id: number;
            paid_amount: string;
            expected_amount: string;
            notes: string | null;
            accrual_voucher_id: number | null;
            used_prepaid_account: boolean;
          }>;
          if (lockedPrepaid.length !== prepaidIds.length || lockedPrepaid.some((r) => isRentRecognitionHeld(r.notes))) {
            throw new Error("RENTAL_PREPAID_MONTH_CHANGED_OR_HELD");
          }

          const postedPrepaid = (
            await tx.execute(sql`
            SELECT p.ledger_row_id,
              COALESCE(SUM(p.amount::numeric),0) AS paid
            FROM property_payments p
            JOIN property_monthly_ledger ml ON ml.id=p.ledger_row_id
            JOIN property_contracts pc ON pc.id=ml.contract_id
            JOIN vouchers v ON v.id=p.voucher_id AND v.company_id=p.company_id
              AND v.deleted_at IS NULL AND v.optional=FALSE
            WHERE p.ledger_row_id IN (${sql.join(
              prepaidIds.map((id) => sql`${id}`),
              sql`, `
            )})
              AND p.posting_status='POSTED'
              AND p.payment_date<=${effectiveAsOf}::date
              AND p.payment_date < MAKE_DATE(
                ml.year, ml.month,
                LEAST(EXTRACT(DAY FROM pc.start_date::date)::int,
                  EXTRACT(DAY FROM
                    DATE_TRUNC('MONTH', MAKE_DATE(ml.year,ml.month,1))
                    + INTERVAL '1 MONTH' - INTERVAL '1 DAY')::int)
              )
            GROUP BY p.ledger_row_id
          `)
          ).rows as Array<{ ledger_row_id: number; paid: string }>;
          const postedPrepaidMap = new Map(
            postedPrepaid.map((r) => [Number(r.ledger_row_id), toMoney(r.paid).toDecimalPlaces(2)])
          );
          // Any mismatch means an unreviewed previous payment, old voucher,
          // or stale cache. Fail closed; keep all cash/prepaid balances intact.
          for (const row of lockedPrepaid) {
            const actual = postedPrepaidMap.get(Number(row.id)) ?? new MoneyDecimal(0);
            if (
              !actual.eq(toMoney(row.paid_amount).toDecimalPlaces(2)) ||
              actual.gt(toMoney(row.expected_amount).toDecimalPlaces(2))
            ) {
              throw new Error("RENTAL_PREPAID_POSTED_PAYMENTS_DO_NOT_MATCH_MONTH");
            }
          }
          const expenseId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            shopExpenseAccountName,
            "Indirect Expense",
            "SHOP-RENT-EXP"
          );
          const prepaidId = await findOrCreateLedgerAccount(tx, companyId, "Prepaid Rent", "Asset", "PREP-RENT");
          const liabilityId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Accrued Rent Payable",
            "Liability",
            "ACCR-RENT-PAY"
          );

          const months = [...new Set(duePrepaid.map((r) => `${String(r.month).padStart(2, "0")}/${r.year}`))].sort();
          const periodLabel = months.length === 1 ? months[0] : `${months[0]}–${months[months.length - 1]}`;

          // Expense = full expected rent; Cr Prepaid Rent for the part paid in
          // advance, Cr Accrued Rent Payable for the remainder (partial prepay).
          const expectedOf = (r: (typeof duePrepaid)[number]) => toMoney(r.expectedAmount).toDecimalPlaces(2);
          const totalExpected = duePrepaid.reduce((s, r) => s.plus(expectedOf(r)), new MoneyDecimal(0));
          const totalPaid = duePrepaid.reduce(
            (s, r) =>
              s.plus(MoneyDecimal.min(postedPrepaidMap.get(Number(r.id)) ?? new MoneyDecimal(0), expectedOf(r))),
            new MoneyDecimal(0)
          );
          const totalUnpaid = MoneyDecimal.max(0, totalExpected.minus(totalPaid));

          const vDesc = `Prepaid rent recognized - ${companyId} - ${periodLabel}`;
          await postAccrualPassTx(tx, {
            companyId,
            module: moduleParam,
            pass: "prepaid-recognition",
            voucherDate: effectiveAsOf,
            description: vDesc,
            currency: batchCurrency,
            lines: [
              ...duePrepaid.map((r) => ({
                ledgerAccountId: expenseId,
                debit: expectedOf(r),
                narration: `Prepaid rent recognized - ${unitNameById.get(r.unitId) ?? `unit${r.unitId}`} - ${String(r.month).padStart(2, "0")}/${r.year}`,
              })),
              { ledgerAccountId: prepaidId, credit: totalPaid, narration: vDesc },
              { ledgerAccountId: liabilityId, credit: totalUnpaid, narration: vDesc },
            ],
            ledgerRowIds: duePrepaid.map((r) => r.id),
            options,
          });
          totals.accrued += duePrepaid.length;
        });
      }
    } catch (e: unknown) {
      const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
      logger.error(`[ERP/rental] prepaid recognition failed company ${companyId}: ${detail}`);
    }
  }
}
