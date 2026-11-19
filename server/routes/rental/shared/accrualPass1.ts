// Extracted from ./accrual.ts: a stage of postRentAccrualForCompany.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { propertyMonthlyLedger } from "@shared/schema";
import { eq, and, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import { findOrCreateLedgerAccount } from "./ledger";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { isRentMonthReadyToRecognize } from "../../../services/rental/rentRecognitionHold";
import { postAccrualPassTx } from "./accrual-posting";
import type { RentAccrualPostingOptions } from "./accrual-posting";
import type { loadRentAccrualContext } from "./accrualContext";

type LoadRentAccrualContextResult = Awaited<ReturnType<typeof loadRentAccrualContext>>;

export async function rentAccrualPass1({
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
  const {
    contractIds,
    curYear,
    curMonth,
    isFutureLinked,
    isDue,
    totals,
    isHistoricalHadiLinked,
    curDay,
    effectiveAsOf,
    batchCurrency,
    unitNameById,
  } = acx;

  // ── Pass 1: Standard accrual for SHOP/shared contracts ────────────────────
  // Skipped entirely if this company has no SHOP/shared contracts (contractIds empty).
  // Pass 2 (tenant prepaid) and Pass 3 (landlord deferred) run independently below.
  if (contractIds.length > 0) {
    // Fetch ALL rows that have no accrual voucher yet (paid OR unpaid).
    // Exclude prepaid rows — pass 2 handles those exclusively to avoid double-counting.
    const allUnaccrued = await db
      .select()
      .from(propertyMonthlyLedger)
      .where(
        and(
          inArray(propertyMonthlyLedger.contractId, contractIds),
          isNull(propertyMonthlyLedger.accrualVoucherId),
          eq(propertyMonthlyLedger.usedPrepaidAccount, false),
          eq(propertyMonthlyLedger.usedAdvanceAccount, false),
          sql`${propertyMonthlyLedger.expectedAmount}::numeric > 0`
        )
      );

    // Compute contract-level net outstanding so we don't accrue for contracts
    // that are fully covered by advance payments (outstanding ≤ 0).
    const unaccruedContractIds = [...new Set(allUnaccrued.map((r) => r.contractId))];
    const contractsWithPositiveOutstanding = new Set<number>();
    if (unaccruedContractIds.length > 0) {
      const outstandingRows = await db
        .select({
          contractId: propertyMonthlyLedger.contractId,
          expected: sql<string>`COALESCE(SUM(
          CASE WHEN (
            ${propertyMonthlyLedger.year} < ${curYear}
            OR (${propertyMonthlyLedger.year} = ${curYear} AND ${propertyMonthlyLedger.month} <= ${curMonth})
          ) THEN ${propertyMonthlyLedger.expectedAmount}::numeric ELSE 0 END
        ), 0)`,
          paid: sql<string>`COALESCE(SUM(${propertyMonthlyLedger.paidAmount}::numeric), 0)`,
        })
        .from(propertyMonthlyLedger)
        .where(inArray(propertyMonthlyLedger.contractId, unaccruedContractIds))
        .groupBy(propertyMonthlyLedger.contractId);

      for (const r of outstandingRows) {
        if (toMoney(r.expected).minus(toMoney(r.paid)).gt("0.005")) {
          contractsWithPositiveOutstanding.add(r.contractId);
        }
      }
    }

    // The owner's payment is not an expense recognition on HADI's books.
    // A future linked month needs a FULL accrual even if the owner was paid.
    for (const row of allUnaccrued) {
      if (isFutureLinked(row) && isDue(row)) {
        contractsWithPositiveOutstanding.add(row.contractId);
      }
    }

    // Count already-accrued rows for the "skipped" response metric
    const allAccruedForSkip = await db
      .select({ id: propertyMonthlyLedger.id })
      .from(propertyMonthlyLedger)
      .where(
        and(inArray(propertyMonthlyLedger.contractId, contractIds), isNotNull(propertyMonthlyLedger.accrualVoucherId))
      );
    totals.alreadyDone = allAccruedForSkip.length;

    // A reviewed historical month with a deleted accrual link must never re-accrue
    // just because a later month on the same contract becomes unpaid.
    const pendingRows = allUnaccrued.filter(
      (r) =>
        !isHistoricalHadiLinked(r) &&
        isRentMonthReadyToRecognize(r.notes, isDue(r)) &&
        contractsWithPositiveOutstanding.has(r.contractId)
    );

    logger.info(
      `[postRentAccrual] company=${companyId} unaccrued=${allUnaccrued.length} pendingDue=${pendingRows.length} alreadyDone=${totals.alreadyDone} curYear=${curYear} curMonth=${curMonth} curDay=${curDay} contractsWithPositiveOutstanding=${contractsWithPositiveOutstanding.size}`
    );
    if (pendingRows.length > 0) {
      logger.info(`[postRentAccrual] pendingRows sample`, {
        sample: pendingRows.slice(0, 3).map((r) => ({
          id: r.id,
          year: r.year,
          month: r.month,
          contractId: r.contractId,
          paid: r.paidAmount,
          expected: r.expectedAmount,
        })),
      });
    }

    // ── Pass 1 transaction ──
    if (pendingRows.length > 0) {
      try {
        await db.transaction(async (tx) => {
          // Lock ALL pending rows in one shot — SKIP LOCKED guards against races.
          // Bind each ID through Drizzle SQL fragments rather than interpolating
          // a comma-separated string; preserve row locks and skip-locked behavior.
          const pendingIds = pendingRows.map((r) => r.id);
          const idListSql = sql.join(
            pendingIds.map((id) => sql`${id}`),
            sql`, `
          );
          const lockResult = await tx.execute(
            sql`
              SELECT id, company_id, module, contract_id, expected_amount, paid_amount, unit_id, month, year
         FROM property_monthly_ledger
         WHERE id IN (${idListSql})
           AND accrual_voucher_id IS NULL
           AND expected_amount::numeric > 0
           AND used_advance_account = false
         FOR UPDATE SKIP LOCKED`
          );

          if (!lockResult.rows || lockResult.rows.length === 0) return;

          type LockedRow = {
            id: number;
            contract_id: number;
            company_id: number;
            module: string;
            expected_amount: string;
            paid_amount: string;
            unit_id: number;
            month: number;
            year: number;
          };
          const lockedRows = lockResult.rows as LockedRow[];

          // FIX #4: query actual POSTED payments (payment_date <= effectiveAsOf) per locked row
          //          instead of the potentially-stale paid_amount cache column.
          const lockedIdList = sql.join(
            lockedRows.map((r) => sql`${r.id}`),
            sql`, `
          );
          const paidQueryResult = await tx.execute(
            sql`
              SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
               FROM property_payments
               WHERE ledger_row_id IN (${lockedIdList})
                 AND posting_status = 'POSTED'
                 AND payment_date <= ${effectiveAsOf}
               GROUP BY ledger_row_id`
          );
          const actualPaidByRowId = new Map(
            paidQueryResult.rows.map((r) => [Number(r.ledger_row_id), toMoney(r.total_paid as string)])
          );

          type Entry = { id: number; amount: ReturnType<typeof toMoney>; unitId: number; month: number; year: number };
          const entries: Entry[] = [];
          for (const locked of lockedRows) {
            const expected = toMoney(locked.expected_amount).toDecimalPlaces(2);
            const paid = actualPaidByRowId.get(Number(locked.id)) ?? new MoneyDecimal(0);
            // The Properties owner's cash receipt cannot remove HADI expense.
            const amount = isFutureLinked({
              contractId: Number(locked.contract_id),
              year: Number(locked.year),
              month: Number(locked.month),
            })
              ? expected
              : expected.minus(paid).toDecimalPlaces(2);
            if (!amount.gt(0)) continue;
            entries.push({
              id: Number(locked.id),
              amount,
              unitId: Number(locked.unit_id),
              month: Number(locked.month),
              year: Number(locked.year),
            });
          }
          if (entries.length === 0) return;

          const totalAmount = entries.reduce((s, e) => s.plus(e.amount), new MoneyDecimal(0));

          const expenseAccountId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            shopExpenseAccountName,
            "Indirect Expense",
            "SHOP-RENT-EXP"
          );
          const liabilityAccountId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Accrued Rent Payable",
            "Liability",
            "ACCR-RENT-PAY"
          );

          // Build a period label for the voucher description
          const months = [...new Set(entries.map((e) => `${String(e.month).padStart(2, "0")}/${e.year}`))].sort();
          const periodLabel = months.length === 1 ? months[0] : `${months[0]}–${months[months.length - 1]}`;
          const voucherDesc = `Rent accrual - ${companyId} - ${periodLabel}`;

          // ONE voucher for all rows; one debit line per row so the journal is
          // traceable by unit + month, one combined credit to Accrued Rent Payable.
          await postAccrualPassTx(tx, {
            companyId,
            module: moduleParam,
            pass: "accrual",
            voucherDate: effectiveAsOf,
            description: voucherDesc,
            currency: batchCurrency,
            lines: [
              ...entries.map((e) => ({
                ledgerAccountId: expenseAccountId,
                debit: e.amount,
                narration: `Rent accrual - ${unitNameById.get(e.unitId) ?? `unit${e.unitId}`} - ${String(e.month).padStart(2, "0")}/${e.year}`,
              })),
              { ledgerAccountId: liabilityAccountId, credit: totalAmount, narration: voucherDesc },
            ],
            ledgerRowIds: entries.map((e) => e.id),
            options,
          });

          totals.accrued += entries.length;
        });
      } catch (e: unknown) {
        // Log the full error — Drizzle formats errors as "Failed query:\n<SQL>\n<pg error>",
        // so split("\n")[0] always shows the useless header.  Log all lines instead.
        const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
        logger.error(`[ERP/rental] batch accrual failed company ${companyId}: ${detail}`);
        // intentional fall-through: partial failure logged, continue to recognition passes
      }
    } // end if (pendingRows.length > 0)
  }
}
