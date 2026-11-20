import type { Express, Request, Response } from "express";
import {
  RentalAutoTransferScopeError,
  runWithAutoTransferCounterparties,
} from "../../services/rental/autoTransferScope";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  HADI_HISTORICAL_ACCRUAL_GUARD,
  isHadiProtectedRentMonth,
} from "../../services/rental/hadiLinkedRentProtection";
import { logger } from "../../lib/logger";
import { getCompanyId, findOrCreateLedgerAccount, type RentalModule } from "./shared";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { z } from "zod";
import { eq, and, inArray, isNull } from "drizzle-orm";
import {
  propertyUnits,
  propertyMonthlyLedger,
  ledgerAccounts,
  rentalAutoTransferConfigs,
  companies,
} from "@shared/schema";
import { parseId } from "../../lib/parseId";
import { postErpVoucherTx, sessionPostingActor } from "../../services/accounting/erpVoucherPosting";
import { toMoney } from "../../lib/money";
import { ledgerPostingLeafCondition } from "../../services/accounting/postableLedgerAccountPolicy";
import { registerRentalAccrualConfigRoutesStep1 } from "./correctedLedgerRowNarrations";
import { registerRentalAccrualConfigRoutesStep2 } from "./registerRentalAccrualConfigRoutesStep2";

export function registerRentalAccrualConfigRoutes(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  const { tag } = registerRentalAccrualConfigRoutesStep1(module);
  registerRentalAccrualConfigRoutesStep2({ tag }, app, module, urlPrefix, incomeAccountName, shopExpenseAccountName);
  registerRentalAccrualConfigRoutesStep3({ tag }, app, module, urlPrefix, shopExpenseAccountName);
  registerRentalAccrualConfigRoutesStep4(app, urlPrefix);
}

function registerRentalAccrualConfigRoutesStep3(
  { tag }: Pick<Awaited<ReturnType<typeof registerRentalAccrualConfigRoutesStep1>>, "tag">,
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
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
      // Historical January–November 2026 rent was repaired in the originals.
      // New rental months may still use the normal reviewed reversal flow.
      if (isHadiProtectedRentMonth(companyId, module, row.year, row.month)) {
        return res.status(409).json(HADI_HISTORICAL_ACCRUAL_GUARD);
      }
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
      if (toMoney(row.paidAmount).gt(0)) {
        return res.status(400).json({
          message: `Cannot reverse: ${row.paidAmount} has already been paid against this month. Void the payment first.`,
        });
      }

      const amount = toMoney(row.expectedAmount).minus(toMoney(row.paidAmount));
      const accrualVoucherId = row.accrualVoucherId;

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

        // Mirror image of the original accrual:
        //   Original:  Dr Rent Expense  /  Cr Accrued Rent Payable
        //   Reversal:  Dr Accrued Rent Payable  /  Cr Rent Expense
        const { voucher: v } = await postErpVoucherTx(tx, {
          companyId,
          voucherType: "Journal",
          voucherDate: new Date().toISOString().slice(0, 10),
          description: narration,
          lines: [
            { ledgerAccountId: liabilityAccountId, debit: amount, narration },
            { ledgerAccountId: expenseAccountId, credit: amount, narration },
          ],
          // One reversal per accrual voucher of the row.
          source: { type: "rental-accrual-reversal", id: `${rowId}:${accrualVoucherId}` },
          actor: sessionPostingActor(req, "Accrual reversal"),
        });

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

      // The rule decides which company and account receive money, so both are
      // checked here: the user must hold the destination company, the account
      // must be a live account of it, and the source cash accounts must be this
      // company's own.
      const destAccountValid = await runWithAutoTransferCounterparties([data.destCompanyId], async () => {
        const [account] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, data.destLedgerAccountId),
              eq(ledgerAccounts.companyId, data.destCompanyId),
              isNull(ledgerAccounts.deletedAt),
              ledgerPostingLeafCondition(data.destCompanyId)
            )
          );
        return Boolean(account);
      });
      if (!destAccountValid) {
        return res.status(400).json({ message: "The destination account does not belong to the destination company" });
      }
      const sourceIds = [...new Set(data.sourceCashAccountIds)];
      if (sourceIds.length > 0) {
        const owned = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              inArray(ledgerAccounts.id, sourceIds),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt),
              ledgerPostingLeafCondition(companyId)
            )
          );
        if (owned.length !== sourceIds.length) {
          return res.status(400).json({ message: "Every source cash account must belong to this company" });
        }
      }

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
      if (e instanceof RentalAutoTransferScopeError) return res.status(e.status).json({ message: e.message });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
  return {};
}

function registerRentalAccrualConfigRoutesStep4(app: Express, urlPrefix: string) {
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
  return {};
}
