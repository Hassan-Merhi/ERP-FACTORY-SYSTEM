import { and, asc, eq, ilike, isNull } from "drizzle-orm";
import { db } from "../db";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import type { CompanyScopedSupplier, InsertCompanyScopedSupplier } from "@shared/schema/supplierCompanyScope";

export async function getAllSuppliers(
  search?: string,
  limit?: number,
  companyId?: number
): Promise<CompanyScopedSupplier[]> {
  const conditions = [isNull(companyScopedSuppliers.deletedAt)];
  if (companyId) {
    conditions.push(eq(companyScopedSuppliers.companyId, companyId));
  }
  if (search) {
    conditions.push(ilike(companyScopedSuppliers.legalName, `%${search}%`));
  }
  const query = db
    .select()
    .from(companyScopedSuppliers)
    .where(and(...conditions))
    .orderBy(asc(companyScopedSuppliers.legalName));
  return limit ? await query.limit(limit) : await query;
}

export async function getSupplierByCode(code: string, companyId?: number): Promise<CompanyScopedSupplier | undefined> {
  const conditions = [eq(companyScopedSuppliers.code, code), isNull(companyScopedSuppliers.deletedAt)];
  if (companyId) conditions.push(eq(companyScopedSuppliers.companyId, companyId));
  const [supplier] = await db
    .select()
    .from(companyScopedSuppliers)
    .where(and(...conditions));
  return supplier;
}

export async function getSupplierById(id: number, companyId?: number): Promise<CompanyScopedSupplier | undefined> {
  const conditions = [eq(companyScopedSuppliers.id, id), isNull(companyScopedSuppliers.deletedAt)];
  if (companyId) conditions.push(eq(companyScopedSuppliers.companyId, companyId));
  const [supplier] = await db
    .select()
    .from(companyScopedSuppliers)
    .where(and(...conditions));
  return supplier;
}

/**
 * `code` and `email` are optional on the Zod insert schema — callers may propose
 * a code, and the form leaves email blank — but both columns are NOT NULL with
 * no default. The supplier service already allocates a unique code and
 * normalizes email to "" before calling, so requiring them here turns a
 * would-be NOT NULL violation at runtime into a compile error.
 */
export type CreateSupplierInput = InsertCompanyScopedSupplier & { code: string; email: string };

export async function createSupplier(supplier: CreateSupplierInput): Promise<CompanyScopedSupplier> {
  const [created] = await db.insert(companyScopedSuppliers).values(supplier).returning();
  return created;
}

export async function updateSupplier(
  id: number,
  updates: Partial<InsertCompanyScopedSupplier>,
  companyId?: number
): Promise<CompanyScopedSupplier> {
  const conditions = [eq(companyScopedSuppliers.id, id)];
  if (companyId) conditions.push(eq(companyScopedSuppliers.companyId, companyId));
  const [updated] = await db
    .update(companyScopedSuppliers)
    .set(updates)
    .where(and(...conditions))
    .returning();
  if (!updated) throw new Error("Supplier not found");
  return updated;
}

export async function deleteSupplier(id: number, companyId?: number): Promise<void> {
  const conditions = [eq(companyScopedSuppliers.id, id)];
  if (companyId) conditions.push(eq(companyScopedSuppliers.companyId, companyId));
  const [deleted] = await db
    .update(companyScopedSuppliers)
    .set({ deletedAt: new Date(), active: false })
    .where(and(...conditions))
    .returning({ id: companyScopedSuppliers.id });
  if (!deleted) throw new Error("Supplier not found");
}
