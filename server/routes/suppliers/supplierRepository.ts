import { and, eq, isNull } from "drizzle-orm";
import { stockGroups } from "@shared/schema";
import { companyScopedSuppliers, type InsertCompanyScopedSupplier } from "@shared/schema/supplierCompanyScope";
import type { CreateSupplierInput } from "../../storage/suppliers";

import { db } from "../../db";
import { storage } from "../../storage";

export const supplierRepository = {
  list(companyId: number, search?: string) {
    return storage.getAllSuppliers(search || undefined, search ? 50 : undefined, companyId);
  },

  listAll(companyId: number) {
    return storage.getAllSuppliers(undefined, undefined, companyId);
  },

  getById(supplierId: number, companyId: number) {
    return storage.getSupplierById(supplierId, companyId);
  },

  getByCode(code: string, companyId: number) {
    return storage.getSupplierByCode(code, companyId);
  },

  create(values: CreateSupplierInput) {
    return storage.createSupplier(values);
  },

  update(supplierId: number, values: Partial<InsertCompanyScopedSupplier>, companyId: number) {
    return storage.updateSupplier(supplierId, values, companyId);
  },

  delete(supplierId: number, companyId: number) {
    return storage.deleteSupplier(supplierId, companyId);
  },

  getContainerCount(supplierId: number, companyId: number) {
    return storage.getContainerCountBySupplier(supplierId, companyId);
  },

  getPurchaseOrders(supplierId: number, companyId: number) {
    return storage.getPurchaseOrdersBySupplier(supplierId, companyId);
  },

  async stockGroupExists(stockGroupId: number, companyId: number): Promise<boolean> {
    const [ownedGroup] = await db
      .select({ id: stockGroups.id })
      .from(stockGroups)
      .where(and(eq(stockGroups.id, stockGroupId), eq(stockGroups.companyId, companyId)))
      .limit(1);
    return Boolean(ownedGroup);
  },

  async updateStockGroup(supplierId: number, companyId: number, stockGroupId: number | null) {
    const [updated] = await db
      .update(companyScopedSuppliers)
      .set({ stockGroupId })
      .where(
        and(
          eq(companyScopedSuppliers.id, supplierId),
          eq(companyScopedSuppliers.companyId, companyId),
          isNull(companyScopedSuppliers.deletedAt)
        )
      )
      .returning();
    return updated ?? null;
  },
};
