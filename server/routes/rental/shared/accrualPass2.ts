// Extracted from ./accrual.ts: a stage of postRentAccrualForCompany.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { propertyMonthlyLedger } from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { findOrCreateLedgerAccount } from "./ledger";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { isRentMonthReadyToRecognize } from "../../../services/rental/rentRecognitionHold";
import { postAccrualPassTx } from "./accrual-posting";
import type { RentAccrualPostingOptions } from "./accrual-posting";
import type { loadRentAccrualContext } from "./accrualContext";

type LoadRentAccrualContextResult = Awaited<ReturnType<typeof loadRentAccrualContext>>;

export async function rentAccrualPass2({
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
  const { contractIds, isDue, effectiveAsOf, batchCurrency, totals } = acx; // end if (contractIds.length > 0) — Pass 1

  // ── Pass 1.5: Advance Rent Paid recognition ───────────────────────────────
  // When a payment is made for a current/due month BEFORE the accrual runs,
  // the payment uses Dr Advance Rent Paid / Cr Cash (visible in Net Position).
  // Pass 1.5 recognises the expense: Dr Rent Expense / Cr Advance Rent Paid.
  // Any remaining unpaid portion is also credited to Accrued Rent Payable.
  if (contractIds.length > 0) {
    try {
      const advanceRows = await db
        .select()
        .from(propertyMonthlyLedger)
        .where(
          and(
            inArray(propertyMonthlyLedger.contractId, contractIds),
            isNull(propertyMonthlyLedger.accrualVoucherId),
            eq(propertyMonthlyLedger.usedAdvanceAccount, true),
            sql`${propertyMonthlyLedger.expectedAmount}::numeric > 0`
          )
        );
      // Holds also protect the advance-recognition path: a mixed batch must not
      // cause historical, already-recognized months to be posted again.
      const dueAdvanceRows = advanceRows.filter((r) => isRentMonthReadyToRecognize(r.notes, isDue(r)));
      if (dueAdvanceRows.length > 0) {
        await db.transaction(async (tx) => {
          const pendingIds15 = dueAdvanceRows.map((r) => r.id);
          const idListSql15 = sql.join(
            pendingIds15.map((id) => sql`${id}`),
            sql`, `
          );
          const lock15 = await tx.execute(
            sql`
              SELECT id, expected_amount, paid_amount, unit_id, month, year
             FROM property_monthly_ledger
             WHERE id IN (${idListSql15})
               AND accrual_voucher_id IS NULL
               AND used_advance_account = true
             FOR UPDATE SKIP LOCKED`
          );
          if (!lock15.rows || lock15.rows.length === 0) return;
          type LR15 = {
            id: number;
            expected_amount: string;
            paid_amount: string;
            unit_id: number;
            month: number;
            year: number;
          };
          const locked15 = lock15.rows as LR15[];

          const expenseAcctId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            shopExpenseAccountName,
            "Indirect Expense",
            "SHOP-RENT-EXP"
          );
          const advanceAcctId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Advance Rent Paid",
            "Asset",
            "ADV-RENT-PAID"
          );
          const liabilityAcctId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Accrued Rent Payable",
            "Liability",
            "ACCR-RENT-PAY"
          );

          const months15 = [
            ...new Set(locked15.map((r) => `${String(Number(r.month)).padStart(2, "0")}/${r.year}`)),
          ].sort();
          const period15 = months15.length === 1 ? months15[0] : `${months15[0]}–${months15[months15.length - 1]}`;
          const desc15 = `Advance rent recognition - ${companyId} - ${period15}`;

          let totalAdvCredit15 = new MoneyDecimal(0);
          let totalApCredit15 = new MoneyDecimal(0);
          const debitEntries15 = [];

          for (const r of locked15) {
            const expected = toMoney(r.expected_amount).toDecimalPlaces(2);
            const paid = toMoney(r.paid_amount).toDecimalPlaces(2);
            const advCredit = MoneyDecimal.min(paid, expected);
            const apCredit = MoneyDecimal.max(0, expected.minus(paid));
            const narr15 = `Advance rent recognition - unit${r.unit_id} - ${String(Number(r.month)).padStart(2, "0")}/${r.year}`;
            debitEntries15.push({ ledgerAccountId: expenseAcctId, debit: expected, narration: narr15 });
            totalAdvCredit15 = totalAdvCredit15.plus(advCredit);
            totalApCredit15 = totalApCredit15.plus(apCredit);
          }

          await postAccrualPassTx(tx, {
            companyId,
            module: moduleParam,
            pass: "advance-recognition",
            voucherDate: effectiveAsOf,
            description: desc15,
            currency: batchCurrency,
            lines: [
              ...debitEntries15,
              { ledgerAccountId: advanceAcctId, credit: totalAdvCredit15, narration: desc15 },
              { ledgerAccountId: liabilityAcctId, credit: totalApCredit15, narration: desc15 },
            ],
            ledgerRowIds: locked15.map((r) => Number(r.id)),
            options,
          });
          totals.accrued += locked15.length;
        });
      }
    } catch (e: unknown) {
      const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
      logger.error(`[ERP/rental] advance recognition pass failed company ${companyId}: ${detail}`);
    }
  }
}
