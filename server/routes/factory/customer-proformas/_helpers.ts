/**
 * Shared state and helpers for the factoryCustomerProformaRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryCustomerProformaRoutes.ts.
 */
import { and, eq, isNull } from "drizzle-orm";
import { customers } from "@shared/schema";
import { db, pool } from "../../../db";
import { parseMoneyInput } from "../../../lib/money";

/** True when the customer exists, is not deleted and belongs to the company. */
export async function customerBelongsToCompany(companyId: number, customerId: unknown): Promise<boolean> {
  const id = Number(customerId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.companyId, companyId), isNull(customers.deletedAt)))
    .limit(1);
  return !!row;
}

export async function autoSavePriceToPriceList(
  companyId: number,
  customerId: number,
  articleCode: string,
  pricePerBale: string | number
) {
  const price = parseMoneyInput(String(pricePerBale))?.toNumber() ?? NaN;
  if (!articleCode || isNaN(price) || price <= 0) return;
  await pool.query(
    `INSERT INTO customer_price_lists (company_id, customer_id, article_code, price_per_bale, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, customer_id, article_code)
     DO UPDATE SET price_per_bale = EXCLUDED.price_per_bale, updated_at = now()`,
    [companyId, customerId, articleCode, price]
  );
}
