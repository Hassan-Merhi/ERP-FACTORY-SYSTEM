/**
 * POS Daybook transfer visibility follows physical stock legs, not the
 * voucher header location (which may be a different source or destination).
 * Every call resolves live company membership and location ownership.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { locations, stockTransferItems, stockTransferVouchers, userLocations, vouchers } from "@shared/schema";
import { db } from "../../db";
import type { ActiveCompanyPermissionContext } from "../security/activeCompanyPermissionContext";

export interface PosTransferScope {
  voucherId: number;
  destinationLocationId: number;
  headerSourceLocationId: number | null;
  visibleSourceLocationIds: ReadonlySet<number>;
  isDestination: boolean;
  displayLocationId: number;
  displayLocationName: string;
}

export function isStockTransferVoucherType(voucherType: string): boolean {
  return ["stocktransfer", "transfer"].includes(voucherType.toLowerCase().replace(/\s+/g, ""));
}

export async function getPosDaybookLocations(
  context: Pick<ActiveCompanyPermissionContext, "userId" | "companyId" | "assignedLocationId">
): Promise<Map<number, string>> {
  const assigned = await db
    .select({ locationId: userLocations.locationId })
    .from(userLocations)
    .where(and(eq(userLocations.userId, context.userId), eq(userLocations.companyId, context.companyId)));
  const candidateIds = [
    ...new Set([...assigned.map((row) => row.locationId), context.assignedLocationId].filter(
      (id): id is number => id != null && Number.isSafeInteger(id) && id > 0
    )),
  ];
  if (!candidateIds.length) return new Map();
  const companyLocations = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.companyId, context.companyId), inArray(locations.id, candidateIds)));
  return new Map(companyLocations.map((location) => [location.id, location.name]));
}

/**
 * One batch lookup for transfer headers and line-source locations. A source
 * cashier sees a transfer only if one of its actual item legs came from an
 * assigned location. A receiving cashier sees every incoming line.
 */
export async function getPosTransferScopes(
  companyId: number,
  voucherIds: readonly number[],
  assignedLocations: ReadonlyMap<number, string>
): Promise<Map<number, PosTransferScope>> {
  const ids = [...new Set(voucherIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length || assignedLocations.size === 0) return new Map();
  const rows: Array<{
    voucherId: number;
    destinationId: number;
    headerSourceId: number | null;
    lineId: number | null;
    lineSourceId: number | null;
  }> = [];
  // One business-day query can still contain thousands of vouchers. Bound
  // Postgres bind parameters rather than relying on a single unbounded IN.
  for (let index = 0; index < ids.length; index += 200) {
    const page = await db
      .select({
        voucherId: stockTransferVouchers.voucherId,
        destinationId: stockTransferVouchers.destinationLocationId,
        headerSourceId: stockTransferVouchers.sourceLocationId,
        lineId: stockTransferItems.id,
        lineSourceId: stockTransferItems.sourceLocationId,
      })
      .from(stockTransferVouchers)
      .innerJoin(
        vouchers,
        and(eq(vouchers.id, stockTransferVouchers.voucherId), eq(vouchers.companyId, companyId))
      )
      .innerJoin(
        locations,
        and(eq(locations.id, stockTransferVouchers.destinationLocationId), eq(locations.companyId, companyId))
      )
      .leftJoin(stockTransferItems, eq(stockTransferItems.transferId, stockTransferVouchers.id))
      .where(and(inArray(stockTransferVouchers.voucherId, ids.slice(index, index + 200)), isNull(vouchers.deletedAt)));
    rows.push(...page);
  }

  const transfers = new Map<number, {
    destinationId: number;
    headerSourceId: number | null;
    sources: Set<number>;
  }>();
  for (const row of rows) {
    let transfer = transfers.get(row.voucherId);
    if (!transfer) {
      transfer = {
        destinationId: row.destinationId,
        headerSourceId: row.headerSourceId,
        sources: new Set<number>(),
      };
      transfers.set(row.voucherId, transfer);
    }
    const source = row.lineId === null ? row.headerSourceId : (row.lineSourceId ?? row.headerSourceId);
    if (source != null) transfer.sources.add(source);
  }

  const result = new Map<number, PosTransferScope>();
  for (const [voucherId, transfer] of transfers) {
    const isDestination = assignedLocations.has(transfer.destinationId);
    const visibleSources = new Set([...transfer.sources].filter((id) => assignedLocations.has(id)));
    if (!isDestination && visibleSources.size === 0) continue;
    const displayLocationId = isDestination
      ? transfer.destinationId
      : [...visibleSources][0];
    result.set(voucherId, {
      voucherId,
      destinationLocationId: transfer.destinationId,
      headerSourceLocationId: transfer.headerSourceId,
      visibleSourceLocationIds: visibleSources,
      isDestination,
      displayLocationId,
      displayLocationName: assignedLocations.get(displayLocationId) ?? "",
    });
  }
  return result;
}

export async function getPosTransferScope(
  context: Pick<ActiveCompanyPermissionContext, "userId" | "companyId" | "assignedLocationId">,
  voucherId: number
): Promise<PosTransferScope | null> {
  const locations = await getPosDaybookLocations(context);
  return (await getPosTransferScopes(context.companyId, [voucherId], locations)).get(voucherId) ?? null;
}

export function posTransferVisibleItems<T extends { sourceLocationId: number | null }>(
  items: readonly T[],
  scope: PosTransferScope
): T[] {
  if (scope.isDestination) return [...items];
  return items.filter((item) =>
    scope.visibleSourceLocationIds.has(item.sourceLocationId ?? scope.headerSourceLocationId ?? -1)
  );
}

/** Remove amounts and irrelevant transactions at the HTTP boundary. */
export async function scopePosDaybookVouchers<
  T extends {
    id: number;
    voucherType: string;
    locationId: number | null;
    locationName: string | null;
    totalAmount: string;
  },
>(rows: T[], context: ActiveCompanyPermissionContext): Promise<T[]> {
  const allowed = await getPosDaybookLocations(context);
  if (!allowed.size) return [];
  const scopes = await getPosTransferScopes(
    context.companyId,
    rows.filter((row) => isStockTransferVoucherType(row.voucherType)).map((row) => row.id),
    allowed
  );
  return rows.flatMap((row) => {
    if (isStockTransferVoucherType(row.voucherType)) {
      const transfer = scopes.get(row.id);
      if (!transfer) return [];
      return [{
        ...row,
        locationId: transfer.displayLocationId,
        locationName: transfer.displayLocationName,
        totalAmount: "0",
      }];
    }
    // POS Daybook is sales plus authorized physical stock transfers, never
    // a side channel for Purchase, Payment, Journal or other ERP records.
    return row.voucherType === "Sales" && row.locationId != null && allowed.has(row.locationId) ? [row] : [];
  });
}
