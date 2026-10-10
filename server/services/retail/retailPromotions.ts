/**
 * Retail Wave 2 promotion framework (deliberately small).
 *
 * A promotion is a date-windowed discount on a catalogue scope (`all`, `brand`,
 * `product`, `variant`). Checkout resolves the best active promotion per line and
 * folds it into the line discount snapshot; the sale line keeps the promotion id.
 * There are no coupons, stacking rules or conditions yet.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { retailPromotions } from "@shared/schema";
import type { RetailPromotionMatch } from "./retailPricing";
import { db } from "../../db";

export type RetailPromotionScopeValue = "all" | "brand" | "product" | "variant";
export type RetailPromotionDiscountTypeValue = "percent" | "fixed";

export interface RetailPromotionRow {
  id: number;
  companyId: number;
  name: string;
  scope: string;
  brandId: number | null;
  productId: number | null;
  variantId: number | null;
  discountType: string;
  value: string | number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
  priority: number;
}

export interface RetailPromotionInput {
  name: string;
  description?: string | null;
  scope: RetailPromotionScopeValue;
  brandId?: number | null;
  productId?: number | null;
  variantId?: number | null;
  discountType: RetailPromotionDiscountTypeValue;
  value: number;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  active?: boolean;
  priority?: number;
}

export function validateRetailPromotionInput(input: RetailPromotionInput): RetailPromotionInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("Promotion name is required");
  if (name.length > 160) throw new Error("Promotion name cannot exceed 160 characters");
  if (!["all", "brand", "product", "variant"].includes(input.scope)) throw new Error("Invalid promotion scope");
  if (!["percent", "fixed"].includes(input.discountType)) throw new Error("Invalid promotion discount type");
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Promotion value must be greater than zero");
  if (input.discountType === "percent" && value > 100) throw new Error("Promotion percent cannot exceed 100");
  const scopeId: Record<string, number | null | undefined> = {
    brand: input.brandId,
    product: input.productId,
    variant: input.variantId,
  };
  if (input.scope !== "all" && !scopeId[input.scope]) {
    throw new Error(`Promotion scope '${input.scope}' requires its ${input.scope} id`);
  }
  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) throw new Error("Invalid promotion start date");
  if (endsAt && Number.isNaN(endsAt.getTime())) throw new Error("Invalid promotion end date");
  if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
    throw new Error("Promotion end date cannot be before its start date");
  }
  return {
    ...input,
    name,
    value,
    startsAt,
    endsAt,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    active: input.active !== false,
  };
}

export function isPromotionActiveAt(
  row: Pick<RetailPromotionRow, "active" | "startsAt" | "endsAt">,
  at: Date
): boolean {
  if (!row.active) return false;
  if (row.startsAt && new Date(row.startsAt).getTime() > at.getTime()) return false;
  if (row.endsAt && new Date(row.endsAt).getTime() < at.getTime()) return false;
  return true;
}

export interface RetailPromotionVariantContext {
  variantId: number;
  productId: number;
  brandId: number | null;
}

export function promotionMatchesVariant(
  row: Pick<RetailPromotionRow, "scope" | "brandId" | "productId" | "variantId">,
  context: RetailPromotionVariantContext
): boolean {
  switch (row.scope) {
    case "all":
      return true;
    case "brand":
      return row.brandId !== null && row.brandId === context.brandId;
    case "product":
      return row.productId !== null && row.productId === context.productId;
    case "variant":
      return row.variantId !== null && row.variantId === context.variantId;
    default:
      return false;
  }
}

function perUnitDiscount(row: Pick<RetailPromotionRow, "discountType" | "value">, listUnitPrice: number): number {
  const value = Number(row.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const discount = row.discountType === "percent" ? (listUnitPrice * Math.min(value, 100)) / 100 : value;
  return Math.min(Math.max(discount, 0), listUnitPrice);
}

/**
 * Picks the best promotion for one line: highest priority first, then the largest
 * per-unit discount, then the newest id. Returns the match the pricing engine needs.
 */
export function bestPromotionForLine(
  rows: RetailPromotionRow[],
  context: RetailPromotionVariantContext,
  listUnitPrice: number,
  at: Date = new Date()
): RetailPromotionMatch | null {
  let best: { row: RetailPromotionRow; discount: number } | null = null;
  for (const row of rows) {
    if (!isPromotionActiveAt(row, at)) continue;
    if (!promotionMatchesVariant(row, context)) continue;
    const discount = perUnitDiscount(row, listUnitPrice);
    if (discount <= 0) continue;
    if (
      !best ||
      row.priority > best.row.priority ||
      (row.priority === best.row.priority && discount > best.discount) ||
      (row.priority === best.row.priority && discount === best.discount && row.id > best.row.id)
    ) {
      best = { row, discount };
    }
  }
  if (!best) return null;
  return {
    id: best.row.id,
    discountType: best.row.discountType === "percent" ? "percent" : "fixed",
    value: Number(best.row.value),
  };
}

/** All active promotions for a company (promotion sets are small and cached per checkout). */
export async function listActiveRetailPromotions(
  companyId: number,
  at: Date = new Date()
): Promise<RetailPromotionRow[]> {
  const rows = await db
    .select()
    .from(retailPromotions)
    .where(
      and(
        eq(retailPromotions.companyId, companyId),
        eq(retailPromotions.active, true),
        or(sql`${retailPromotions.startsAt} IS NULL`, sql`${retailPromotions.startsAt} <= ${at}`),
        or(sql`${retailPromotions.endsAt} IS NULL`, sql`${retailPromotions.endsAt} >= ${at}`)
      )
    )
    .orderBy(sql`${retailPromotions.priority} DESC`, retailPromotions.id);
  return rows as RetailPromotionRow[];
}

export async function listRetailPromotions(companyId: number): Promise<RetailPromotionRow[]> {
  const rows = await db
    .select()
    .from(retailPromotions)
    .where(eq(retailPromotions.companyId, companyId))
    .orderBy(sql`${retailPromotions.active} DESC`, sql`${retailPromotions.priority} DESC`, retailPromotions.name);
  return rows as RetailPromotionRow[];
}

export async function createRetailPromotion(
  companyId: number,
  input: RetailPromotionInput,
  userId: string
): Promise<RetailPromotionRow> {
  const clean = validateRetailPromotionInput(input);
  const [row] = await db
    .insert(retailPromotions)
    .values({
      companyId,
      name: clean.name,
      description: clean.description?.trim() || null,
      scope: clean.scope,
      brandId: clean.scope === "brand" ? (clean.brandId ?? null) : null,
      productId: clean.scope === "product" ? (clean.productId ?? null) : null,
      variantId: clean.scope === "variant" ? (clean.variantId ?? null) : null,
      discountType: clean.discountType,
      value: String(clean.value),
      startsAt: clean.startsAt ? new Date(clean.startsAt) : null,
      endsAt: clean.endsAt ? new Date(clean.endsAt) : null,
      active: clean.active !== false,
      priority: clean.priority ?? 0,
      createdBy: userId,
      updatedAt: new Date(),
    })
    .returning();
  return row as RetailPromotionRow;
}

export async function updateRetailPromotion(
  companyId: number,
  promotionId: number,
  patch: Partial<RetailPromotionInput>
): Promise<RetailPromotionRow | null> {
  const [existing] = await db
    .select()
    .from(retailPromotions)
    .where(and(eq(retailPromotions.companyId, companyId), eq(retailPromotions.id, promotionId)))
    .limit(1);
  if (!existing) return null;
  const merged = validateRetailPromotionInput({
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    scope: (patch.scope ?? existing.scope) as RetailPromotionScopeValue,
    brandId: patch.brandId ?? existing.brandId,
    productId: patch.productId ?? existing.productId,
    variantId: patch.variantId ?? existing.variantId,
    discountType: (patch.discountType ?? existing.discountType) as RetailPromotionDiscountTypeValue,
    value: patch.value ?? Number(existing.value),
    startsAt: patch.startsAt ?? existing.startsAt,
    endsAt: patch.endsAt ?? existing.endsAt,
    active: patch.active ?? existing.active,
    priority: patch.priority ?? existing.priority,
  });
  const [row] = await db
    .update(retailPromotions)
    .set({
      name: merged.name,
      description: merged.description?.trim() || null,
      scope: merged.scope,
      brandId: merged.scope === "brand" ? (merged.brandId ?? null) : null,
      productId: merged.scope === "product" ? (merged.productId ?? null) : null,
      variantId: merged.scope === "variant" ? (merged.variantId ?? null) : null,
      discountType: merged.discountType,
      value: String(merged.value),
      startsAt: merged.startsAt ? new Date(merged.startsAt) : null,
      endsAt: merged.endsAt ? new Date(merged.endsAt) : null,
      active: merged.active !== false,
      priority: merged.priority ?? 0,
      updatedAt: new Date(),
    })
    .where(and(eq(retailPromotions.companyId, companyId), eq(retailPromotions.id, promotionId)))
    .returning();
  return (row as RetailPromotionRow) ?? null;
}

export async function deactivateRetailPromotion(companyId: number, promotionId: number): Promise<boolean> {
  const rows = await db
    .update(retailPromotions)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(retailPromotions.companyId, companyId), eq(retailPromotions.id, promotionId)))
    .returning({ id: retailPromotions.id });
  return rows.length > 0;
}

/** Test helper: promotion ids that exist for a company (used by scope validation routes). */
export async function retailPromotionIdsExist(companyId: number, ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  const rows = await db
    .select({ id: retailPromotions.id })
    .from(retailPromotions)
    .where(and(eq(retailPromotions.companyId, companyId), inArray(retailPromotions.id, ids)));
  return rows.length === ids.length;
}
