// Extracted from ./registerRetailPosRoutesPart2.ts
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { retailDiscountApprovals } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resolveRetailSaleCustomer } from "./retailCheckoutPolicy";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import {
  approvalCoversRequest,
  evaluateRetailDiscountPolicy,
  ExpiredRetailApprovalTokenError,
  InvalidRetailApprovalTokenError,
  retailApprovalFingerprint,
  RetailApprovalReuseError,
  verifyRetailApprovalToken,
} from "../../services/retail/retailDiscountApproval";
import { effectiveManualDiscountPercent, hasManualAdjustment } from "../../services/retail/retailPricing";
import { listActiveRetailPromotions } from "../../services/retail/retailPromotions";
import { loadRetailSettings } from "../../services/retail/retailSettings";
import {
  createRetailSaleInTx,
  loadSaleResponse,
  prepareRetailSalePricing,
  type RetailSaleInput,
  type RetailSaleLineRequest,
} from "../../services/retail/retailSaleService";
import { aggregateRetailCartItems } from "../../services/retail/retailStockMath";
import { validateRequest, validatedInput } from "../../lib/validateRequest";
import { saleInput } from "./registerRetailPosRoutesPart1";

export function registerRetailPosRoutesPart3(app: Express) {
  app.post("/api/pos/retail/sales", requireAuth, validateRequest(saleInput), async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const userId = currentUserId(req);
      const body = validatedInput(req, saleInput).body;
      await ensureCompanyLocation(companyId, body.locationId);
      const canSellNegativeStock = Boolean(req.user?.canSellNegativeStock);

      // One line per variant keeps line discounts unambiguous; plain Wave 1 carts may still
      // contain duplicate variants and keep working through the legacy aggregation.
      const hasAdjustments = body.items.some(
        (item) =>
          (item.priceOverride ?? null) !== null ||
          (item.discountType ?? "none") !== "none" ||
          Number(item.discountValue ?? 0) > 0
      );
      const requestedLines: RetailSaleLineRequest[] = hasAdjustments
        ? body.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            priceOverride: item.priceOverride ?? null,
            discountType: item.discountType ?? "none",
            discountValue: item.discountValue ?? 0,
            discountReason: item.discountReason ?? null,
          }))
        : aggregateRetailCartItems(body.items).map((item) => ({ variantId: item.variantId, quantity: item.quantity }));
      if (hasAdjustments && new Set(requestedLines.map((line) => line.variantId)).size !== requestedLines.length) {
        return res.status(400).json({ message: "Each variant may appear only once when a discount is applied" });
      }

      const settings = await loadRetailSettings(companyId);
      const promotions = await listActiveRetailPromotions(companyId);
      const orderDiscount = {
        type: body.orderDiscount?.type ?? ("none" as const),
        value: body.orderDiscount?.value ?? 0,
        reason: body.orderDiscount?.reason ?? null,
      };

      // A reason is mandatory for every manual discount / price override.
      const missingReason = requestedLines.some(
        (line) =>
          ((line.priceOverride ?? null) !== null ||
            (line.discountType ?? "none") !== "none" ||
            Number(line.discountValue ?? 0) > 0) &&
          !line.discountReason?.trim()
      );
      if (missingReason || (orderDiscount.type !== "none" && !orderDiscount.reason?.trim())) {
        return res.status(400).json({
          code: "DISCOUNT_REASON_REQUIRED",
          message: "A reason is required for every discount or price override",
        });
      }

      const preview = await prepareRetailSalePricing(db, {
        companyId,
        items: requestedLines,
        orderDiscount,
        settings,
        promotions,
      });
      const manual = hasManualAdjustment(preview.priced, orderDiscount);
      const effectiveDiscountPercent = effectiveManualDiscountPercent(preview.priced);
      const hasPriceOverride = preview.priced.lines.some((line) => line.priceOverride);
      const policy = evaluateRetailDiscountPolicy({
        role: req.user?.role,
        discountLimitPercent: settings.discountLimitPercent,
        requireManagerApproval: settings.requireManagerApproval,
        priceOverrideRequiresApproval: settings.priceOverrideRequiresApproval,
        effectiveDiscountPercent,
        hasPriceOverride,
        hasManualDiscount: manual.any,
      });

      let approval: RetailSaleInput["approval"] = null;
      if (policy.requiresApproval) {
        if (!body.approvalToken) {
          return res.status(428).json({
            code: "DISCOUNT_APPROVAL_REQUIRED",
            message: "A manager must approve this discount or price override",
            reasons: policy.reasons,
            discountLimitPercent: settings.discountLimitPercent,
            effectiveDiscountPercent,
          });
        }
        let payload: ReturnType<typeof verifyRetailApprovalToken>;
        try {
          payload = verifyRetailApprovalToken(body.approvalToken);
        } catch (error) {
          const expired = error instanceof ExpiredRetailApprovalTokenError;
          return res.status(428).json({
            code: expired ? "DISCOUNT_APPROVAL_EXPIRED" : "DISCOUNT_APPROVAL_INVALID",
            message: getErrorMessage(error),
          });
        }
        const fingerprint = retailApprovalFingerprint(requestedLines, orderDiscount);
        const covers =
          payload.companyId === companyId &&
          payload.cashierUserId === userId &&
          payload.fingerprint === fingerprint &&
          approvalCoversRequest(payload, {
            companyId,
            cashierUserId: userId,
            effectiveDiscountPercent,
            hasPriceOverride,
          });
        if (!covers) {
          return res.status(428).json({
            code: "DISCOUNT_APPROVAL_INVALID",
            message:
              "This approval was issued for a different cart, cashier or company — ask the manager to approve again.",
          });
        }
        const [record] = await db
          .select({ id: retailDiscountApprovals.id })
          .from(retailDiscountApprovals)
          .where(
            and(eq(retailDiscountApprovals.companyId, companyId), eq(retailDiscountApprovals.tokenId, payload.tokenId))
          )
          .limit(1);
        if (!record) {
          return res.status(428).json({ code: "DISCOUNT_APPROVAL_INVALID", message: "Approval record not found" });
        }
        approval = {
          approvalId: record.id,
          approvedByUserId: payload.managerUserId,
          approvedByName: payload.managerName,
        };
      }

      const resolved = await resolveRetailSaleCustomer(companyId, body);
      if ("status" in resolved) return res.status(resolved.status).json(resolved.body);
      const { customer } = resolved;

      const result = await db.transaction((tx) =>
        createRetailSaleInTx(tx, {
          companyId,
          locationId: body.locationId,
          idempotencyKey: body.idempotencyKey,
          notes: body.notes ?? null,
          items: requestedLines,
          userId,
          username: req.user?.username ?? null,
          canSellNegativeStock,
          shiftId: body.shiftId ?? null,
          payments: body.payments,
          customer,
          orderDiscount,
          settings,
          promotions,
          approval,
        })
      );

      const sale = await loadSaleResponse(companyId, result.saleId);
      res.status(result.replayed ? 200 : 201).json({ replayed: result.replayed, sale });
    } catch (error) {
      if (error instanceof InvalidRetailApprovalTokenError) {
        return res.status(428).json({ code: "DISCOUNT_APPROVAL_INVALID", message: getErrorMessage(error) });
      }
      if (error instanceof RetailApprovalReuseError) {
        return res.status(409).json({ code: "DISCOUNT_APPROVAL_ALREADY_USED", message: getErrorMessage(error) });
      }
      const message = getErrorMessage(error);
      res.status(message.includes("Insufficient stock") ? 409 : 400).json({ message });
    }
  });
}
