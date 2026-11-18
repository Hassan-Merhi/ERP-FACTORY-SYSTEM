// Extracted from ./rentalPaymentsAccrualRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getCompanyId, type RentalModule } from "./shared";
import { createRentalPaymentGroup, isRentalRateRequiredError } from "../../services/rental/rentalPaymentPostingService";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { ledgerAccounts, propertyContracts, propertyUnits } from "@shared/schema";
import { getClientDate } from "../../lib/dateUtils";
import {
  isPropertiesReceiptAccountType,
  PROPERTIES_RENT_CASH_CODE,
  propertiesRentCashboxSetupValues,
} from "../../services/rental/rentalCashboxPolicy";

/** The signed-in user, as the actor of an audited rental posting (phase 19 B). */
export function requestActor(req: Request): { userId: string; username: string } {
  return {
    userId: String(req.session.userId ?? ""),
    username: req.session.username || String(req.session.userId ?? "unknown"),
  };
}

/**
 * New Properties rent money belongs to a company-local cash ledger account.
 * Existing rental balances and past voucher entries are never migrated.
 */
export async function validatePropertiesReceiptAccount(
  companyId: number,
  cashAccountId: number | null | undefined
): Promise<string | null> {
  if (!cashAccountId) return "Choose a Properties cashbox or cash/bank account before receiving rent.";
  const [account] = await db
    .select({
      id: ledgerAccounts.id,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, cashAccountId),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!account || !isPropertiesReceiptAccountType(account.accountType)) {
    return "Choose an active cash/bank asset account belonging to the current Properties company.";
  }
  return null;
}

export function registerRentalPaymentsAccrualRoutesStep1(
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  const tag = `[${module}/rental]`;

  // Explicit, zero-balance setup; never repost or reallocate historical rental receipts.
  // The endpoint is scoped to the selected Properties company and is idempotent by code.
  if (module === "PROPERTIES") {
    app.post(
      `${urlPrefix}/cashbox/ensure`,
      requireAuth,
      requireRole("Admin", "Owner", "Developer"),
      async (req: Request, res: Response) => {
        try {
          const companyId = getCompanyId(req);
          if (!companyId) return res.status(400).json({ message: "No company selected" });
          await db
            .insert(ledgerAccounts)
            .values(propertiesRentCashboxSetupValues(companyId))
            .onConflictDoNothing({ target: [ledgerAccounts.companyId, ledgerAccounts.code] });
          const [account] = await db
            .select()
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, PROPERTIES_RENT_CASH_CODE)))
            .limit(1);
          if (!account || account.deletedAt || !account.active || account.accountType !== "Cash") {
            return res.status(409).json({
              message:
                "The Properties cashbox code is already held by a deleted or incompatible account. Restore or correct it before continuing.",
            });
          }
          return res.json({ id: account.id, code: account.code, name: account.name, accountType: account.accountType });
        } catch (e: unknown) {
          logger.error("[PROPERTIES/rental] cashbox setup:", { error: e });
          return res
            .status(500)
            .json({ message: "Could not create the Properties cashbox without changing existing accounts." });
        }
      }
    );
  }

  app.post(`${urlPrefix}/payments`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const data = z
        .object({
          contractId: z.number(),
          cashAccountId: z.number().nullable().optional(),
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          paymentDate: z.string().min(1),
          notes: z.string().optional(),
          currency: z.string().optional().default("USD"),
          // Phase 19 (B), PE2: not used for posting (the recorded dated rate is).
          exchangeRate: z
            .union([z.string(), z.number()])
            .transform((v) => String(v))
            .optional(),
          scheduleFuturePayment: z.boolean().optional().default(false),
          clientRequestId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9._:-]+$/)
            .optional(),
        })
        .parse(req.body);

      if (module === "PROPERTIES") {
        const error = await validatePropertiesReceiptAccount(companyId, data.cashAccountId);
        if (error) return res.status(400).json({ message: error });
      }

      let isSharedPayment = false;
      let [contract] = await db
        .select()
        .from(propertyContracts)
        .where(
          and(
            eq(propertyContracts.id, data.contractId),
            eq(propertyContracts.companyId, companyId),
            eq(propertyContracts.module, module)
          )
        );
      // If not found as owner, check if it's a shared contract linked to this company
      if (!contract) {
        const [sharedContract] = await db
          .select()
          .from(propertyContracts)
          .where(
            and(
              eq(propertyContracts.id, data.contractId),
              eq(propertyContracts.linkedCompanyId, companyId),
              eq(propertyContracts.status, "ACTIVE")
            )
          );
        if (sharedContract) {
          contract = sharedContract;
          isSharedPayment = true;
        }
      }
      if (!contract) return res.status(404).json({ message: "Contract not found" });
      // A Properties reference must not create a second receipt or payment for Factory rent.
      if (module === "PROPERTIES" && isSharedPayment && contract.module === "FACTORY" && contract.isInternal) {
        return res.status(403).json({ message: "Record internal Factory lease payments in Factory Rentals." });
      }
      const contractCompanyId = isSharedPayment ? contract.companyId : companyId;

      const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));
      const clientDate = getClientDate(req);

      const result = await createRentalPaymentGroup({
        companyId,
        contractCompanyId,
        module,
        contract,
        unit: unit ?? null,
        cashAccountId: data.cashAccountId ?? null,
        amount: data.amount,
        paymentDate: data.paymentDate,
        clientDate,
        scheduleFuturePayment: data.scheduleFuturePayment,
        clientRequestId: data.clientRequestId,
        currency: data.currency,
        exchangeRate: data.exchangeRate ?? "",
        notes: data.notes ?? null,
        shopExpenseAccountName,
        incomeAccountName,
        isSharedPayment,
        audit: { actor: requestActor(req), trigger: "route" },
      });

      if (result.scheduled) {
        return res.json({
          scheduled: true,
          paymentDate: data.paymentDate,
          paymentGroupId: result.paymentGroupId,
          allocations: result.payments.map((r) => ({
            year: r.forYear,
            month: r.forMonth,
            amount: r.amount,
          })),
          message: `Payment of ${data.amount} scheduled for ${data.paymentDate} (today is ${clientDate}). It will be posted automatically on that date.`,
        });
      }
      return res.json(result.payments[0] ?? { ok: true, paymentGroupId: result.paymentGroupId });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      // The rate refusal keeps its structured body (code, currency, date).
      if (isRentalRateRequiredError(e)) {
        return res.status(409).json({ message: e.message, code: e.code, currency: e.currency, date: e.date });
      }
      if ([400, 409].includes((e as { status?: number }).status ?? 0))
        return res.status((e as { status: number }).status).json({ message: getErrorMessage(e) });
      logger.error(`${tag} payments:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
  return { tag };
}
