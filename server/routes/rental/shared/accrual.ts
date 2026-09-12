import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { getUtcTodayString, isRentalPeriodDue } from "../../../services/rental/rentalPeriodService";
import { propertyUnits, propertyContracts, propertyMonthlyLedger, vouchers, voucherEntries } from "@shared/schema";
import { eq, and, sql, inArray, isNull, isNotNull, ne } from "drizzle-orm";
import { RentalModule, findOrCreateLedgerAccount } from "./ledger";
import { ensureMonthlyLedgerRows } from "./monthly-rows";

export async function ensureMonthlyForCompany(companyId: number, module: RentalModule, asOfDate?: string) {
  const active = await db
    .select({ id: propertyContracts.id })
    .from(propertyContracts)
    .where(
      and(
        eq(propertyContracts.companyId, companyId),
        eq(propertyContracts.module, module),
        eq(propertyContracts.status, "ACTIVE")
      )
    );
  for (const c of active) await ensureMonthlyLedgerRows(c.id, asOfDate);
}

/**
 * Posts accrual journal vouchers (Dr Rent Expense / Cr Accrued Rent Payable) for
 * all unpaid ERP SHOP ledger rows where:
 *   - accrualVoucherId IS NULL (not yet accrued)
 *   - paidAmount < expectedAmount (still has an outstanding balance)
 *
 * Scoped to ERP module + SHOP unit type only. Safe to call for any contract —
 * it returns 0 immediately if the contract is not an ERP SHOP contract.
 *
 * Returns { accrued, skipped } where accrued = newly-posted rows,
 * skipped = due+unpaid rows that already had an accrual (nothing to do).
 */
export async function postRentAccrualForContract(
  contractId: number,
  shopExpenseAccountName: string
): Promise<{ accrued: number; skipped: number }> {
  // Load contract and verify it is an ERP contract
  const [contract] = await db
    .select()
    .from(propertyContracts)
    .where(and(eq(propertyContracts.id, contractId), eq(propertyContracts.module, "ERP")));
  if (!contract) return { accrued: 0, skipped: 0 };

  // Verify the unit is SHOP type
  const [unit] = await db
    .select({ unitType: propertyUnits.unitType })
    .from(propertyUnits)
    .where(eq(propertyUnits.id, contract.unitId));
  if (!unit || unit.unitType !== "SHOP") return { accrued: 0, skipped: 0 };

  return postRentAccrualForCompany(contract.companyId, shopExpenseAccountName);
}

/**
 * Posts ONE combined accrual journal (Dr Rent Expense / Cr Accrued Rent Payable)
 * for ALL active ERP SHOP contracts of the company that have due, unpaid, unaccrued
 * ledger rows.
 *
 * All rows that are newly accrued point to the same voucher ID so the daybook
 * shows a single journal entry instead of one per unit/month.
 *
 * Returns { accrued: N, skipped: M } where:
 *   accrued = number of ledger rows newly stamped with the combined voucher
 *   skipped = due+unpaid rows already accrued in a prior run
 */
export async function postRentAccrualForCompany(
  companyId: number,
  shopExpenseAccountName: string,
  moduleParam: string = "ERP",
  incomeAccountName: string = "Rental Income",
  asOfDate?: string
): Promise<{ accrued: number; skipped: number }> {
  // FIX #4: use explicit asOfDate instead of hidden new Date() so accruals
  //          are reproducible and safe to call from any date context.
  const effectiveAsOf = asOfDate ?? getUtcTodayString();
  // Load all active SHOP contracts owned by this company for the given module
  const shopContracts = await db
    .select({
      id: propertyContracts.id,
      unitId: propertyContracts.unitId,
      unitNumber: propertyUnits.unitNumber,
      startDate: propertyContracts.startDate,
      currency: propertyContracts.currency,
    })
    .from(propertyContracts)
    .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
    .where(
      and(
        eq(propertyContracts.companyId, companyId),
        eq(propertyContracts.module, moduleParam),
        eq(propertyContracts.status, "ACTIVE"),
        eq(propertyUnits.unitType, "SHOP")
      )
    );

  // Also load shared contracts — units rented FROM another company (linkedCompanyId = this company).
  // These always appear in the Shops view regardless of their unit type, so they should
  // be accrued the same way (Dr Rent Expense / Cr Accrued Rent Payable).
  const sharedContracts = await db
    .select({
      id: propertyContracts.id,
      unitId: propertyContracts.unitId,
      unitNumber: propertyUnits.unitNumber,
      startDate: propertyContracts.startDate,
      currency: propertyContracts.currency,
    })
    .from(propertyContracts)
    .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
    .where(and(eq(propertyContracts.linkedCompanyId, companyId), eq(propertyContracts.status, "ACTIVE")));

  // Deduplicate in case a contract somehow appears in both (shouldn't happen, but be safe)
  const seen = new Set<number>();
  const allContracts = [...shopContracts, ...sharedContracts].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  // If there are no SHOP/shared contracts, pass 1 and pass 2 will no-op via
  // their own guards (contractIds.length === 0), but pass 3 (landlord deferred)
  // must still run for landlord-only companies outside PROPERTIES mode.

  // Determine the dominant currency for this batch of contracts (fallback USD).
  const currencyCount = new Map<string, number>();
  for (const c of allContracts) {
    const cur = c.currency || "USD";
    currencyCount.set(cur, (currencyCount.get(cur) ?? 0) + 1);
  }
  const batchCurrency = currencyCount.size > 0 ? [...currencyCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : "USD";

  const contractIds = allContracts.map((c) => c.id);

  // Unit name (display label) keyed by unitId
  const unitNameById = new Map(allContracts.map((c) => [c.unitId, c.unitNumber]));

  // Billing day (day-of-month) keyed by contractId
  const billingDayByContract = new Map(allContracts.map((c) => [c.id, new Date(c.startDate).getUTCDate()]));

  const [asY, asM, asD] = effectiveAsOf.split("-").map(Number);
  const curYear = asY;
  const curMonth = asM;
  const curDay = asD;

  // isDue: billing-day-aware using explicit effectiveAsOf (not server-local now())
  const isDue = (row: { year: number; month: number; contractId: number }) => {
    const billingDay = billingDayByContract.get(row.contractId) ?? 1;
    return isRentalPeriodDue(row.year, row.month, billingDay, effectiveAsOf);
  };

  let accrued = 0;
  let alreadyDone = 0;

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
        if (Number(r.expected) - Number(r.paid) > 0.005) {
          contractsWithPositiveOutstanding.add(r.contractId);
        }
      }
    }

    // Count already-accrued rows for the "skipped" response metric
    const allAccruedForSkip = await db
      .select({ id: propertyMonthlyLedger.id })
      .from(propertyMonthlyLedger)
      .where(
        and(inArray(propertyMonthlyLedger.contractId, contractIds), isNotNull(propertyMonthlyLedger.accrualVoucherId))
      );
    alreadyDone = allAccruedForSkip.length;

    const pendingRows = allUnaccrued.filter((r) => isDue(r) && contractsWithPositiveOutstanding.has(r.contractId));

    logger.info(
      `[postRentAccrual] company=${companyId} unaccrued=${allUnaccrued.length} pendingDue=${pendingRows.length} alreadyDone=${alreadyDone} curYear=${curYear} curMonth=${curMonth} curDay=${curDay} contractsWithPositiveOutstanding=${contractsWithPositiveOutstanding.size}`
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
          // Use IN (...) with a literal id list (all values are trusted integers from
          // the DB) rather than ANY($n::int[]) — Drizzle does not serialize a JS
          // array through the sql`` tag in a way pg accepts with ::int[] casting.
          const pendingIds = pendingRows.map((r) => r.id);
          const idListSql = pendingIds.join(","); // safe: all are DB integers
          const lockResult = await tx.execute(
            sql.raw(
              `SELECT id, expected_amount, paid_amount, unit_id, month, year
         FROM property_monthly_ledger
         WHERE id IN (${idListSql})
           AND accrual_voucher_id IS NULL
           AND expected_amount::numeric > 0
           AND used_advance_account = false
         FOR UPDATE SKIP LOCKED`
            )
          );

          if (!lockResult.rows || lockResult.rows.length === 0) return;

          type LockedRow = {
            id: number;
            expected_amount: string;
            paid_amount: string;
            unit_id: number;
            month: number;
            year: number;
          };
          const lockedRows = lockResult.rows as LockedRow[];

          // FIX #4: query actual POSTED payments (payment_date <= effectiveAsOf) per locked row
          //          instead of the potentially-stale paid_amount cache column.
          const lockedIdList = lockedRows.map((r) => Number(r.id)).join(",");
          const paidQueryResult = await tx.execute(
            sql.raw(
              `SELECT ledger_row_id, COALESCE(SUM(amount::numeric), 0) AS total_paid
               FROM property_payments
               WHERE ledger_row_id IN (${lockedIdList})
                 AND posting_status = 'POSTED'
                 AND payment_date <= '${effectiveAsOf}'
               GROUP BY ledger_row_id`
            )
          );
          const actualPaidByRowId = new Map<number, number>(
            ((paidQueryResult.rows)).map((r) => [Number(r.ledger_row_id), Number(r.total_paid)])
          );

          type Entry = { id: number; amount: number; unitId: number; month: number; year: number };
          const entries: Entry[] = [];
          for (const locked of lockedRows) {
            const expected = Number(locked.expected_amount);
            const paid = actualPaidByRowId.get(Number(locked.id)) ?? 0;
            const amount = expected - paid;
            if (amount <= 0) continue;
            entries.push({
              id: Number(locked.id),
              amount,
              unitId: Number(locked.unit_id),
              month: Number(locked.month),
              year: Number(locked.year),
            });
          }
          if (entries.length === 0) return;

          const totalAmount = entries.reduce((s, e) => s + e.amount, 0);

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

          // ONE voucher for all rows
          const [v] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `ACCR-RENT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              voucherType: "Journal",
              voucherDate: effectiveAsOf,
              description: voucherDesc,
              totalAmount: String(totalAmount),
              currency: batchCurrency,
              sourceModule: moduleParam,
            })
            .returning();

          // One debit entry per row so the journal is traceable by unit + month
          const debitEntries = entries.map((e) => ({
            voucherId: v.id,
            ledgerAccountId: expenseAccountId,
            debitAmount: String(e.amount),
            creditAmount: "0",
            narration: `Rent accrual - ${unitNameById.get(e.unitId) ?? `unit${e.unitId}`} - ${String(e.month).padStart(2, "0")}/${e.year}`,
          }));

          // One combined credit to Accrued Rent Payable
          await tx.insert(voucherEntries).values([
            ...debitEntries,
            {
              voucherId: v.id,
              ledgerAccountId: liabilityAccountId,
              debitAmount: "0",
              creditAmount: String(totalAmount),
              narration: voucherDesc,
            },
          ]);

          // Stamp every locked row with the single voucher ID
          await tx
            .update(propertyMonthlyLedger)
            .set({ accrualVoucherId: v.id })
            .where(
              inArray(
                propertyMonthlyLedger.id,
                entries.map((e) => e.id)
              )
            );

          accrued += entries.length;
        });
      } catch (e: unknown) {
        // Log the full error — Drizzle formats errors as "Failed query:\n<SQL>\n<pg error>",
        // so split("\n")[0] always shows the useless header.  Log all lines instead.
        const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
        logger.error(`[ERP/rental] batch accrual failed company ${companyId}: ${detail}`);
        // intentional fall-through: partial failure logged, continue to recognition passes
      }
    } // end if (pendingRows.length > 0)
  } // end if (contractIds.length > 0) — Pass 1

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
      const dueAdvanceRows = advanceRows.filter((r) => isDue(r));
      if (dueAdvanceRows.length > 0) {
        await db.transaction(async (tx) => {
          const pendingIds15 = dueAdvanceRows.map((r) => r.id);
          const idListSql15 = pendingIds15.join(",");
          const lock15 = await tx.execute(
            sql.raw(
              `SELECT id, expected_amount, paid_amount, unit_id, month, year
             FROM property_monthly_ledger
             WHERE id IN (${idListSql15})
               AND accrual_voucher_id IS NULL
               AND used_advance_account = true
             FOR UPDATE SKIP LOCKED`
            )
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

          let totalExpense15 = 0;
          let totalAdvCredit15 = 0;
          let totalApCredit15 = 0;
          const debitEntries15 = [];

          for (const r of locked15) {
            const expected = Number(r.expected_amount);
            const paid = Number(r.paid_amount || "0");
            const advCredit = Math.min(paid, expected);
            const apCredit = Math.max(0, expected - paid);
            const narr15 = `Advance rent recognition - unit${r.unit_id} - ${String(Number(r.month)).padStart(2, "0")}/${r.year}`;
            debitEntries15.push({
              ledgerAccountId: expenseAcctId,
              debitAmount: String(expected),
              creditAmount: "0",
              narration: narr15,
            });
            totalExpense15 += expected;
            totalAdvCredit15 += advCredit;
            totalApCredit15 += apCredit;
          }

          const [v15] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `ADV-REC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              voucherType: "Journal",
              voucherDate: effectiveAsOf,
              description: desc15,
              totalAmount: String(totalExpense15),
              currency: batchCurrency,
              sourceModule: moduleParam,
            })
            .returning();

          const allEntries15 = debitEntries15.map((e) => ({ ...e, voucherId: v15.id }));
          if (totalAdvCredit15 > 0.005) {
            allEntries15.push({
              voucherId: v15.id,
              ledgerAccountId: advanceAcctId,
              debitAmount: "0",
              creditAmount: String(totalAdvCredit15),
              narration: desc15,
            });
          }
          if (totalApCredit15 > 0.005) {
            allEntries15.push({
              voucherId: v15.id,
              ledgerAccountId: liabilityAcctId,
              debitAmount: "0",
              creditAmount: String(totalApCredit15),
              narration: desc15,
            });
          }
          await tx.insert(voucherEntries).values(allEntries15);
          await tx
            .update(propertyMonthlyLedger)
            .set({ accrualVoucherId: v15.id })
            .where(
              inArray(
                propertyMonthlyLedger.id,
                locked15.map((r) => Number(r.id))
              )
            );
          accrued += locked15.length;
        });
      }
    } catch (e: unknown) {
      const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
      logger.error(`[ERP/rental] advance recognition pass failed company ${companyId}: ${detail}`);
    }
  } // end Pass 1.5

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
            eq(propertyMonthlyLedger.usedPrepaidAccount, true)
          )
        );
      const duePrepaid = prepaidUnaccrued.filter((r) => isDue(r));
      if (duePrepaid.length > 0) {
        await db.transaction(async (tx) => {
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

          // Total expense to recognize = full expected rent (prepaid portion + any outstanding)
          const totalExpected = duePrepaid.reduce((s, r) => s + Number(r.expectedAmount), 0);
          const totalPaid = duePrepaid.reduce(
            (s, r) => s + Math.min(Number(r.paidAmount), Number(r.expectedAmount)),
            0
          );
          const totalUnpaid = Math.max(0, totalExpected - totalPaid);

          const vDesc = `Prepaid rent recognized - ${companyId} - ${periodLabel}`;
          const [v] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `PREP-RENT-REC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              voucherType: "Journal",
              voucherDate: effectiveAsOf,
              description: vDesc,
              totalAmount: String(totalExpected),
              currency: batchCurrency,
              sourceModule: moduleParam,
            })
            .returning();

          // One debit line per row (Rent Expense = full expected)
          const entries = duePrepaid.map((r) => {
            const rowLabel = `${unitNameById.get(r.unitId) ?? `unit${r.unitId}`} - ${String(r.month).padStart(2, "0")}/${r.year}`;
            return {
              voucherId: v.id,
              ledgerAccountId: expenseId,
              debitAmount: String(Number(r.expectedAmount)),
              creditAmount: "0",
              narration: `Prepaid rent recognized - ${rowLabel}`,
            };
          });

          // Credit Prepaid Rent for the portion already paid in advance
          if (totalPaid > 0.005) {
            entries.push({
              voucherId: v.id,
              ledgerAccountId: prepaidId,
              debitAmount: "0",
              creditAmount: totalPaid.toFixed(2),
              narration: vDesc,
            });
          }
          // Credit Accrued Rent Payable for the remainder (partial-prepay case)
          if (totalUnpaid > 0.005) {
            entries.push({
              voucherId: v.id,
              ledgerAccountId: liabilityId,
              debitAmount: "0",
              creditAmount: totalUnpaid.toFixed(2),
              narration: vDesc,
            });
          }

          await tx.insert(voucherEntries).values(entries);
          await tx
            .update(propertyMonthlyLedger)
            .set({ accrualVoucherId: v.id })
            .where(
              inArray(
                propertyMonthlyLedger.id,
                duePrepaid.map((r) => r.id)
              )
            );
          accrued += duePrepaid.length;
        });
      }
    } catch (e: unknown) {
      const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
      logger.error(`[ERP/rental] prepaid recognition failed company ${companyId}: ${detail}`);
    }
  }

  // Properties landlord receipts are recognised entirely when cash is received.
  // There is no Deferred Rent Revenue account or later landlord recognition pass.
  // SHOP/shared tenant expense accruals above still run normally in PROPERTIES mode.
  if (moduleParam === "PROPERTIES") {
    return { accrued, skipped: alreadyDone };
  }

  // ── Pass 3: Landlord deferred revenue recognition ─────────────────────────
  // For rows where usedPrepaidAccount=true, accrualVoucherId IS NULL, and isDue:
  //   Dr Deferred Rent Revenue / Cr Rent Income
  try {
    const landlordContracts = await db
      .select({
        id: propertyContracts.id,
        unitId: propertyContracts.unitId,
        unitNumber: propertyUnits.unitNumber,
        startDate: propertyContracts.startDate,
        currency: propertyContracts.currency,
      })
      .from(propertyContracts)
      .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
      .where(
        and(
          eq(propertyContracts.companyId, companyId),
          eq(propertyContracts.module, moduleParam),
          eq(propertyContracts.status, "ACTIVE"),
          ne(propertyUnits.unitType, "SHOP")
        )
      );
    if (landlordContracts.length > 0) {
      const landlordIds = landlordContracts.map((c) => c.id);
      const landlordUnitNames = new Map(landlordContracts.map((c) => [c.unitId, c.unitNumber]));
      const landlordBillingDay = new Map(landlordContracts.map((c) => [c.id, new Date(c.startDate).getUTCDate()]));
      const isLandlordDue = (row: { year: number; month: number; contractId: number }) => {
        const bd = landlordBillingDay.get(row.contractId) ?? 1;
        return isRentalPeriodDue(row.year, row.month, bd, effectiveAsOf);
      };
      const deferredUnaccrued = await db
        .select()
        .from(propertyMonthlyLedger)
        .where(
          and(
            inArray(propertyMonthlyLedger.contractId, landlordIds),
            isNull(propertyMonthlyLedger.accrualVoucherId),
            eq(propertyMonthlyLedger.usedPrepaidAccount, true)
          )
        );
      const dueDeferred = deferredUnaccrued.filter((r) => isLandlordDue(r));
      if (dueDeferred.length > 0) {
        const lCurrCount = new Map<string, number>();
        for (const c of landlordContracts) {
          const cur = c.currency || "USD";
          lCurrCount.set(cur, (lCurrCount.get(cur) ?? 0) + 1);
        }
        const lBatchCurrency = [...lCurrCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
        await db.transaction(async (tx) => {
          // Recognize only the collected (deferred) portion — paidAmount, not expectedAmount.
          // Uncollected rent has no deferred account entry, so no recognition needed for it.
          const totalDeferred = dueDeferred.reduce(
            (s, r) => s + Math.min(Number(r.paidAmount), Number(r.expectedAmount)),
            0
          );
          if (totalDeferred < 0.005) return; // nothing to recognize
          const incomeId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            incomeAccountName,
            "Income",
            "RENT-INC",
            "Indirect Income"
          );
          const deferredId = await findOrCreateLedgerAccount(
            tx,
            companyId,
            "Deferred Rent Revenue",
            "Liability",
            "DEF-RENT-REV"
          );
          const months = [...new Set(dueDeferred.map((r) => `${String(r.month).padStart(2, "0")}/${r.year}`))].sort();
          const periodLabel = months.length === 1 ? months[0] : `${months[0]}–${months[months.length - 1]}`;
          const vDesc = `Deferred rent recognized - ${companyId} - ${periodLabel}`;
          const [v] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherNumber: `DEF-RENT-REC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              voucherType: "Journal",
              voucherDate: effectiveAsOf,
              description: vDesc,
              totalAmount: String(totalDeferred),
              currency: lBatchCurrency,
              sourceModule: moduleParam,
            })
            .returning();
          // One debit line per row for only the deferred (collected) portion
          const debitEntries = dueDeferred
            .map((r) => ({
              amount: Math.min(Number(r.paidAmount), Number(r.expectedAmount)),
              label: `${landlordUnitNames.get(r.unitId) ?? `unit${r.unitId}`} - ${String(r.month).padStart(2, "0")}/${r.year}`,
            }))
            .filter((e) => e.amount > 0.005)
            .map((e) => ({
              voucherId: v.id,
              ledgerAccountId: deferredId,
              debitAmount: e.amount.toFixed(2),
              creditAmount: "0",
              narration: `Deferred rent recognized - ${e.label}`,
            }));
          await tx.insert(voucherEntries).values([
            ...debitEntries,
            {
              voucherId: v.id,
              ledgerAccountId: incomeId,
              debitAmount: "0",
              creditAmount: totalDeferred.toFixed(2),
              narration: vDesc,
            },
          ]);
          await tx
            .update(propertyMonthlyLedger)
            .set({ accrualVoucherId: v.id })
            .where(
              inArray(
                propertyMonthlyLedger.id,
                dueDeferred.map((r) => r.id)
              )
            );
        });
      }
    }
  } catch (e: unknown) {
    const detail = (getErrorMessage(e) ?? String(e)).replace(/\n/g, " | ");
    logger.error(`[ERP/rental] deferred recognition failed company ${companyId}: ${detail}`);
  }

  return { accrued, skipped: alreadyDone };
}
