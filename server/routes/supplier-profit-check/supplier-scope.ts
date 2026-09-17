import { pool } from "../../db";

export interface ProfitCheckSupplierScope {
  id: number;
  ownerCompanyId: number;
  stockGroupId: number | null;
}

/**
 * Profit Check may use a supplier owned by the active ERP company or by its
 * explicitly linked parent company. No legacy/global parent fallback is used:
 * companies.parent_company_id is the only inheritance boundary.
 */
export async function getProfitCheckSupplierScope(
  supplierId: number,
  companyId: number
): Promise<ProfitCheckSupplierScope | null> {
  const result = await pool.query(
    `
    SELECT
      s.id,
      s.company_id,
      s.stock_group_id
    FROM suppliers s
    JOIN companies active_company ON active_company.id = $2
    WHERE s.id = $1
      AND s.deleted_at IS NULL
      AND (
        s.company_id = $2
        OR s.company_id = active_company.parent_company_id
      )
    LIMIT 1
  `,
    [supplierId, companyId]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    ownerCompanyId: Number(row.company_id),
    stockGroupId: row.stock_group_id == null ? null : Number(row.stock_group_id),
  };
}
