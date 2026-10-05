/**
 * Retail Wave 2 — discount/price-override approvals and active-promotion visibility.
 *
 * The POS calls this before checkout when a manual discount exceeds the company limit or a
 * price override is keyed. A manager of the same company signs in with their own credentials;
 * the server fingerprints the exact cart, records an audit row and returns a short-lived
 * HMAC token that checkout verifies and consumes.
 */
import crypto from "node:crypto";
import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  retailDiscountApprovals,
  retailProductVariants,
  retailProducts,
  users,
  userCompanyRoles,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { verifyPassword } from "../_helpers";
import {
  evaluateRetailDiscountPolicy,
  isRetailManagerRole,
  retailApprovalFingerprint,
  signRetailApprovalToken,
  RETAIL_APPROVAL_TOKEN_TTL_MS,
} from "../../services/retail/retailDiscountApproval";
import {
  effectiveManualDiscountPercent,
  hasManualAdjustment,
  priceRetailCart,
} from "../../services/retail/retailPricing";
import { loadRetailSettings } from "../../services/retail/retailSettings";
import { currentUserId, requireRetailCompany } from "./retailPosContext";

const approvalLineSchema = z.object({
  variantId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().finite().positive(),
  priceOverride: z.coerce.number().finite().nonnegative().nullable().optional(),
  discountType: z.enum(["none", "percent", "fixed"]).optional(),
  discountValue: z.coerce.number().finite().nonnegative().optional(),
});

const approvalRequestSchema = z.object({
  managerUsername: z.string().trim().min(1).max(191),
  managerPassword: z.string().min(1).max(500),
  reason: z.string().trim().max(500).optional(),
  items: z.array(approvalLineSchema).min(1).max(250),
  orderDiscount: z
    .object({
      type: z.enum(["none", "percent", "fixed"]),
      value: z.coerce.number().finite().nonnegative().optional(),
    })
    .optional(),
});

export function registerRetailSellingRoutes(app: Express): void {
  /**
   * Issues a manager approval token for the exact cart. `required: false` short-circuits when
   * the policy does not fire (nothing to approve).
   */
  app.post("/api/pos/retail/discount-approvals", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const cashierUserId = currentUserId(req);
      const body = approvalRequestSchema.parse(req.body ?? {});
      const settings = await loadRetailSettings(companyId);
      const [cashierRole] = await db
        .select({ role: userCompanyRoles.role })
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, cashierUserId), eq(userCompanyRoles.companyId, companyId)))
        .limit(1);

      if (isRetailManagerRole(cashierRole?.role)) {
        return res.json({ required: false, reason: "manager_role_exempt" });
      }

      // Price the requested cart from the database list prices, so the effective discount and
      // the fingerprint cannot be forged by the client.
      const variantIds = [...new Set(body.items.map((item) => item.variantId))];
      const variantRows = await db
        .select({
          id: retailProductVariants.id,
          sellingPrice: retailProductVariants.sellingPrice,
        })
        .from(retailProductVariants)
        .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
        .where(
          and(
            inArray(retailProductVariants.id, variantIds),
            eq(retailProductVariants.companyId, companyId),
            eq(retailProducts.companyId, companyId)
          )
        );
      const priceByVariant = new Map(variantRows.map((row) => [row.id, Number(row.sellingPrice ?? 0)]));
      for (const item of body.items) {
        if (!priceByVariant.has(item.variantId)) {
          return res.status(400).json({ message: "Retail variant not found or inactive" });
        }
      }

      const orderDiscount = { type: body.orderDiscount?.type ?? "none", value: body.orderDiscount?.value ?? 0 };
      const priced = priceRetailCart(
        body.items.map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
          listUnitPrice: priceByVariant.get(item.variantId) ?? 0,
          priceOverride: item.priceOverride ?? null,
          discountType: item.discountType ?? "none",
          discountValue: item.discountValue ?? 0,
        })),
        orderDiscount,
        { enabled: false, rate: 0, inclusive: false }
      );
      const manual = hasManualAdjustment(priced, orderDiscount);
      const effectiveDiscountPercent = effectiveManualDiscountPercent(priced);
      const policy = evaluateRetailDiscountPolicy({
        role: cashierRole?.role,
        discountLimitPercent: settings.discountLimitPercent,
        requireManagerApproval: settings.requireManagerApproval,
        priceOverrideRequiresApproval: settings.priceOverrideRequiresApproval,
        effectiveDiscountPercent,
        hasPriceOverride: priced.lines.some((line) => line.priceOverride),
        hasManualDiscount: manual.any,
      });
      if (!policy.requiresApproval) {
        return res.json({
          required: false,
          effectiveDiscountPercent,
          discountLimitPercent: settings.discountLimitPercent,
          reasons: [],
        });
      }

      const [manager] = await db
        .select({
          id: users.id,
          username: users.username,
          password: users.password,
          active: users.active,
          role: userCompanyRoles.role,
        })
        .from(users)
        .innerJoin(
          userCompanyRoles,
          and(eq(userCompanyRoles.userId, users.id), eq(userCompanyRoles.companyId, companyId))
        )
        .where(eq(users.username, body.managerUsername))
        .limit(1);
      if (!manager || !manager.active || !isRetailManagerRole(manager.role)) {
        return res.status(401).json({ message: "Manager credentials are not valid for this company" });
      }
      const { valid } = await verifyPassword(body.managerPassword, manager.password);
      if (!valid) {
        return res.status(401).json({ message: "Manager credentials are not valid for this company" });
      }

      const tokenId = crypto.randomUUID();
      const allowsPriceOverride = priced.lines.some((line) => line.priceOverride);
      const expiresAt = new Date(Date.now() + RETAIL_APPROVAL_TOKEN_TTL_MS);
      const fingerprint = retailApprovalFingerprint(body.items, orderDiscount);
      const [approval] = await db
        .insert(retailDiscountApprovals)
        .values({
          companyId,
          tokenId,
          managerUserId: manager.id,
          managerName: manager.username,
          cashierUserId,
          reason: body.reason?.trim() ? body.reason.trim() : null,
          requestedDiscountPercent: effectiveDiscountPercent.toFixed(2),
          allowsPriceOverride,
          expiresAt,
        })
        .returning({ id: retailDiscountApprovals.id });

      const token = signRetailApprovalToken({
        tokenId,
        companyId,
        cashierUserId,
        managerUserId: manager.id,
        managerName: manager.username,
        maxDiscountPercent: effectiveDiscountPercent,
        allowsPriceOverride,
        fingerprint,
        expiresAt: expiresAt.getTime(),
      });
      res.status(201).json({
        required: true,
        approvalId: approval.id,
        approvalToken: token,
        managerName: manager.username,
        maxDiscountPercent: effectiveDiscountPercent,
        allowsPriceOverride,
        reasons: policy.reasons,
        discountLimitPercent: settings.discountLimitPercent,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
