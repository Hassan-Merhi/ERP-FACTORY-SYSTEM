/**
 * Retail Wave 2 selling configuration: company tax/discount settings and the simple
 * date-based promotion catalogue.
 *
 * Settings are readable by the POS (checkout needs the active tax + limits) but only
 * non-POS roles may change them or manage promotions.
 */
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { retailBrands, retailProductVariants, retailProducts, retailPromotions } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  createRetailPromotion,
  deactivateRetailPromotion,
  listActiveRetailPromotions,
  listRetailPromotions,
  updateRetailPromotion,
  type RetailPromotionInput,
} from "../services/retail/retailPromotions";
import { loadRetailSettings, saveRetailSettings, validateRetailSettingsPatch } from "../services/retail/retailSettings";
import { currentUserId, requireRetailCompany } from "./pos/retailPosContext";

const settingsPatchSchema = z.object({
  discountLimitPercent: z.coerce.number().finite().optional(),
  requireManagerApproval: z.boolean().optional(),
  priceOverrideRequiresApproval: z.boolean().optional(),
  taxEnabled: z.boolean().optional(),
  taxLabel: z.string().max(40).optional(),
  taxRate: z.coerce.number().finite().optional(),
  taxInclusive: z.boolean().optional(),
});

const promotionBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  scope: z.enum(["all", "brand", "product", "variant"]),
  brandId: z.coerce.number().int().positive().nullable().optional(),
  productId: z.coerce.number().int().positive().nullable().optional(),
  variantId: z.coerce.number().int().positive().nullable().optional(),
  discountType: z.enum(["percent", "fixed"]),
  value: z.coerce.number().finite().positive(),
  startsAt: z.string().trim().min(1).nullable().optional(),
  endsAt: z.string().trim().min(1).nullable().optional(),
  active: z.boolean().optional(),
  priority: z.coerce.number().int().min(-1000).max(1000).optional(),
});

async function assertPromotionScope(companyId: number, input: RetailPromotionInput): Promise<void> {
  if (input.scope === "brand" && input.brandId) {
    const [row] = await db
      .select({ id: retailBrands.id })
      .from(retailBrands)
      .where(and(eq(retailBrands.id, input.brandId), eq(retailBrands.companyId, companyId)))
      .limit(1);
    if (!row) throw new Error("Promotion brand not found for this company");
  }
  if (input.scope === "product" && input.productId) {
    const [row] = await db
      .select({ id: retailProducts.id })
      .from(retailProducts)
      .where(and(eq(retailProducts.id, input.productId), eq(retailProducts.companyId, companyId)))
      .limit(1);
    if (!row) throw new Error("Promotion product not found for this company");
  }
  if (input.scope === "variant" && input.variantId) {
    const [row] = await db
      .select({ id: retailProductVariants.id })
      .from(retailProductVariants)
      .where(and(eq(retailProductVariants.id, input.variantId), eq(retailProductVariants.companyId, companyId)))
      .limit(1);
    if (!row) throw new Error("Promotion variant not found for this company");
  }
}

function serializePromotion(row: Awaited<ReturnType<typeof listRetailPromotions>>[number]) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    brandId: row.brandId,
    productId: row.productId,
    variantId: row.variantId,
    discountType: row.discountType,
    value: Number(row.value),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    active: row.active,
    priority: row.priority,
    status: !row.active ? "inactive" : "active",
  };
}

export function registerRetailSettingsRoutes(app: Express): void {
  /** Checkout reads the current tax + discount policy (defaults when never configured). */
  app.get("/api/pos/retail/settings", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const settings = await loadRetailSettings(companyId);
      res.json({
        ...settings,
        taxRatePercent: Number((settings.taxRate * 100).toFixed(5)),
        canManageSettings: (req.user?.role ?? "") !== "POS",
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Company tax + discount policy (non-POS). */
  app.put("/api/pos/retail/settings", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const patch = settingsPatchSchema.parse(req.body ?? {});
      validateRetailSettingsPatch(patch);
      const settings = await saveRetailSettings(companyId, patch, currentUserId(req));
      res.json({ ...settings, taxRatePercent: Number((settings.taxRate * 100).toFixed(5)) });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Active promotions for POS display (any retail user). */
  app.get("/api/pos/retail/promotions/active", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const rows = await listActiveRetailPromotions(companyId);
      res.json(rows.map(serializePromotion));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Full promotion catalogue, newest first (non-POS). */
  app.get("/api/retail/promotions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const rows = await listRetailPromotions(companyId);
      res.json(rows.map(serializePromotion));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/retail/promotions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = promotionBodySchema.parse(req.body ?? {});
      await assertPromotionScope(companyId, body as RetailPromotionInput);
      const row = await createRetailPromotion(companyId, body as RetailPromotionInput, currentUserId(req));
      res.status(201).json(serializePromotion(row));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/retail/promotions/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const promotionId = Number(req.params.id);
      if (!Number.isInteger(promotionId) || promotionId <= 0) {
        return res.status(400).json({ message: "Invalid promotion" });
      }
      const body = promotionBodySchema.partial().parse(req.body ?? {});
      const [existing] = await db
        .select()
        .from(retailPromotions)
        .where(and(eq(retailPromotions.companyId, companyId), eq(retailPromotions.id, promotionId)))
        .limit(1);
      if (!existing) return res.status(404).json({ message: "Promotion not found" });
      await assertPromotionScope(companyId, {
        scope: (body.scope ?? existing.scope) as RetailPromotionInput["scope"],
        brandId: body.brandId ?? existing.brandId,
        productId: body.productId ?? existing.productId,
        variantId: body.variantId ?? existing.variantId,
      } as RetailPromotionInput);
      const row = await updateRetailPromotion(companyId, promotionId, body as Partial<RetailPromotionInput>);
      if (!row) return res.status(404).json({ message: "Promotion not found" });
      res.json(serializePromotion(row));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Deactivates a promotion (history keeps referencing it). */
  app.delete("/api/retail/promotions/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const promotionId = Number(req.params.id);
      if (!Number.isInteger(promotionId) || promotionId <= 0) {
        return res.status(400).json({ message: "Invalid promotion" });
      }
      const deactivated = await deactivateRetailPromotion(companyId, promotionId);
      if (!deactivated) return res.status(404).json({ message: "Promotion not found" });
      res.json({ id: promotionId, active: false });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
