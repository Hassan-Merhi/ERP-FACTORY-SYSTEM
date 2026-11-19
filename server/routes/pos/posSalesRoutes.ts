import { type Express } from "express";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { getClientDate } from "../../lib/dateUtils";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, canModifyDate } from "../../auth";
import { companies } from "@shared/schema";
import { eq } from "drizzle-orm";
import { createPosSale } from "../../services/pos/createSaleService";
import { classifyGoldenCoastPosConfigurationError } from "../../services/pos/goldenCoastPosConfigurationError";
import { isCreatedPosSale } from "../../services/pos/posSaleTypes";
import { validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { z } from "zod";

// Every field createPosSale reads (services/pos/posSaleTypes.ts PosSaleRequestBody),
// in the shapes the POS screen and its offline queues send
// (client/src/pages/pos/hooks/usePosCheckout.ts, usePosMutations.ts). The sale
// service keeps its own checks and messages, so most fields stay optional here.
// No query schema: the handler reads none, and callers may tag the URL.
const numberOrString = z.union([z.number(), z.string()]);
const posSaleItem = z.strictObject({
  stockItemId: numberOrString.nullable().optional(),
  quantity: numberOrString.nullable().optional(),
  rate: numberOrString.nullable().optional(),
  originalCurrencyRate: numberOrString.nullable().optional(),
  salesItemId: z.unknown().optional(), // sent by client/src/pages/pos/hooks/usePosCheckout.ts; not used
  stockItemName: z.unknown().optional(), // sent by client/src/pages/pos/hooks/usePosCheckout.ts; not used
  stockItemCode: z.unknown().optional(), // sent by client/src/pages/pos/hooks/usePosCheckout.ts; not used
  configuredPrice: z.unknown().optional(), // sent by client/src/pages/pos/hooks/usePosCheckout.ts; not used
});
const createPosSaleInput = {
  body: z.strictObject({
    locationId: numberOrString.nullable().optional(),
    cashAccountId: numberOrString.nullable().optional(),
    paymentAccountType: z.string().nullable().optional(),
    paymentAccountId: numberOrString.nullable().optional(),
    items: z.array(posSaleItem).nullable().optional(),
    notes: z.string().nullable().optional(),
    isCreditSale: z.boolean().nullable().optional(),
    voucherDate: z.string().nullable().optional(),
    shiftId: numberOrString.nullable().optional(),
    clientSaleId: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    exchangeRate: numberOrString.nullable().optional(),
    targetCompanyId: z.unknown().optional(), // sent by client/src/pages/pos/hooks/usePosMutations.ts (Golden Coast); not used
    // Read by the browser offline capture (server/offline/browserSync/browserOperationKinds.ts); not used here.
    paymentMethod: z.unknown().optional(),
  }),
} satisfies RequestSchemas;

export function registerPosSalesRoutes(app: Express): void {
  app.post(
    "/api/pos/sales",
    requireAuth,
    canModifyDate("voucherDate"),
    validateRequest(createPosSaleInput),
    async (req, res) => {
      const _t = Date.now();
      const _uid = req.user?.id;
      const _cid = req.session.currentCompanyId;
      logger.info("POS sale create started", { module: "pos", action: "createSale", userId: _uid, companyId: _cid });
      try {
        if (!req.session.currentCompanyId) {
          return res.status(400).json({ message: "No company selected" });
        }
        const [currentCoRow] = await db
          .select({ companyType: companies.companyType })
          .from(companies)
          .where(eq(companies.id, req.session.currentCompanyId!))
          .limit(1);
        const isSpCompany = currentCoRow?.companyType === "supplier_partner";
        if (currentCoRow?.companyType === "retail") {
          return res.status(409).json({
            message: "Retail companies must use the exact-variant retail POS endpoint",
            code: "RETAIL_POS_ENDPOINT_REQUIRED",
          });
        }

        const result = await createPosSale(
          {
            currentCompanyId: req.session.currentCompanyId!,
            userId: req.user!.id,
            username: req.session.username || "unknown",
            userRole: req.user?.role,
            canSellNegativeStock: req.user?.canSellNegativeStock || false,
            sessionCashAccountId: req.session.cashAccountId,
            voucherDateFallback: getClientDate(req),
            body: req.body,
          },
          { isSpCompany }
        );

        if (isCreatedPosSale(result)) {
          logger.info("POS sale create succeeded", {
            module: "pos",
            action: "createSale",
            userId: _uid,
            companyId: _cid,
            voucherId: result.body.voucher.id,
            durationMs: Date.now() - _t,
          });
          // Phase 21 (B): createPosSale writes the create audit inside the sale's
          // transaction; the duplicate after-commit summary row here is gone.
        }
        res.status(result.status).json(result.body);
      } catch (error: unknown) {
        logger.error("POS sale create failed", {
          module: "pos",
          action: "createSale",
          userId: _uid,
          companyId: _cid,
          durationMs: Date.now() - _t,
          error,
        });

        const configurationError = classifyGoldenCoastPosConfigurationError(error);
        if (configurationError) {
          return res.status(configurationError.status).json(configurationError.body);
        }

        if (getErrorMessage(error).includes("Inventory not found")) {
          return res.status(404).json({ message: getErrorMessage(error) });
        }
        if (
          getErrorMessage(error).includes("Insufficient stock") ||
          getErrorMessage(error).includes("Not enough stock")
        ) {
          return res.status(400).json({ message: getErrorMessage(error) });
        }
        res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
      }
    }
  );
}
