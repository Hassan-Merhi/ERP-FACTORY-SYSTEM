import { and, eq, inArray } from "drizzle-orm";
import { locations } from "@shared/schema";
import type { DbTransaction } from "../../db";

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
