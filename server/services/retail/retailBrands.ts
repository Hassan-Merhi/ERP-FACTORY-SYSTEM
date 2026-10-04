import { and, eq } from "drizzle-orm";
import { RETAIL_NO_BRAND_NAME, retailBrands } from "@shared/schema";
import { db } from "../../db";

export type RetailQueryExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete">;

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** Finds a company brand by case/space-insensitive name, creating it on first use. */
export async function getOrCreateBrand(
  executor: RetailQueryExecutor,
  companyId: number,
  requestedName?: string | null
) {
  const name = requestedName?.trim() || RETAIL_NO_BRAND_NAME;
  const normalizedName = normalize(name);
  const [existing] = await executor
    .select()
    .from(retailBrands)
    .where(and(eq(retailBrands.companyId, companyId), eq(retailBrands.normalizedName, normalizedName)))
    .limit(1);

  if (existing) return existing;

  const [created] = await executor
    .insert(retailBrands)
    .values({
      companyId,
      name,
      normalizedName,
      isNoBrand: normalizedName === normalize(RETAIL_NO_BRAND_NAME),
      active: true,
    })
    .returning();

  return created;
}
