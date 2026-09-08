import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../../db";
import { salesItems, stockItems, vouchers } from "@shared/schema";
import { toInventoryDecimal } from "../../lib/inventoryMath";
import { updatePosSale } from "./edit/updateSaleService";
import { logAudit } from "../../routes/helpers/auditHelpers";
import {
  buildPosReplacementSaleItems,
  type PosItemReplacementInput,
} from "./itemReplacementPlan";

export type { PosItemReplacementInput } from "./itemReplacementPlan";

export interface PosItemReplacementActor {
  companyId: number;
  locationId: number;
  userId: number;
  username: string;
  userRole?: string | null;
  canSellNegativeStock: boolean;
}

export async function listPosItemReplacementCandidates(params: {
  companyId: number;
  locationId: number;
  stockItemId: number;
  from?: string;
  to?: string;
}) {
  const conditions = [
    eq(vouchers.companyId, params.companyId),
    eq(vouchers.locationId, params.locationId),
    eq(vouchers.voucherType, "Sales"),
    isNull(vouchers.deletedAt),
    eq(salesItems.stockItemId, params.stockItemId),
    eq(stockItems.companyId, params.companyId),
  ];

  if (params.from) conditions.push(gte(vouchers.voucherDate, params.from));
  if (params.to) conditions.push(lte(vouchers.voucherDate, params.to));

  return db
    .select({
      saleItemId: salesItems.id,
      voucherId: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      voucherDate: vouchers.voucherDate,
      description: vouchers.description,
      locationId: vouchers.locationId,
      shiftId: vouchers.shiftId,
      isCreditSale: vouchers.isCreditSale,
      stockItemId: salesItems.stockItemId,
      stockItemName: stockItems.name,
      stockItemCode: stockItems.code,
      quantity: salesItems.quantity,
      sellingPrice: salesItems.sellingPrice,
      totalSales: salesItems.totalSales,
    })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
    .where(and(...conditions))
    .orderBy(desc(vouchers.voucherDate), desc(vouchers.id), desc(salesItems.id))
    .limit(500);
}

export async function applyPosItemReplacements(
  actor: PosItemReplacementActor,
  replacements: PosItemReplacementInput[]
): Promise<{ status: number; body: any }> {
  if (!replacements.length) {
    return { status: 400, body: { message: "At least one replacement is required" } };
  }

  const saleItemIds = Array.from(new Set(replacements.map((row) => row.saleItemId)));
  const replacementItemIds = Array.from(new Set(replacements.map((row) => row.replacementStockItemId)));

  const requestedSaleRows = await db
    .select({
      saleItem: salesItems,
      voucherId: vouchers.id,
      voucherLocationId: vouchers.locationId,
      voucherDeletedAt: vouchers.deletedAt,
      voucherType: vouchers.voucherType,
    })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(inArray(salesItems.id, saleItemIds), eq(vouchers.companyId, actor.companyId)));

  const saleRowById = new Map(requestedSaleRows.map((row) => [row.saleItem.id, row]));
  for (const saleItemId of saleItemIds) {
    const row = saleRowById.get(saleItemId);
    if (!row) {
      return { status: 404, body: { message: `Sale item ${saleItemId} was not found in this company` } };
    }
    if (row.voucherDeletedAt || row.voucherType !== "Sales") {
      return { status: 400, body: { message: `Sale item ${saleItemId} does not belong to an active Sales voucher` } };
    }
    if (row.voucherLocationId !== actor.locationId) {
      return { status: 400, body: { message: `Sale item ${saleItemId} is not from the selected location` } };
    }
  }

  const replacementStockRows = await db
    .select({ id: stockItems.id, name: stockItems.name, code: stockItems.code })
    .from(stockItems)
    .where(
      and(
        inArray(stockItems.id, replacementItemIds),
        eq(stockItems.companyId, actor.companyId),
        isNull(stockItems.deletedAt)
      )
    );
  const replacementStockById = new Map(replacementStockRows.map((row) => [row.id, row]));
  for (const stockItemId of replacementItemIds) {
    if (!replacementStockById.has(stockItemId)) {
      return { status: 404, body: { message: `Replacement stock item ${stockItemId} was not found in this company` } };
    }
  }

  const replacementsBySaleItem = new Map<number, PosItemReplacementInput[]>();
  for (const replacement of replacements) {
    if (!Number.isFinite(replacement.quantity) || replacement.quantity <= 0) {
      return { status: 400, body: { message: "Replacement quantity must be greater than zero" } };
    }
    const sourceRow = saleRowById.get(replacement.saleItemId)!;
    if (sourceRow.saleItem.stockItemId === replacement.replacementStockItemId) {
      return { status: 400, body: { message: "Replacement item must be different from the original item" } };
    }
    const rows = replacementsBySaleItem.get(replacement.saleItemId) || [];
    rows.push(replacement);
    replacementsBySaleItem.set(replacement.saleItemId, rows);
  }

  for (const [saleItemId, rows] of replacementsBySaleItem) {
    const originalQty = toInventoryDecimal(saleRowById.get(saleItemId)!.saleItem.quantity);
    const totalReplaceQty = rows.reduce(
      (sum, row) => sum.plus(toInventoryDecimal(row.quantity)),
      toInventoryDecimal(0)
    );
    if (totalReplaceQty.greaterThan(originalQty)) {
      return {
        status: 400,
        body: {
          message: `Replacement quantity for sale item ${saleItemId} exceeds the sold quantity ${originalQty.toString()}`,
        },
      };
    }
  }

  const voucherIds = Array.from(new Set(requestedSaleRows.map((row) => row.voucherId)));
  const voucherRows = await db.select().from(vouchers).where(inArray(vouchers.id, voucherIds));
  const voucherById = new Map(voucherRows.map((row) => [row.id, row]));
  const allSaleItems = await db.select().from(salesItems).where(inArray(salesItems.voucherId, voucherIds));
  const saleItemsByVoucher = new Map<number, typeof allSaleItems>();
  for (const row of allSaleItems) {
    const current = saleItemsByVoucher.get(row.voucherId) || [];
    current.push(row);
    saleItemsByVoucher.set(row.voucherId, current);
  }

  const replacementVoucherIds = new Map<number, Set<number>>();
  for (const replacement of replacements) {
    const voucherId = saleRowById.get(replacement.saleItemId)!.voucherId;
    const set = replacementVoucherIds.get(voucherId) || new Set<number>();
    set.add(replacement.saleItemId);
    replacementVoucherIds.set(voucherId, set);
  }

  const completedVoucherIds: number[] = [];
  let replacedQuantity = toInventoryDecimal(0);

  for (const voucherId of voucherIds.sort((a, b) => a - b)) {
    const voucher = voucherById.get(voucherId);
    if (!voucher || !voucher.locationId) {
      return {
        status: 400,
        body: { message: `Voucher ${voucherId} is missing its location`, completedVoucherIds },
      };
    }

    const originalItems = (saleItemsByVoucher.get(voucherId) || []).sort((a, b) => a.id - b.id);
    const built = buildPosReplacementSaleItems(originalItems, replacementsBySaleItem);
    replacedQuantity = replacedQuantity.plus(toInventoryDecimal(built.replacedQuantity));

    const result = await updatePosSale({
      voucherId,
      currentCompanyId: actor.companyId,
      userId: actor.userId,
      username: actor.username,
      userRole: actor.userRole || undefined,
      canSellNegativeStock: actor.canSellNegativeStock,
      body: {
        description: voucher.description,
        items: built.items,
        isCreditSale: Boolean(voucher.isCreditSale),
        voucherDate: voucher.voucherDate,
        locationId: voucher.locationId,
      },
    });

    if (result.status !== 200) {
      const baseMessage = result.body?.message || `Failed to update voucher ${voucher.voucherNumber}`;
      const partialMessage = completedVoucherIds.length
        ? `${baseMessage}. ${completedVoucherIds.length} earlier POS sale${completedVoucherIds.length === 1 ? " was" : "s were"} already updated.`
        : baseMessage;
      return {
        status: result.status,
        body: {
          message: partialMessage,
          failedVoucherId: voucherId,
          completedVoucherIds,
        },
      };
    }

    completedVoucherIds.push(voucherId);

    try {
      const affectedSaleItemIds = Array.from(replacementVoucherIds.get(voucherId) || []);
      const auditRows = replacements
        .filter((row) => affectedSaleItemIds.includes(row.saleItemId))
        .map((row) => ({
          saleItemId: row.saleItemId,
          fromStockItemId: saleRowById.get(row.saleItemId)!.saleItem.stockItemId,
          toStockItemId: row.replacementStockItemId,
          quantity: row.quantity,
        }));
      await logAudit({
        userId: actor.userId,
        username: actor.username,
        companyId: actor.companyId,
        action: "update",
        tableName: "sales_items",
        recordId: voucherId,
        recordIdentifier: voucher.voucherNumber,
        changes: { posItemReplacement: { old: null, new: auditRows } },
      });
    } catch {
      // The underlying sale edit has its own audit entry. Extra replacement
      // detail is useful, but it must never make a valid correction fail.
    }
  }

  return {
    status: 200,
    body: {
      message: `Updated ${completedVoucherIds.length} POS sale${completedVoucherIds.length === 1 ? "" : "s"}`,
      updatedVoucherIds: completedVoucherIds,
      replacedQuantity: replacedQuantity.toString(),
      replacementsApplied: replacements.length,
    },
  };
}
