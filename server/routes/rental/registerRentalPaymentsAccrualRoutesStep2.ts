// Extracted from ./rentalPaymentsAccrualRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getCompanyId, type RentalModule } from "./shared";
import { createRentalPaymentGroup } from "../../services/rental/rentalPaymentPostingService";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { validateRequest, validatedInput } from "../../lib/validateRequest";
import { bulkPaymentInput } from "./rentalWriteRouteSchemas";
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
  app.post(
    `${urlPrefix}/payments/bulk`,
    requireAuth,
    validateRequest(bulkPaymentInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        // New callers send { items } so the shared accounting middleware can
        // attach clientRequestId; retain array+header compatibility for old callers.
        const { body } = validatedInput(req, bulkPaymentInput);
        const items = Array.isArray(body) ? body : body.items;

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
        logger.error(`${tag} bulk-payments:`, { error: e });
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
  return {};
}
