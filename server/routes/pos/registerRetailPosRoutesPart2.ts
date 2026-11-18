// Extracted from ./retailPosRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { and, desc, eq } from "drizzle-orm";
import { listRetailPaymentAccounts } from "../../services/retail/retailPaymentAccounts";
import { retailDiscountApprovals, retailPosSales } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { resolveRetailSaleCustomer, retailReturnRefusal } from "./retailCheckoutPolicy";
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
  createRetailReturnInTx,
  createRetailSaleInTx,
  loadSaleResponse,
  prepareRetailSalePricing,
  type RetailSaleInput,
  type RetailSaleLineRequest,
} from "../../services/retail/retailSaleService";
import { aggregateRetailCartItems } from "../../services/retail/retailStockMath";
import {
  postRetailRefundAccountingTx,
  refundRetailPaymentsTx,
  validateRetailShiftTx,
} from "../../services/retail/retailFinancialService";
import { returnSchema, saleSchema } from "./registerRetailPosRoutesPart1";

export function registerRetailPosRoutesPart2(app: Express) {
  app.post("/api/pos/retail/sales", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const userId = currentUserId(req);
      const body = saleSchema.parse(req.body);
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

  app.get("/api/pos/retail/sales", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
      if (!Number.isInteger(locationId) || locationId <= 0)
        return res.status(400).json({ message: "Location is required" });
      await ensureCompanyLocation(companyId, locationId);
      const sales = await db
        .select({ id: retailPosSales.id })
        .from(retailPosSales)
        .where(and(eq(retailPosSales.companyId, companyId), eq(retailPosSales.locationId, locationId)))
        .orderBy(desc(retailPosSales.createdAt))
        .limit(limit);
      const details = await Promise.all(sales.map((sale) => loadSaleResponse(companyId, sale.id)));
      res.json(details.filter(Boolean));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pos/retail/payment-accounts", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      res.json(await listRetailPaymentAccounts(companyId));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/sales/:saleId/returns", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const saleId = Number(req.params.saleId);
      if (!Number.isInteger(saleId) || saleId <= 0) return res.status(400).json({ message: "Invalid sale" });
      const body = returnSchema.parse(req.body);
      await ensureCompanyLocation(companyId, body.locationId);
      const userId = currentUserId(req);
      const refusal = await retailReturnRefusal({ companyId, saleId, role: req.user?.role, ...body });
      if (refusal) return res.status(refusal.status).json(refusal.body);

      const result = await db.transaction(async (tx) => {
        const returned = await createRetailReturnInTx(tx, {
          companyId,
          saleId,
          locationId: body.locationId,
          idempotencyKey: body.idempotencyKey,
          notes: body.notes ?? null,
          items: body.items,
          userId,
        });
        if (!returned.replayed) {
          const shift = await validateRetailShiftTx(tx, {
            companyId,
            locationId: body.locationId,
            userId,
            shiftId: body.shiftId ?? null,
          });
          const refunds = await refundRetailPaymentsTx(tx, {
            companyId,
            saleId,
            locationId: body.locationId,
            shiftId: shift?.id ?? null,
            refundAmount: returned.refundAmount,
            idempotencyKey: body.idempotencyKey,
            destination: body.refundDestination,
            refundAccount: { ledgerAccountId: body.refundLedgerAccountId, bankAccountId: body.refundBankAccountId },
            userId,
          });
          const refundPosting = await postRetailRefundAccountingTx(tx, {
            companyId,
            locationId: body.locationId,
            saleId,
            sourceType: "retail-pos-return",
            sourceId: String(returned.returnId),
            idempotencyKey: `retail-pos-return:${returned.returnId}`,
            refundAmount: returned.refundAmount,
            refundTaxAmount: returned.refundTaxAmount,
            restoredCost: returned.costValue,
            refunds,
            userId,
            username: req.user?.username ?? null,
          });
          // Wave 17 (D): what the refund journal did not put back on Retail inventory.
          await returned.stockValue?.post({
            kind: "return",
            sourceId: returned.returnId,
            description: `Retail return #${returned.returnId} for sale #${saleId}`,
            actor: { userId, username: req.user?.username ?? null },
            alreadyDebited: refundPosting.costReversed ? returned.costValue : undefined,
          });
        }
        return returned;
      });

      res.status(result.replayed ? 200 : 201).json({
        ...result,
        // Exact amounts inside; a number only in the response.
        refundAmount: result.refundAmount.toDecimalPlaces(2).toNumber(),
        refundTaxAmount: result.refundTaxAmount.toDecimalPlaces(2).toNumber(),
        refundValue: result.refundValue.toNumber(),
        costValue: result.costValue.toNumber(),
        sale: await loadSaleResponse(companyId, saleId),
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
