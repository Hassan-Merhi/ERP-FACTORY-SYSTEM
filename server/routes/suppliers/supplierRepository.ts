import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { stockGroups } from "@shared/schema";
import { companyScopedSuppliers, type InsertCompanyScopedSupplier } from "@shared/schema/supplierCompanyScope";
import type { CreateSupplierInput } from "../../storage/suppliers";

import { db } from "../../db";
import { storage } from "../../storage";
import { higherPriorityTargetsAbsent } from "../../services/accounting/balances/partyLineRules";

export const supplierRepository = {
  list(companyId: number, search?: string) {
    return storage.getAllSuppliers(search || undefined, search ? 50 : undefined, companyId);
  },

  listAll(companyId: number) {
    return storage.getAllSuppliers(undefined, undefined, companyId);
  },

  /**
   * Suppliers of other companies that carry lines posted in this company
   * (owner decision 2, wave 13: a payable counts in the posting company), so
   * the Suppliers page lists the payable the company itself booked. Only the
   * lines the balance engine attributes to the supplier are considered.
   */
  async listPostedFromOtherCompanies(companyId: number) {
    const owned = sql.raw(higherPriorityTargetsAbsent("ve", "supplier_id"));
    const rows = await db.execute<{ supplier_id: number }>(sql`
      SELECT DISTINCT ve.supplier_id
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false
         AND ve.supplier_id IS NOT NULL AND ${owned}
    `);
    const ids = rows.rows.map((row) => Number(row.supplier_id));
    if (ids.length === 0) return [];
    return db
      .select()
      .from(companyScopedSuppliers)
      .where(and(inArray(companyScopedSuppliers.id, ids), ne(companyScopedSuppliers.companyId, companyId)));
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
