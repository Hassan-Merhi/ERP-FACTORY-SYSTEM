// Extracted from ./rentalPaymentsAccrualRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getCompanyId, type RentalModule } from "./shared";
import { createRentalPaymentGroup } from "../../services/rental/rentalPaymentPostingService";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { propertyContracts, propertyUnits } from "@shared/schema";
import { getClientDate } from "../../lib/dateUtils";
import {
  registerRentalPaymentsAccrualRoutesStep1,
  requestActor,
  validatePropertiesReceiptAccount,
} from "./registerRentalPaymentsAccrualRoutesStep1";

export function registerRentalPaymentsAccrualRoutesStep2(
  { tag }: Pick<Awaited<ReturnType<typeof registerRentalPaymentsAccrualRoutesStep1>>, "tag">,
  app: Express,
  module: RentalModule,
  urlPrefix: string,
  incomeAccountName: string,
  shopExpenseAccountName: string = "Rent Expense - Shops"
) {
  // ── BULK PAYMENTS ──
  app.post(`${urlPrefix}/payments/bulk`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const items = z
        .array(
          z.object({
            contractId: z.number(),
            cashAccountId: z.number().nullable().optional(),
            amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
            paymentDate: z.string().min(1),
            notes: z.string().optional(),
            currency: z.string().optional().default("USD"),
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
        )
        .min(1)
        // New callers send { items } so the shared accounting middleware can
        // attach clientRequestId; retain array+header compatibility for old callers.
        .parse(Array.isArray(req.body) ? req.body : req.body?.items);

      const clientDate = getClientDate(req);
      // Validate the shared receipt account once before any bulk line is posted,
      // so an invalid account cannot silently create balance-only payment rows.
      if (module === "PROPERTIES") {
        for (const item of items) {
          const error = await validatePropertiesReceiptAccount(companyId, item.cashAccountId);
          if (error) return res.status(400).json({ message: error });
        }
      }
      type RentalBulkPaymentResult =
        | { contractId: number; error: string }
        | { contractId: number; scheduled: boolean; paymentGroupId: string; paymentsCreated: number };
      const results: RentalBulkPaymentResult[] = [];
      for (const data of items) {
        try {
          const [contract] = await db
            .select()
            .from(propertyContracts)
            .where(
              and(
                eq(propertyContracts.id, data.contractId),
                eq(propertyContracts.companyId, companyId),
                eq(propertyContracts.module, module)
              )
            );
          if (!contract) {
            results.push({ contractId: data.contractId, error: "Contract not found" });
            continue;
          }

          const [unit] = await db.select().from(propertyUnits).where(eq(propertyUnits.id, contract.unitId));

          const result = await createRentalPaymentGroup({
            companyId,
            contractCompanyId: companyId,
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
            isSharedPayment: false,
            audit: { actor: requestActor(req), trigger: "route" },
          });

          results.push({
            contractId: data.contractId,
            scheduled: result.scheduled,
            paymentGroupId: result.paymentGroupId,
            paymentsCreated: result.payments.length,
          });
        } catch (itemErr: unknown) {
          results.push({ contractId: data.contractId, error: getErrorMessage(itemErr) });
        }
      }

      res.json({ processed: results.length, results });
    } catch (e: unknown) {
      if (e instanceof z.ZodError)
        return res.status(400).json({ message: e.issues.map((err) => err.message).join(", ") });
      logger.error(`${tag} bulk-payments:`, { error: e });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
  return {};
}
