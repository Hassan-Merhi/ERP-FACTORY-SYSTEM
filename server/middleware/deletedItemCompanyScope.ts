import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import {
  bankAccounts,
  customerOrders,
  customerProformas,
  customers,
  employees,
  factoryBaleProducts,
  factoryBales,
  factoryCategories,
  factoryContainers,
  factoryMixBatches,
  factoryRawMaterialAdjustments,
  factoryRawStock,
  ledgerAccounts,
  locations,
  stockGroups,
  stockItems,
  suppliers,
  vouchers,
} from "@shared/schema";
import { db } from "../db";
import { logger } from "../lib/logger";
import { resolveActiveCompanyId } from "../routes/helpers/resolveActiveCompanyId";
import { classifyDeletedItemScope, type DeletedItemScopeType } from "../services/security/deletedItemScopePolicy";
import type { CompanyScopedTable } from "../types/companyScopedTable";

/**
 * Which table owns each deletable entity. The table alone is enough: the
 * ownership probe below reads `id`/`companyId` off it, so a mapping can no
 * longer name one table and another table's columns.
 */
const SCOPE_TABLES: Partial<Record<DeletedItemScopeType, CompanyScopedTable>> = {
  location: locations,
  stockItem: stockItems,
  stockGroup: stockGroups,
  ledgerAccount: ledgerAccounts,
  employee: employees,
  customer: customers,
  bankAccount: bankAccounts,
  voucher: vouchers,
  orphanedPosSale: vouchers,
  factoryCategory: factoryCategories,
  factoryBaleProduct: factoryBaleProducts,
  factoryContainer: factoryContainers,
  factoryRawStock: factoryRawStock,
  factoryRawMaterialAdjustment: factoryRawMaterialAdjustments,
  factoryMixBatch: factoryMixBatches,
  factoryBale: factoryBales,
  customerProforma: customerProformas,
  customerOrder: customerOrders,
};

async function loadCompanyId(type: DeletedItemScopeType, id: number): Promise<number | null> {
  const table = SCOPE_TABLES[type];
  if (!table) return null;

  const [row] = await db.select({ companyId: table.companyId }).from(table).where(eq(table.id, id)).limit(1);
  // The driver types this column as unknown; a deleted row's company is only
  // usable as a scope decision when it really is a positive integer.
  const companyId = Number(row?.companyId);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function deny(req: Request, res: Response, reason: string, status: number, message: string): false {
  logger.error(
    JSON.stringify({
      event: "deleted_item_scope_denied",
      ts: new Date().toISOString(),
      userId: req.session.userId ?? null,
      role: req.session.currentRole ?? null,
      companyId: resolveActiveCompanyId(req),
      method: req.method,
      path: req.path,
      reason,
    })
  );
  res.status(status).json({ message });
  return false;
}

export async function enforceDeletedItemCompanyScope(req: Request, res: Response): Promise<boolean> {
  const match = classifyDeletedItemScope(req.path);
  if (!match) return true;

  const companyId = Number(resolveActiveCompanyId(req));
  const role = req.session.currentRole;
  if (!req.session.userId || !role || !Number.isSafeInteger(companyId) || companyId <= 0) {
    return true;
  }

  if (match.globalMaintenance) {
    if (role !== "Developer") {
      return deny(
        req,
        res,
        "GLOBAL_SUPPLIER_MAINTENANCE_REQUIRES_DEVELOPER",
        403,
        "Developer access required for global supplier maintenance"
      );
    }

    const [supplier] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, match.id)).limit(1);
    if (!supplier) return deny(req, res, "DELETED_ITEM_NOT_FOUND", 404, "Item not found");
    return true;
  }

  const recordCompanyId = await loadCompanyId(match.type, match.id);
  if (recordCompanyId == null || recordCompanyId !== companyId) {
    return deny(req, res, "DELETED_ITEM_COMPANY_MISMATCH", 404, "Item not found");
  }

  return true;
}
