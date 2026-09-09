import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db } from "../../db";
import { salesItems, stockItems, vouchers } from "@shared/schema";
import { toInventoryDecimal } from "../../lib/inventoryMath";
import { applyPosSaleUpdateTx } from "./edit/updateSaleService";
import { fetchSpEditAccountingContext } from "./edit/posEditSaleHelpers";
import { logAudit } from "../../routes/helpers/auditHelpers";
import {
  buildPosReplacementSaleItems,
  type PosItemReplacementInput,
} from "./itemReplacementPlan";

export type { PosItemReplacementInput } from "./itemReplacementPlan";

export interface PosItemReplacementActor {
  companyId: number;
  locationId: number;
  userId: string;
  username: string;
  userRole?: string | null;
  canSellNegativeStock: boolean;
}

class PosReplacementAbort extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(String(body.message || "POS item replacement failed"));
  }
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

  const spContextResult = await fetchSpEditAccountingContext(actor.companyId);
  if ("error" in spContextResult) {
    return { status: spContextResult.error.status, body: spContextResult.error.body };
  }

  try {
    const committed = await db.transaction(async (tx) => {
      const saleItemIds = Array.from(new Set(replacements.map((row) => row.saleItemId)));
      const replacementItemIds = Array.from(new Set(replacements.map((row) => row.replacementStockItemId)));

      // First resolve the target vouchers, then lock every voucher in stable id
      // order. Re-read all sale rows after the locks so the correction plan can
      // never be built from stale lines while another edit is committing.
      const initialSaleRows = await tx
        .select({ saleItemId: salesItems.id, voucherId: vouchers.id })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(and(inArray(salesItems.id, saleItemIds), eq(vouchers.companyId, actor.companyId)));

      if (initialSaleRows.length !== saleItemIds.length) {
        throw new PosReplacementAbort(404, { message: "One or more selected POS sale items no longer exist" });
      }

      const voucherIds = Array.from(new Set(initialSaleRows.map((row) => row.voucherId))).sort((a, b) => a - b);
      await tx
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(and(inArray(vouchers.id, voucherIds), eq(vouchers.companyId, actor.companyId)))
        .orderBy(asc(vouchers.id))
        .for("update");

      const requestedSaleRows = await tx
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
          throw new PosReplacementAbort(409, { message: `Sale item ${saleItemId} changed while the correction was loading` });
        }
        if (row.voucherDeletedAt || row.voucherType !== "Sales") {
          throw new PosReplacementAbort(400, {
            message: `Sale item ${saleItemId} does not belong to an active Sales voucher`,
          });
        }
        if (row.voucherLocationId !== actor.locationId) {
          throw new PosReplacementAbort(400, { message: `Sale item ${saleItemId} is not from the selected location` });
        }
      }

      const replacementStockRows = await tx
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
          throw new PosReplacementAbort(404, {
            message: `Replacement stock item ${stockItemId} was not found in this company`,
          });
        }
      }

      const replacementsBySaleItem = new Map<number, PosItemReplacementInput[]>();
      for (const replacement of replacements) {
        if (!Number.isFinite(replacement.quantity) || replacement.quantity <= 0) {
          throw new PosReplacementAbort(400, { message: "Replacement quantity must be greater than zero" });
        }
        const sourceRow = saleRowById.get(replacement.saleItemId)!;
        if (sourceRow.saleItem.stockItemId === replacement.replacementStockItemId) {
          throw new PosReplacementAbort(400, { message: "Replacement item must be different from the original item" });
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
          throw new PosReplacementAbort(400, {
            message: `Replacement quantity for sale item ${saleItemId} exceeds the sold quantity ${originalQty.toString()}`,
          });
        }
      }

      const voucherRows = await tx.select().from(vouchers).where(inArray(vouchers.id, voucherIds));
      const voucherById = new Map(voucherRows.map((row) => [row.id, row]));
      const allSaleItems = await tx.select().from(salesItems).where(inArray(salesItems.voucherId, voucherIds));
      const saleItemsByVoucher = new Map<number, typeof allSaleItems>();
      for (const row of allSaleItems) {
        const current = saleItemsByVoucher.get(row.voucherId) || [];
        current.push(row);
        saleItemsByVoucher.set(row.voucherId, current);
      }

      const completedVoucherIds: number[] = [];
      const auditRowsByVoucher = new Map<number, Array<Record<string, unknown>>>();
      let replacedQuantity = toInventoryDecimal(0);

      for (const voucherId of voucherIds) {
        const voucher = voucherById.get(voucherId);
        if (!voucher || !voucher.locationId) {
          throw new PosReplacementAbort(400, { message: `Voucher ${voucherId} is missing its location` });
        }

        const originalItems = (saleItemsByVoucher.get(voucherId) || []).sort((a, b) => a.id - b.id);
        const built = buildPosReplacementSaleItems(originalItems, replacementsBySaleItem);
        replacedQuantity = replacedQuantity.plus(toInventoryDecimal(built.replacedQuantity));

        const transactionResult = await applyPosSaleUpdateTx(
          tx,
          {
            voucherId,
            currentCompanyId: actor.companyId,
            userId: actor.userId,
            username: actor.username,
            userRole: actor.userRole || undefined,
            canSellNegativeStock: actor.canSellNegativeStock,
            body: {
              description: voucher.description,
              items: built.items,
              paymentAccountType: undefined,
              paymentAccountId: undefined,
              isCreditSale: Boolean(voucher.isCreditSale),
              voucherDate: voucher.voucherDate,
              locationId: voucher.locationId,
            },
          },
          spContextResult.context
        );

        if (transactionResult.error) {
          throw new PosReplacementAbort(transactionResult.error.status, transactionResult.error.body);
        }

        completedVoucherIds.push(voucherId);
        auditRowsByVoucher.set(
          voucherId,
          replacements
            .filter((row) => saleRowById.get(row.saleItemId)?.voucherId === voucherId)
            .map((row) => ({
              saleItemId: row.saleItemId,
              fromStockItemId: saleRowById.get(row.saleItemId)!.saleItem.stockItemId,
              toStockItemId: row.replacementStockItemId,
              quantity: row.quantity,
            }))
        );
      }

      return {
        updatedVoucherIds: completedVoucherIds,
        replacedQuantity: replacedQuantity.toString(),
        auditRowsByVoucher,
        voucherById,
      };
    });

    // Audit only after the outer transaction commits. If any voucher failed,
    // the transaction rolled back and no misleading partial audit is written.
    for (const voucherId of committed.updatedVoucherIds) {
      try {
        const voucher = committed.voucherById.get(voucherId);
        await logAudit({
          userId: actor.userId,
          username: actor.username,
          companyId: actor.companyId,
          action: "update",
          tableName: "sales_items",
          recordId: voucherId,
          recordIdentifier: voucher?.voucherNumber ?? String(voucherId),
          changes: {
            posItemReplacement: {
              old: null,
              new: committed.auditRowsByVoucher.get(voucherId) || [],
            },
          },
        });
      } catch {
        // Auditing is non-fatal after the committed correction, matching the
        // existing single-sale POS edit behavior.
      }
    }

    return {
      status: 200,
      body: {
        message: `Updated ${committed.updatedVoucherIds.length} POS sale${committed.updatedVoucherIds.length === 1 ? "" : "s"}`,
        updatedVoucherIds: committed.updatedVoucherIds,
        replacedQuantity: committed.replacedQuantity,
        replacementsApplied: replacements.length,
      },
    };
  } catch (error) {
    if (error instanceof PosReplacementAbort) {
      return { status: error.status, body: error.body };
    }
    throw error;
  }
}
