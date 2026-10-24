import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { containerOffloads, containers, type Container } from "@shared/schema";

/**
 * Append the offload-only portion of landed cost to container list responses.
 * Container.grandTotal already includes PO charges (freight, documentation,
 * surcharge, etc.). containerOffloads.totalCharges includes BOTH PO charges
 * and separate offloading charges (including CHG voucher adjustments). Subtract
 * the PO charges before adding the offload-only amount to the displayed total.
 *
 * Fetch all matching offloads in one company-scoped query rather than one
 * query per container. The underlying accounting values are not modified.
 */
export async function enrichContainerListOffloadingCost<T extends Container>(
  rows: T[],
  companyId: number,
): Promise<Array<T & { offloadingCost: string }>> {
  if (rows.length === 0) return [];

  const charges = await db
    .select({
      containerId: containerOffloads.containerId,
      offloadingCost: sql<string>`COALESCE(SUM(${containerOffloads.totalCharges} - COALESCE(${containers.chargesTotal}, 0)), 0)::text`,
    })
    .from(containerOffloads)
    .innerJoin(containers, eq(containers.id, containerOffloads.containerId))
    .where(
      and(
        eq(containers.companyId, companyId),
        inArray(containerOffloads.containerId, rows.map((row) => row.id)),
      ),
    )
    .groupBy(containerOffloads.containerId);

  const chargesByContainer = new Map(charges.map((row) => [row.containerId, row.offloadingCost]));
  return rows.map((row) => ({
    ...row,
    offloadingCost: chargesByContainer.get(row.id) ?? "0",
  }));
}
