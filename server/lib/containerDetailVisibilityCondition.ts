import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { containers } from "@shared/schema";

/**
 * Permit the active company to read its own container. A linked destination
 * may read the canonical container only when the optional intercompany schema
 * exists and an active trade explicitly grants that destination access.
 *
 * Never reference a missing optional relation in the generated SQL: PostgreSQL
 * resolves every relation in an OR expression, even when the other arm is true.
 */
export function containerDetailVisibilityCondition(
  containerId: number,
  companyId: number,
  hasTradeTable: boolean
): SQL {
  const ownedByCompany = eq(containers.companyId, companyId);
  const visibleToCompany = hasTradeTable
    ? or(
        ownedByCompany,
        sql`EXISTS (
          SELECT 1 FROM intercompany_trades trade
          WHERE trade.physical_container_id = ${containers.id}
            AND trade.destination_company_id = ${companyId}
            AND trade.source_company_id = ${containers.companyId}
            AND trade.state = 'active'
        )`
      )
    : ownedByCompany;

  return and(eq(containers.id, containerId), visibleToCompany)!;
}
