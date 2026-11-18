// Extracted from ./rentalAccrualConfigRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  HADI_HISTORICAL_ACCRUAL_GUARD,
  isHadiHistoricAccrualRepair,
} from "../../services/rental/hadiLinkedRentProtection";
import { runRentalReconciliation } from "../../services/rental/rentalReconciliationService";
import { logger } from "../../lib/logger";
import { ensureMonthlyForCompany, getCompanyId, postRentAccrualForCompany, type RentalModule } from "./shared";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  ledgerAccounts,
  propertyContracts,
  propertyMonthlyLedger,
  propertyPayments,
  propertyUnits,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { retireVouchersTx, sessionRetirementActor } from "../../services/accounting/voucherRetirement";
import { postErpVoucherTx, sessionPostingActor } from "../../services/accounting/erpVoucherPosting";
import { MoneyDecimal, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import {
  correctedLedgerRowNarrations,
  ledgerRowsKey,
  registerRentalAccrualConfigRoutesStep1,
} from "./correctedLedgerRowNarrations";

export function registerRentalAccrualConfigRoutesStep2(
  { tag }: Pick<Awaited<ReturnType<typeof registerRentalAccrualConfigRoutesStep1>>, "tag">,
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  app.post(`${urlPrefix}/re-accrue`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // HADI historical rent is already reconciled in its original vouchers.
      // Do not create reversal/correction journals or reset any old month links.
      if (isHadiHistoricAccrualRepair(companyId, module)) {
        return res.status(409).json(HADI_HISTORICAL_ACCRUAL_GUARD);
      }

      await ensureMonthlyForCompany(companyId, module);

      // 1. Find all active SHOP contract IDs for this company (module-aware)
      const shopContracts = await db
        .select({ id: propertyContracts.id })
        .from(propertyContracts)
        .innerJoin(propertyUnits, eq(propertyUnits.id, propertyContracts.unitId))
        .where(
          and(
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module),
            eq(propertyContracts.status, "ACTIVE"),
            eq(propertyUnits.unitType, "SHOP")
          )
        );

      // Do not post new corrective journals for months whose accrual links
      // point to deleted vouchers. Such months may already be fully expensed.
      const audit = await runRentalReconciliation(companyId, module, new Date().toISOString().slice(0, 10));
      if (audit.mismatches.some((m) => m.type === "D")) {
        return res.status(409).json({
          code: "RENTAL_DANGLING_ACCRUAL_REQUIRES_REVIEW",
          message: "Deleted accrual voucher links require a historical ledger review before re-accruing.",
        });
      }

      // 1b. Phantom-accrual repair (ALL months, historical + current).
      //
      // Problem: when a payment is recorded BEFORE the accrual runs, the payment
      // posts  Dr Rent Expense / Cr Cash  (no AP entry).  If the accrual is run
      // later it posts  Dr Rent Expense / Cr AP  using the FULL expectedAmount,
      // leaving a phantom AP credit with no matching debit — inflating the
      // liability by exactly the pre-paid amount.
      //
      // Fix: for every accrued ledger row whose payment voucher(s) never debited
      // Accrued Rent Payable, post a correcting journal:
      //   Dr Accrued Rent Payable  paid_amount
      //   Cr Rent Expense          paid_amount
      //
      // This removes the phantom AP and the duplicate expense entry in one shot
      // without touching the original accrual or payment vouchers.
      //
      // Net result for a fully-pre-paid row (paid = expected):
      //   Dr Expense = old_accrual + payment − correction = expected ✓
      //   Cr AP      = old_accrual − correction           = 0        ✓
      //
      // Net result for a partially-pre-paid row (paid < expected):
      //   Cr AP      = old_accrual − correction = expected − paid    ✓ (outstanding)
      //   Dr Expense = old_accrual + payment − correction = expected ✓
      if (shopContracts.length > 0) {
        const contractIds = shopContracts.map((c) => c.id);

        // Find AP account for this company
        const [apAcct] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "ACCR-RENT-PAY")));

        const [expAcct] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "SHOP-RENT-EXP")));

        if (apAcct && expAcct) {
          // All accrued rows with some payment (candidates for phantom)
          const candidateRows = await db
            .select({
              id: propertyMonthlyLedger.id,
              expectedAmount: propertyMonthlyLedger.expectedAmount,
              paidAmount: propertyMonthlyLedger.paidAmount,
            })
            .from(propertyMonthlyLedger)
            .where(
              and(
                inArray(propertyMonthlyLedger.contractId, contractIds),
                isNotNull(propertyMonthlyLedger.accrualVoucherId),
                sql`${propertyMonthlyLedger.paidAmount}::numeric > 0`
              )
            );

          // For each candidate, check whether any payment voucher debited AP
          // (= post-accrual payment, already correct).  If no AP debit found,
          // the payment was pre-accrual and the phantom fix is needed.
          let phantomFixTotal = new MoneyDecimal(0);
          type PhantomRow = { id: number; correction: Decimal };
          const phantomRows: PhantomRow[] = [];

          for (const row of candidateRows) {
            const paid = toMoney(row.paidAmount).toDecimalPlaces(2);
            if (!paid.gt(0)) continue;

            // Find payment voucher IDs for this ledger row
            const paymentVouchers = await db
              .select({ voucherId: propertyPayments.voucherId })
              .from(propertyPayments)
              .where(eq(propertyPayments.ledgerRowId, row.id));

            const payVoucherIds = paymentVouchers
              .map((p) => p.voucherId)
              .filter((id): id is number => id !== null && id !== undefined);

            if (payVoucherIds.length === 0) continue;

            // Check if any of those vouchers have a debit to AP
            const [apDebitEntry] = await db
              .select({ id: voucherEntries.id })
              .from(voucherEntries)
              .where(
                and(
                  inArray(voucherEntries.voucherId, payVoucherIds),
                  eq(voucherEntries.ledgerAccountId, apAcct.id),
                  sql`${voucherEntries.debitAmount}::numeric > 0`
                )
              )
              .limit(1);

            // Also check for AP-CLEAR auto-clearing journals linked to these payment vouchers.
            // New payment flow posts a separate journal (voucherNumber = "AP-CLEAR-{payVoucherId}")
            // with the AP debit instead of embedding it in the payment voucher itself.
            let apClearJournalDebit = false;
            if (!apDebitEntry) {
              for (const pvId of payVoucherIds) {
                const [clj] = await db
                  .select({ id: vouchers.id })
                  .from(vouchers)
                  .where(
                    and(
                      eq(vouchers.companyId, companyId),
                      eq(vouchers.voucherNumber, `AP-CLEAR-${pvId}`),
                      isNull(vouchers.deletedAt)
                    )
                  )
                  .limit(1);
                if (clj) {
                  const [apDr] = await db
                    .select({ id: voucherEntries.id })
                    .from(voucherEntries)
                    .where(
                      and(
                        eq(voucherEntries.voucherId, clj.id),
                        eq(voucherEntries.ledgerAccountId, apAcct.id),
                        sql`${voucherEntries.debitAmount}::numeric > 0`
                      )
                    )
                    .limit(1);
                  if (apDr) {
                    apClearJournalDebit = true;
                    break;
                  }
                }
              }
            }

            if (!apDebitEntry && !apClearJournalDebit) {
              // No AP debit in any payment → pre-accrual payment → phantom
              const correction = MoneyDecimal.min(paid, toMoney(row.expectedAmount).toDecimalPlaces(2));
              phantomRows.push({ id: row.id, correction });
              phantomFixTotal = phantomFixTotal.plus(correction);
            }
          }

          // A row corrected by an earlier run is not corrected again (the old
          // code posted the same correction on every re-accrue).
          const phantomNarration = (id: number) => `Phantom accrual correction — ledger row ${id}`;
          const alreadyCorrected = await correctedLedgerRowNarrations(
            companyId,
            phantomRows.map((p) => phantomNarration(p.id))
          );
          const phantomToPost = phantomRows.filter((p) => !alreadyCorrected.has(phantomNarration(p.id)));
          if (phantomToPost.length > 0) {
            const phantomDescription = `Phantom accrual correction — Dr AP / Cr Rent Expense (${phantomToPost.length} rows)`;
            logger.info(`[re-accrue] phantom fix: ${phantomToPost.length} rows, total correction=${phantomFixTotal}`);
            await db.transaction(async (tx) => {
              await postErpVoucherTx(tx, {
                companyId,
                voucherType: "Journal",
                voucherDate: new Date().toISOString().slice(0, 10),
                description: phantomDescription,
                sourceModule: module,
                lines: phantomToPost.flatMap((p) => [
                  { ledgerAccountId: apAcct.id, debit: p.correction, narration: phantomNarration(p.id) },
                  { ledgerAccountId: expAcct.id, credit: p.correction, narration: phantomNarration(p.id) },
                ]),
                source: { type: "rental-phantom-accrual-fix", id: ledgerRowsKey(phantomToPost.map((p) => p.id)) },
                actor: sessionPostingActor(req, "Phantom accrual correction"),
              });
            });
            logger.info(`[re-accrue] phantom fix voucher posted, total corrected=${phantomFixTotal}`);
          } else {
            logger.info(`[re-accrue] no phantom accruals detected`);
          }
        }
      }

      if (shopContracts.length === 0) {
        return res.json({ reset: 0, accrued: 0, skipped: 0 });
      }

      const contractIds = shopContracts.map((c) => c.id);

      // 2a. Dangling-reference sweep (ALL months):
      //     If the user manually deleted vouchers through the UI the voucher rows
      //     are soft-deleted (deletedAt IS NOT NULL) or hard-deleted, but the
      //     accrualVoucherId stamp on the ledger rows still has the old ID.
      //     postRentAccrualForCompany queries WHERE accrualVoucherId IS NULL, so
      //     those rows would never be picked up.  Clear every stale reference now
      //     so the normal flow can proceed unblocked.
      //
      //     Before clearing: detect "orphaned AP debits" — months whose accrual
      //     was deleted AFTER payments had already debited AP.  Those Dr AP entries
      //     have no matching Cr AP from an accrual anymore, leaving a phantom debit
      //     that makes the AP balance lower than the real outstanding.
      //     Auto-fix: Dr Rent Expense / Cr AP for the orphaned amount so AP nets
      //     to zero for those months and the next accrual starts clean.
      const danglingRows = await db
        .select({
          id: propertyMonthlyLedger.id,
          paidAmount: propertyMonthlyLedger.paidAmount,
        })
        .from(propertyMonthlyLedger)
        .where(
          and(
            inArray(propertyMonthlyLedger.contractId, contractIds),
            isNotNull(propertyMonthlyLedger.accrualVoucherId),
            sql`${propertyMonthlyLedger.accrualVoucherId} NOT IN (
            SELECT id FROM vouchers WHERE deleted_at IS NULL
          )`,
            sql`${propertyMonthlyLedger.paidAmount}::numeric > 0`
          )
        );

      if (danglingRows.length > 0) {
        const [apAcctD] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              eq(ledgerAccounts.code, "ACCR-RENT-PAY"),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        const [expAcctD] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, companyId),
              eq(ledgerAccounts.code, "SHOP-RENT-EXP"),
              isNull(ledgerAccounts.deletedAt)
            )
          );

        if (apAcctD && expAcctD) {
          // For each dangling paid row, find how much was debited from AP in payment vouchers
          let orphanedTotal = new MoneyDecimal(0);
          type OrphanRow = { ledgerRowId: number; apDebit: Decimal };
          const orphanRows: OrphanRow[] = [];

          for (const dr of danglingRows) {
            const payVouchers = await db
              .select({ voucherId: propertyPayments.voucherId })
              .from(propertyPayments)
              .where(eq(propertyPayments.ledgerRowId, dr.id));
            const payVoucherIds = payVouchers
              .map((p) => p.voucherId)
              .filter((id): id is number => id !== null && id !== undefined);
            if (payVoucherIds.length === 0) continue;

            const apDebits = await db
              .select({ amount: voucherEntries.debitAmount })
              .from(voucherEntries)
              .where(
                and(
                  inArray(voucherEntries.voucherId, payVoucherIds),
                  eq(voucherEntries.ledgerAccountId, apAcctD.id),
                  sql`${voucherEntries.debitAmount}::numeric > 0`
                )
              );
            const rowApDebit = apDebits.reduce((s, e) => s.plus(toMoney(e.amount)), new MoneyDecimal(0));
            if (rowApDebit.gt(0)) {
              orphanRows.push({ ledgerRowId: dr.id, apDebit: rowApDebit });
              orphanedTotal = orphanedTotal.plus(rowApDebit);
            }
          }

          const orphanNarration = (id: number) => `Orphaned AP debit correction — ledger row ${id}`;
          const orphansCorrected = await correctedLedgerRowNarrations(
            companyId,
            orphanRows.map((o) => orphanNarration(o.ledgerRowId))
          );
          const orphansToPost = orphanRows.filter((o) => !orphansCorrected.has(orphanNarration(o.ledgerRowId)));
          if (orphansToPost.length > 0) {
            const orphanDescription = `Orphaned AP debit correction (${orphansToPost.length} row(s)) — Dr Rent Expense / Cr AP`;
            await db.transaction(async (tx) => {
              await postErpVoucherTx(tx, {
                companyId,
                voucherType: "Journal",
                voucherDate: new Date().toISOString().slice(0, 10),
                description: orphanDescription,
                sourceModule: module,
                lines: orphansToPost.flatMap((o) => [
                  { ledgerAccountId: expAcctD.id, debit: o.apDebit, narration: orphanNarration(o.ledgerRowId) },
                  { ledgerAccountId: apAcctD.id, credit: o.apDebit, narration: orphanNarration(o.ledgerRowId) },
                ]),
                source: { type: "rental-orphan-ap-fix", id: ledgerRowsKey(orphansToPost.map((o) => o.ledgerRowId)) },
                actor: sessionPostingActor(req, "Orphaned AP debit correction"),
              });
            });
            logger.info(
              `[re-accrue] orphaned AP debit fix: ${orphanRows.length} rows, total corrected=${orphanedTotal}`
            );
          }
        }
      }

      await db
        .update(propertyMonthlyLedger)
        .set({ accrualVoucherId: null })
        .where(
          and(
            inArray(propertyMonthlyLedger.contractId, contractIds),
            isNotNull(propertyMonthlyLedger.accrualVoucherId),
            sql`${propertyMonthlyLedger.accrualVoucherId} NOT IN (
            SELECT id FROM vouchers WHERE deleted_at IS NULL
          )`
          )
        );
      logger.info(`[re-accrue] dangling stamp sweep cleared rows`);

      // 2b. Full reset for ALL fully-unpaid months (paidAmount = 0):
      //     Find every ledger row that still has an accrual stamp but has NOT yet
      //     received any payment.  Since paidAmount = 0 there are no Dr AP entries
      //     from payments that could become "orphaned" when we delete the accrual
      //     credit — it is always safe to wipe and re-accrue these rows.
      //     Rows with paidAmount > 0 are left alone; the phantom-fix in step 1b
      //     already corrects any pre-payment / post-accrual mismatches for those.
      //
      //     This replaces the old "current month only" reset and fixes the case
      //     where multiple past months are outstanding but only the current month's
      //     accrual was being rebuilt.
      const now = new Date();
      const curYear = now.getUTCFullYear();
      const curMonth = now.getUTCMonth() + 1;

      // All accrued rows with no payment whatsoever (safe to delete + re-accrue)
      const allUnpaidAccruedRows = await db
        .select({
          id: propertyMonthlyLedger.id,
          accrualVoucherId: propertyMonthlyLedger.accrualVoucherId,
          paidAmount: propertyMonthlyLedger.paidAmount,
          expectedAmount: propertyMonthlyLedger.expectedAmount,
          year: propertyMonthlyLedger.year,
          month: propertyMonthlyLedger.month,
        })
        .from(propertyMonthlyLedger)
        .where(
          and(
            inArray(propertyMonthlyLedger.contractId, contractIds),
            isNotNull(propertyMonthlyLedger.accrualVoucherId),
            sql`${propertyMonthlyLedger.paidAmount}::numeric = 0`
          )
        );
      logger.info(
        `[re-accrue] company=${companyId} ${curYear}-${curMonth} unpaidAccruedRows=${allUnpaidAccruedRows.length}`,
        { unpaidAccruedRows: allUnpaidAccruedRows }
      );

      const voucherIdsToDelete = [
        ...new Set(
          allUnpaidAccruedRows
            .map((r) => r.accrualVoucherId)
            .filter((id): id is number => id !== null && id !== undefined)
        ),
      ];

      logger.info(`[re-accrue] vouchersToDelete=${JSON.stringify(voucherIdsToDelete)}`);

      let reset = 0;
      if (voucherIdsToDelete.length > 0) {
        await db.transaction(async (tx) => {
          // Wave 16 (A): the unpaid accruals are retired (soft delete with their
          // lines, audited here, numbers released) before they are posted again.
          await retireVouchersTx(tx, {
            companyId,
            voucherIds: voucherIdsToDelete,
            reason: "rent-accrual-reaccrue",
            actor: sessionRetirementActor(req),
          });
          // Clear stamps on all the rows we just wiped
          await tx
            .update(propertyMonthlyLedger)
            .set({ accrualVoucherId: null })
            .where(
              inArray(
                propertyMonthlyLedger.id,
                allUnpaidAccruedRows.map((r) => r.id)
              )
            );
        });
        reset = voucherIdsToDelete.length;
      }

      // 3. Re-run the combined accrual
      const { accrued, skipped } = await postRentAccrualForCompany(
        companyId,
        shopExpenseAccountName,
        module,
        incomeAccountName
      );
      logger.info(`[re-accrue] result reset=${reset} accrued=${accrued} skipped=${skipped}`);

      res.json({ reset, accrued, skipped });
    } catch (e: unknown) {
      logger.error(`${tag} re-accrue:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
  return {};
}
