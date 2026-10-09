import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  getCompanyId,
  findOrCreateLedgerAccount,
  ensureMonthlyForCompany,
  postRentAccrualForCompany,
  type RentalModule,
} from "./shared";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { z } from "zod";
import { eq, and, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import {
  propertyUnits,
  propertyContracts,
  propertyMonthlyLedger,
  propertyPayments,
  ledgerAccounts,
  vouchers,
  voucherEntries,
  rentalAutoTransferConfigs,
  companies,
} from "@shared/schema";
import { parseId } from "../../lib/parseId";
import { retireVouchersTx, sessionRetirementActor } from "../../services/accounting/voucherRetirement";

export function registerRentalAccrualConfigRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  const tag = `[${module}/rental]`;

  app.post(`${urlPrefix}/re-accrue`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

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
          let phantomFixTotal = 0;
          type PhantomRow = { id: number; correction: number };
          const phantomRows: PhantomRow[] = [];

          for (const row of candidateRows) {
            const paid = Number(row.paidAmount);
            if (paid <= 0) continue;

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
              const correction = Math.min(paid, Number(row.expectedAmount));
              phantomRows.push({ id: row.id, correction });
              phantomFixTotal += correction;
            }
          }

          if (phantomRows.length > 0) {
            logger.info(`[re-accrue] phantom fix: ${phantomRows.length} rows, total correction=${phantomFixTotal}`);
            await db.transaction(async (tx) => {
              const [corrV] = await tx
                .insert(vouchers)
                .values({
                  companyId,
                  voucherNumber: `PHANTOM-FIX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  voucherType: "Journal",
                  voucherDate: new Date().toISOString().slice(0, 10),
                  description: `Phantom accrual correction — Dr AP / Cr Rent Expense (${phantomRows.length} rows)`,
                  totalAmount: String(phantomFixTotal),
                  currency: "USD",
                  sourceModule: module,
                })
                .returning();

              const corrEntries: {
                voucherId: number;
                ledgerAccountId: number;
                debitAmount: string;
                creditAmount: string;
                narration: string;
              }[] = [];

              for (const p of phantomRows) {
                corrEntries.push({
                  voucherId: corrV.id,
                  ledgerAccountId: apAcct.id,
                  debitAmount: String(p.correction),
                  creditAmount: "0",
                  narration: `Phantom accrual correction — ledger row ${p.id}`,
                });
                corrEntries.push({
                  voucherId: corrV.id,
                  ledgerAccountId: expAcct.id,
                  debitAmount: "0",
                  creditAmount: String(p.correction),
                  narration: `Phantom accrual correction — ledger row ${p.id}`,
                });
              }
              await tx.insert(voucherEntries).values(corrEntries);
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
          let orphanedTotal = 0;
          type OrphanRow = { ledgerRowId: number; apDebit: number };
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
            const rowApDebit = apDebits.reduce((s, e) => s + Number(e.amount), 0);
            if (rowApDebit > 0) {
              orphanRows.push({ ledgerRowId: dr.id, apDebit: rowApDebit });
              orphanedTotal += rowApDebit;
            }
          }

          if (orphanRows.length > 0) {
            await db.transaction(async (tx) => {
              const [corrV] = await tx
                .insert(vouchers)
                .values({
                  companyId,
                  voucherNumber: `ORPHAN-AP-FIX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  voucherType: "Journal",
                  voucherDate: new Date().toISOString().slice(0, 10),
                  description: `Orphaned AP debit correction (${orphanRows.length} row${orphanRows.length > 1 ? "s" : ""}) — Dr Rent Expense / Cr AP`,
                  totalAmount: String(orphanedTotal),
                  currency: "USD",
                  sourceModule: module,
                })
                .returning();

              const corrEntries: {
                voucherId: number;
                ledgerAccountId: number;
                debitAmount: string;
                creditAmount: string;
                narration: string;
              }[] = [];
              for (const o of orphanRows) {
                corrEntries.push({
                  voucherId: corrV.id,
                  ledgerAccountId: expAcctD.id,
                  debitAmount: String(o.apDebit),
                  creditAmount: "0",
                  narration: `Orphaned AP debit correction — ledger row ${o.ledgerRowId}`,
                });
                corrEntries.push({
                  voucherId: corrV.id,
                  ledgerAccountId: apAcctD.id,
                  debitAmount: "0",
                  creditAmount: String(o.apDebit),
                  narration: `Orphaned AP debit correction — ledger row ${o.ledgerRowId}`,
                });
              }
              await tx.insert(voucherEntries).values(corrEntries);
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

  // ── REVERSE ACCRUAL (ERP SHOP only) ──────────────────────────────────────
  // Posts the mirror-image Journal voucher for an accrued ledger row and clears
  // accrualVoucherId so the month can be re-accrued if needed.
  // Blocked if any payment has already been applied to that month (payment would
  // have debited Accrued Rent Payable; reversing the original accrual would then
  // leave the books inconsistent — void the payment first).
  app.delete(`${urlPrefix}/ledger/:rowId/accrual`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (module !== "ERP")
        return res.status(400).json({ message: "Accrual reversal is only available for ERP module" });

      const rowId = parseId(req.params.rowId);
      if (rowId === null) return res.status(400).json({ message: "Invalid row id" });

      // Load ledger row and verify company ownership
      const [row] = await db
        .select()
        .from(propertyMonthlyLedger)
        .where(
          and(
            eq(propertyMonthlyLedger.id, rowId),
            eq(propertyMonthlyLedger.companyId, companyId),
            eq(propertyMonthlyLedger.module, "ERP")
          )
        );
      if (!row) return res.status(404).json({ message: "Ledger row not found" });
      if (!row.accrualVoucherId)
        return res.status(400).json({ message: "This month has no posted accrual to reverse" });

      // Verify unit is SHOP type
      const [unit] = await db
        .select({ unitType: propertyUnits.unitType, unitNumber: propertyUnits.unitNumber })
        .from(propertyUnits)
        .where(eq(propertyUnits.id, row.unitId));
      if (!unit || unit.unitType !== "SHOP")
        return res.status(400).json({ message: "Accrual reversal is only available for SHOP units" });

      // Block if payments have already been applied (they debited Accrued Rent Payable).
      if (Number(row.paidAmount) > 0) {
        return res.status(400).json({
          message: `Cannot reverse: ${row.paidAmount} has already been paid against this month. Void the payment first.`,
        });
      }

      const amount = String(Number(row.expectedAmount) - Number(row.paidAmount));

      const reversalVoucherId = await db.transaction(async (tx) => {
        const liabilityAccountId = await findOrCreateLedgerAccount(
          tx,
          companyId,
          "Accrued Rent Payable",
          "Liability",
          "ACCR-RENT-PAY"
        );
        const expenseAccountId = await findOrCreateLedgerAccount(
          tx,
          companyId,
          shopExpenseAccountName,
          "Indirect Expense",
          "SHOP-RENT-EXP"
        );

        const monthStr = `${String(row.month).padStart(2, "0")}/${row.year}`;
        const unitLabel = `unit${row.unitId}${unit.unitNumber ? `-${unit.unitNumber}` : ""}`;
        const narration = `Accrual reversal - ${unitLabel} - ${monthStr}`;

        const [v] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber: `ACCR-REV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${rowId}`,
            voucherType: "Journal",
            voucherDate: new Date().toISOString().slice(0, 10),
            description: narration,
            totalAmount: amount,
            currency: "USD",
            sourceModule: "ERP",
          })
          .returning();

        // Mirror image of the original accrual:
        //   Original:  Dr Rent Expense  /  Cr Accrued Rent Payable
        //   Reversal:  Dr Accrued Rent Payable  /  Cr Rent Expense
        await tx.insert(voucherEntries).values([
          { voucherId: v.id, ledgerAccountId: liabilityAccountId, debitAmount: amount, creditAmount: "0", narration },
          { voucherId: v.id, ledgerAccountId: expenseAccountId, debitAmount: "0", creditAmount: amount, narration },
        ]);

        // Clear the stamp — month is now clean and eligible to be re-accrued
        await tx
          .update(propertyMonthlyLedger)
          .set({ accrualVoucherId: null })
          .where(eq(propertyMonthlyLedger.id, rowId));

        return v.id;
      });

      res.json({ ok: true, reversalVoucherId });
    } catch (e: unknown) {
      logger.error(`${tag} reverse-accrual:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── AUTO-TRANSFER CONFIG ───────────────────────────────────────────────────

  // GET — return current config for this company+module (or null), enriched with names
  app.get(`${urlPrefix}/auto-transfer-config`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // Return all configs for this company+module, enriched with names
      const allCfgs = await db
        .select()
        .from(rentalAutoTransferConfigs)
        .where(and(eq(rentalAutoTransferConfigs.companyId, companyId), eq(rentalAutoTransferConfigs.module, module)));

      const enriched = await Promise.all(
        allCfgs.map(async (cfg) => {
          const [destCompany] = await db
            .select({ name: companies.name })
            .from(companies)
            .where(eq(companies.id, cfg.destCompanyId));
          const [destAccount] = await db
            .select({ name: ledgerAccounts.name })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.id, cfg.destLedgerAccountId));
          const sourceIds = (cfg.sourceCashAccountIds ?? []) as number[];
          let sourceAccountNames: { id: number; name: string }[] = [];
          if (sourceIds.length > 0) {
            sourceAccountNames = await db
              .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
              .from(ledgerAccounts)
              .where(inArray(ledgerAccounts.id, sourceIds));
          }
          return {
            ...cfg,
            destCompanyName: destCompany?.name ?? null,
            destAccountName: destAccount?.name ?? null,
            sourceAccountNames,
          };
        })
      );

      res.json(enriched);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // POST — upsert config (insert or update on conflict)
  app.post(`${urlPrefix}/auto-transfer-config`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const data = z
        .object({
          destCompanyId: z.number().min(1),
          destLedgerAccountId: z.number().min(1),
          sourceCashAccountIds: z.array(z.number()).default([]),
          enabled: z.boolean().default(true),
        })
        .parse(req.body);

      // Always insert a new rule (multiple rules per company+module are supported)
      const [created] = await db
        .insert(rentalAutoTransferConfigs)
        .values({
          companyId,
          module,
          ...data,
        })
        .returning();
      res.status(201).json(created);
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // DELETE — remove a specific auto-transfer rule by ID
  app.delete(`${urlPrefix}/auto-transfer-config/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      await db
        .delete(rentalAutoTransferConfigs)
        .where(and(eq(rentalAutoTransferConfigs.id, id), eq(rentalAutoTransferConfigs.companyId, companyId)));
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
