// Extracted from ./retailSaleService.ts to keep that module under the source-size cap.
import { and, eq } from "drizzle-orm";
import {
  retailBrands,
  retailPosSaleItems,
  retailPosSales,
  retailProducts,
  retailProductVariants,
} from "@shared/schema";
import { type RetailLineDiscountInputType, type RetailOrderDiscountInput, roundRetailMoney } from "./retailPricing";
import type { RetailPromotionRow } from "./retailPromotions";
import type { RetailSellingSettings } from "./retailSettings";
import { db } from "../../db";
import type { RetailPaymentInput } from "./retailFinancialService";
import { loadRetailSalePayments } from "./retailFinancialQueries";

export function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function resolveRetailItemImages(variantImageUrls: unknown, productImageUrls: unknown): string[] {
  const variantImages = stringArray(variantImageUrls);
  return variantImages.length ? variantImages : stringArray(productImageUrls);
}

/** Sale with its exact-variant lines (color, size, barcode, photo) as shown on receipts and history. */
export async function loadSaleResponse(companyId: number, saleId: number) {
  const [sale] = await db
    .select()
    .from(retailPosSales)
    .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
    .limit(1);
  if (!sale) return null;
  const items = await db
    .select({
      id: retailPosSaleItems.id,
      variantId: retailPosSaleItems.variantId,
      quantity: retailPosSaleItems.quantity,
      returnedQuantity: retailPosSaleItems.returnedQuantity,
      originalUnitPrice: retailPosSaleItems.originalUnitPrice,
      unitPrice: retailPosSaleItems.unitPrice,
      grossUnitPrice: retailPosSaleItems.grossUnitPrice,
      lineDiscountAmount: retailPosSaleItems.lineDiscountAmount,
      lineDiscountType: retailPosSaleItems.lineDiscountType,
      lineDiscountValue: retailPosSaleItems.lineDiscountValue,
      discountReason: retailPosSaleItems.discountReason,
      priceOverride: retailPosSaleItems.priceOverride,
      promotionId: retailPosSaleItems.promotionId,
      taxAmount: retailPosSaleItems.taxAmount,
      lineTotal: retailPosSaleItems.lineTotal,
      approvedByUserId: retailPosSaleItems.approvedByUserId,
      name: retailProducts.name,
      code: retailProducts.code,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      sku: retailProductVariants.sku,
      variantImageUrls: retailProductVariants.imageUrls,
      productImageUrls: retailProducts.imageUrls,
      brand: retailBrands.name,
    })
    .from(retailPosSaleItems)
    .innerJoin(retailProductVariants, eq(retailProductVariants.id, retailPosSaleItems.variantId))
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .where(and(eq(retailPosSaleItems.saleId, saleId), eq(retailPosSaleItems.companyId, companyId)));
  const payments = await loadRetailSalePayments(companyId, saleId);
  return {
    ...sale,
    payments,
    customerId: sale.customerId ?? null,
    customerName: sale.customerName ?? "Walk-in",
    listSubtotal: toNumber(sale.listSubtotal),
    discountTotal: toNumber(sale.discountTotal),
    subtotal: toNumber(sale.subtotal),
    orderDiscountType: sale.orderDiscountType ?? "none",
    orderDiscountValue: toNumber(sale.orderDiscountValue),
    orderDiscountAmount: toNumber(sale.orderDiscountAmount),
    orderDiscountReason: sale.orderDiscountReason ?? null,
    taxEnabled: Boolean(sale.taxEnabled),
    taxLabel: sale.taxLabel ?? "Tax",
    taxRate: toNumber(sale.taxRate),
    taxInclusive: Boolean(sale.taxInclusive),
    taxAmount: toNumber(sale.taxAmount),
    totalAmount: toNumber(sale.totalAmount),
    approvedByUserId: sale.approvedByUserId ?? null,
    approvedByName: sale.approvedByName ?? null,
    items: items.map((item) => {
      const { variantImageUrls, productImageUrls, ...rest } = item;
      return {
        ...rest,
        imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
        quantity: toNumber(item.quantity),
        returnedQuantity: toNumber(item.returnedQuantity),
        originalUnitPrice: toNumber(item.originalUnitPrice) || toNumber(item.unitPrice),
        unitPrice: toNumber(item.unitPrice),
        grossUnitPrice: toNumber(item.grossUnitPrice) || toNumber(item.unitPrice),
        lineDiscountAmount: toNumber(item.lineDiscountAmount),
        lineDiscountValue: toNumber(item.lineDiscountValue),
        taxAmount: toNumber(item.taxAmount),
        lineTotal: toNumber(item.lineTotal) || roundRetailMoney(toNumber(item.unitPrice) * toNumber(item.quantity)),
        brand: item.brand ?? "Other / No Brand",
      };
    }),
  };
}

/** Loads an active, company-owned variant or throws; used before every stock write. */
export async function ensureRetailVariant(executor: Pick<typeof db, "select">, companyId: number, variantId: number) {
  const [variant] = await executor
    .select({
      id: retailProductVariants.id,
      productId: retailProductVariants.productId,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      sku: retailProductVariants.sku,
      sellingPrice: retailProductVariants.sellingPrice,
      cost: retailProductVariants.cost,
      active: retailProductVariants.active,
      productName: retailProducts.name,
      productCode: retailProducts.code,
    })
    .from(retailProductVariants)
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .where(
      and(
        eq(retailProductVariants.id, variantId),
        eq(retailProductVariants.companyId, companyId),
        eq(retailProducts.companyId, companyId),
        eq(retailProductVariants.active, true),
        eq(retailProducts.active, true)
      )
    )
    .limit(1);
  if (!variant) throw new Error("Retail variant not found or inactive");
  return variant;
}

export interface RetailSaleLineRequest {
  variantId: number;
  quantity: number;
  priceOverride?: number | null;
  discountType?: RetailLineDiscountInputType | null;
  discountValue?: number | null;
  discountReason?: string | null;
}

export interface RetailSaleApprovalSnapshot {
  approvalId: number | null;
  approvedByUserId: string | null;
  approvedByName: string | null;
}

export interface RetailSaleInput {
  companyId: number;
  locationId: number;
  idempotencyKey: string;
  notes?: string | null;
  items: RetailSaleLineRequest[];
  userId: string;
  username?: string | null;
  canSellNegativeStock: boolean;
  shiftId?: number | null;
  payments?: RetailPaymentInput[];
  customer?: { id: number | null; name: string } | null;
  orderDiscount?: RetailOrderDiscountInput | null;
  /** Company selling settings snapshot (tax + policy). Defaults to Wave 1 behaviour. */
  settings?: RetailSellingSettings | null;
  /** Active promotions for the company; the best match per line is applied automatically. */
  promotions?: RetailPromotionRow[] | null;
  approval?: RetailSaleApprovalSnapshot | null;
}

export interface RetailSaleVariantRow {
  id: number;
  productId: number;
  brandId: number | null;
  color: string;
  size: string;
  sellingPrice: string | number;
  cost: string | number;
  productName: string;
}

export interface RetailSalePricingInput {
  companyId: number;
  items: RetailSaleLineRequest[];
  orderDiscount?: RetailOrderDiscountInput | null;
  settings?: RetailSellingSettings | null;
  promotions?: RetailPromotionRow[] | null;
}
