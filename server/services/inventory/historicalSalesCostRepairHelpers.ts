// Extracted from ./historicalSalesCostRepair.ts
import type { PoolClient } from "pg";

/**
 * Fails when historical source evidence was back-dated or edited after the
 * dry-run cutoff. Normal new stock activity after the cutoff is allowed.
 * Shared by the full apply and the proven-rows-only partial apply.
 */
export async function assertNoHistoricalSourceEditsAfterCutoff(
  client: PoolClient,
  targetCompanyIds: number[],
  sourceCutoff: Date
): Promise<void> {
  const sourceDrift = await client.query<{
    kind: string;
    evidence_id: string;
  }>(
    `SELECT 'backdated-canonical'::text AS kind,id::text AS evidence_id
       FROM canonical_stock_movements
      WHERE company_id = ANY($1::int[])
        AND created_at > $2
        AND occurred_at <= $2
      UNION ALL
     SELECT 'historical-voucher-edit'::text AS kind,a.id::text AS evidence_id
       FROM audit_log a
       JOIN vouchers v
         ON a.table_name='vouchers'
        AND a.record_id=v.id
        AND v.company_id=a.company_id
      WHERE a.company_id = ANY($1::int[])
        AND a.created_at > $2
        AND v.created_at <= $2
      UNION ALL
     SELECT 'historical-container-edit'::text AS kind,a.id::text AS evidence_id
       FROM audit_log a
       JOIN containers c
         ON a.table_name='containers'
        AND a.record_id=c.id
        AND c.company_id=a.company_id
      WHERE a.company_id = ANY($1::int[])
        AND a.created_at > $2
        AND c.created_at <= $2
      ORDER BY kind,evidence_id
      LIMIT 25`,
    [targetCompanyIds, sourceCutoff]
  );
  if (sourceDrift.rows.length > 0) {
    throw new Error(
      `Historical sales cost repair source evidence changed after dry run: ${sourceDrift.rows
        .map((row) => `${row.kind}#${row.evidence_id}`)
        .join(", ")}. Build and review a new dry run.`
    );
  }
}
