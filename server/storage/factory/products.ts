import { normalizeSearchText } from "@shared/searchNormalization";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";

export async function getAllBaleProductCategories(companyId: number): Promise<schema.BaleProductCategory[]> {
  return await db
    .select()
    .from(schema.baleProductCategories)
    .where(eq(schema.baleProductCategories.companyId, companyId))
    .orderBy(schema.baleProductCategories.name);
}

export async function getBaleProductCategoryById(id: number): Promise<schema.BaleProductCategory | undefined> {
  const [cat] = await db.select().from(schema.baleProductCategories).where(eq(schema.baleProductCategories.id, id));
  return cat;
}

export async function getBaleProductCategoryByName(
  name: string,
  companyId: number
): Promise<schema.BaleProductCategory | undefined> {
  const [cat] = await db
    .select()
    .from(schema.baleProductCategories)
    .where(and(eq(schema.baleProductCategories.name, name), eq(schema.baleProductCategories.companyId, companyId)));
  return cat;
}

export async function createBaleProductCategory(
  category: schema.InsertBaleProductCategory
): Promise<schema.BaleProductCategory> {
  const [created] = await db.insert(schema.baleProductCategories).values(category).returning();
  return created;
}

export async function updateBaleProductCategory(
  id: number,
  updates: Partial<schema.InsertBaleProductCategory>
): Promise<schema.BaleProductCategory> {
  const [updated] = await db
    .update(schema.baleProductCategories)
    .set({ ...updates, updatedAt: sql`now()` })
    .where(eq(schema.baleProductCategories.id, id))
    .returning();
  return updated;
}

export async function deleteBaleProductCategory(id: number): Promise<void> {
  await db.delete(schema.baleProductCategories).where(eq(schema.baleProductCategories.id, id));
}

export async function getAllBaleProducts(companyId: number): Promise<schema.BaleProduct[]> {
  return await db
    .select()
    .from(schema.baleProducts)
    .where(eq(schema.baleProducts.companyId, companyId))
    .orderBy(schema.baleProducts.code);
}

export async function getBaleProductById(id: number): Promise<schema.BaleProduct | undefined> {
  const [product] = await db.select().from(schema.baleProducts).where(eq(schema.baleProducts.id, id));
  return product;
}

export async function getBaleProductByCode(code: string, companyId: number): Promise<schema.BaleProduct | undefined> {
  const [product] = await db
    .select()
    .from(schema.baleProducts)
    .where(and(eq(schema.baleProducts.code, code), eq(schema.baleProducts.companyId, companyId)));
  return product;
}

export async function getBaleProductByArticleCode(
  articleCode: string,
  companyId: number
): Promise<schema.BaleProduct | undefined> {
  const [product] = await db
    .select()
    .from(schema.baleProducts)
    .where(
      and(
        sql`regexp_replace(lower(coalesce(${schema.baleProducts.articleCode}::text, '')), '[^[:alnum:]]+', '', 'g') = ${normalizeSearchText(articleCode)}`,
        eq(schema.baleProducts.companyId, companyId)
      )
    );
  return product;
}

export async function createBaleProduct(product: schema.InsertBaleProduct): Promise<schema.BaleProduct> {
  const valuesWithCode = {
    ...product,
    code: product.code || product.articleCode || `AUTO-${Date.now()}`,
  };
  const [created] = await db.insert(schema.baleProducts).values(valuesWithCode).returning();
  return created;
}

export async function updateBaleProduct(
  id: number,
  updates: Partial<schema.InsertBaleProduct>
): Promise<schema.BaleProduct> {
  const [updated] = await db
    .update(schema.baleProducts)
    .set({ ...updates, updatedAt: sql`now()` })
    .where(eq(schema.baleProducts.id, id))
    .returning();
  return updated;
}

export async function deleteBaleProduct(id: number): Promise<void> {
  await db.delete(schema.baleProducts).where(eq(schema.baleProducts.id, id));
}

export async function bulkCreateBaleProducts(products: schema.InsertBaleProduct[]): Promise<schema.BaleProduct[]> {
  if (products.length === 0) return [];

  const companyIds = new Set(products.map((p) => p.companyId));
  if (companyIds.size > 1) {
    throw new Error("All products must belong to the same company");
  }

  const withCodes = products.map((p) => ({
    ...p,
    code: p.code || p.articleCode || `AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }));

  const codes = withCodes.map((p) => p.code);
  const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate product codes in import: ${duplicates.join(", ")}`);
  }

  return await db.insert(schema.baleProducts).values(withCodes).returning();
}

export async function createBaleLabelPrint(data: schema.InsertBaleLabelPrint): Promise<schema.BaleLabelPrint> {
  const [created] = await db.insert(schema.baleLabelPrints).values(data).returning();
  return created;
}

export async function getBaleLabelPrintByReference(
  referenceNumber: string,
  companyId: number
): Promise<schema.BaleLabelPrint | undefined> {
  const [record] = await db
    .select()
    .from(schema.baleLabelPrints)
    .where(
      and(
        sql`regexp_replace(lower(coalesce(${schema.baleLabelPrints.referenceNumber}::text, '')), '[^[:alnum:]]+', '', 'g') = ${normalizeSearchText(referenceNumber)}`,
        eq(schema.baleLabelPrints.companyId, companyId)
      )
    );
  return record;
}

export async function getBaleLabelPrintsByArticle(
  articleCode: string,
  companyId: number
): Promise<schema.BaleLabelPrint[]> {
  return await db
    .select()
    .from(schema.baleLabelPrints)
    .where(
      and(
        sql`regexp_replace(lower(coalesce(${schema.baleLabelPrints.articleCode}::text, '')), '[^[:alnum:]]+', '', 'g') = ${normalizeSearchText(articleCode)}`,
        eq(schema.baleLabelPrints.companyId, companyId)
      )
    )
    .orderBy(desc(schema.baleLabelPrints.printedAt));
}
