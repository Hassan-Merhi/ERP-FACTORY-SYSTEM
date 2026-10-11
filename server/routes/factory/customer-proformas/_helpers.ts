/**
 * Shared state and helpers for the factoryCustomerProformaRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryCustomerProformaRoutes.ts.
 */
import { pool } from "../../../db";
import { parseMoneyInput } from "../../../lib/money";

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
