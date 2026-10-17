import { and, eq, inArray } from "drizzle-orm";
import { locations, vouchers, stockTransferItems, stockTransferVouchers } from "@shared/schema";
import { db, type DbTransaction } from "../../db";

/** One consistent, location-derived description for transfer voucher headers. */
export function formatStockTransferNarration(sourceNames: readonly string[], destinationName: string): string {
  const uniqueSources = [...new Set(sourceNames.map((name) => name.trim()).filter(Boolean))].sort();
  if (!uniqueSources.length || !destinationName.trim()) {
    throw new Error("Stock transfer narration requires source and destination locations");
  }
  return `Stock Transfer from "${uniqueSources.join(", ")}" to "${destinationName.trim()}"`;
}

/** Resolve names from this company's locations; never trust labels supplied by the browser. */
export async function stockTransferNarrationTx(
  tx: DbTransaction,
  companyId: number,
  sourceIds: readonly number[],
  destinationId: number
): Promise<string> {
  const uniqueSources = [...new Set(sourceIds)];
  if (uniqueSources.length === 0) throw new Error("Stock transfer requires a source location");
  const ids = [...new Set([...uniqueSources, destinationId])];
  const rows = await tx
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, ids)));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const sources = uniqueSources.map((id) => names.get(id));
  const destination = names.get(destinationId);
  if (!destination || sources.some((name) => !name)) {
    throw new Error("Stock transfer narration location was not found in this company");
  }
  return formatStockTransferNarration(sources as string[], destination);
}

/**
 * Read-time narration for legacy transfers whose vouchers were saved without
 * locations (or with the old "transfer to ..." text). A batched lookup avoids
 * one round-trip per row. No historical accounting/stock data is rewritten.
 */
export async function withStockTransferNarrations<T extends {
  id: number;
  voucherType: string;
  description: string | null;
}>(companyId: number, voucherRows: T[]): Promise<T[]> {
  const transferIds = voucherRows
    .filter((row) => ["stocktransfer", "transfer"].includes(row.voucherType.toLowerCase().replace(/\s+/g, "")))
    .map((row) => row.id);
  if (!transferIds.length) return voucherRows;

  const transferLegs = await db
    .select({
      voucherId: stockTransferVouchers.voucherId,
      destinationId: stockTransferVouchers.destinationLocationId,
      itemSourceId: stockTransferItems.sourceLocationId,
      headerSourceId: stockTransferVouchers.sourceLocationId,
    })
    .from(stockTransferVouchers)
    .innerJoin(vouchers, eq(vouchers.id, stockTransferVouchers.voucherId))
    .innerJoin(stockTransferItems, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .where(and(eq(vouchers.companyId, companyId), inArray(stockTransferVouchers.voucherId, transferIds)));

  const ids = [...new Set(transferLegs.flatMap((leg) =>
    [leg.destinationId, leg.itemSourceId ?? leg.headerSourceId].filter((id): id is number => id != null)
  ))];
  if (!ids.length) return voucherRows;
  const namedLocations = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, ids)));
  const namesById = new Map(namedLocations.map((loc) => [loc.id, loc.name]));

  const sourcesByVoucher = new Map<number, { destinationId: number; sources: Set<number> }>();
  for (const leg of transferLegs) {
    const sourceId = leg.itemSourceId ?? leg.headerSourceId;
    if (sourceId == null) continue;
    let entry = sourcesByVoucher.get(leg.voucherId);
    if (!entry) {
      entry = { destinationId: leg.destinationId, sources: new Set<number>() };
      sourcesByVoucher.set(leg.voucherId, entry);
    }
    entry.sources.add(sourceId);
  }

  const narrationById = new Map<number, string>();
  for (const [voucherId, transfer] of sourcesByVoucher) {
    const destination = namesById.get(transfer.destinationId);
    const sources = [...transfer.sources].map((id) => namesById.get(id));
    if (destination && sources.length && sources.every((name): name is string => !!name)) {
      narrationById.set(voucherId, formatStockTransferNarration(sources, destination));
    }
  }
  return voucherRows.map((row) =>
    narrationById.has(row.id) ? { ...row, description: narrationById.get(row.id)! } : row
  );
}
