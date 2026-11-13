/**
 * Read-only destination attribution for supplier purchase orders and the vouchers
 * that those purchase orders posted. Attribution comes from active, verified
 * intercompany trade links; no narration parsing or guessed company IDs.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import {
  companies,
  intercompanyTrades,
  intercompanyTradeSourcePos,
  purchaseOrders,
} from "@shared/schema";
import { db } from "../../db";

export interface SupplierDestination {
  destinationCompanyId: number;
  destinationCompanyName: string;
}

export async function resolveSupplierDestinations(input: {
  accessibleCompanyIds: readonly number[];
  poIds?: readonly number[];
  voucherIds?: readonly number[];
}): Promise<{
  byPoId: Map<number, SupplierDestination>;
  byVoucherId: Map<number, SupplierDestination>;
}> {
  const accessible = [...new Set(input.accessibleCompanyIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  const byPoId = new Map<number, SupplierDestination>();
  const byVoucherId = new Map<number, SupplierDestination>();
  if (accessible.length === 0) return { byPoId, byVoucherId };

  const voucherIds = [...new Set(input.voucherIds ?? [])].filter((id) => Number.isSafeInteger(id) && id > 0);
  const voucherPos = voucherIds.length
    ? await db.select({ id: purchaseOrders.id, voucherId: purchaseOrders.voucherId })
        .from(purchaseOrders)
        .where(and(inArray(purchaseOrders.companyId, accessible), inArray(purchaseOrders.voucherId, voucherIds)))
    : [];
  const ids = [...new Set([...(input.poIds ?? []), ...voucherPos.map((po) => po.id)])]
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return { byPoId, byVoucherId };

  const [linked, direct] = await Promise.all([
    db.select({
      poId: intercompanyTradeSourcePos.sourcePoId,
      destinationCompanyId: intercompanyTrades.destinationCompanyId,
      destinationCompanyName: companies.name,
    })
      .from(intercompanyTradeSourcePos)
      .innerJoin(intercompanyTrades, eq(intercompanyTradeSourcePos.tradeId, intercompanyTrades.id))
      .innerJoin(companies, eq(companies.id, intercompanyTrades.destinationCompanyId))
      .where(and(
        inArray(intercompanyTradeSourcePos.sourcePoId, ids),
        eq(intercompanyTrades.state, "active"),
        inArray(intercompanyTrades.sourceCompanyId, accessible),
        inArray(intercompanyTrades.destinationCompanyId, accessible),
      )),
    db.select({
      originalSupplierPoId: intercompanyTrades.originalSupplierPoId,
      destinationPoId: intercompanyTrades.destinationPoId,
      destinationCompanyId: intercompanyTrades.destinationCompanyId,
      destinationCompanyName: companies.name,
    })
      .from(intercompanyTrades)
      .innerJoin(companies, eq(companies.id, intercompanyTrades.destinationCompanyId))
      .where(and(
        eq(intercompanyTrades.state, "active"),
        inArray(intercompanyTrades.sourceCompanyId, accessible),
        inArray(intercompanyTrades.destinationCompanyId, accessible),
        or(
          inArray(intercompanyTrades.originalSupplierPoId, ids),
          inArray(intercompanyTrades.destinationPoId, ids),
        ),
      )),
  ]);

  const assign = (poId: number | null, destination: SupplierDestination) => {
    if (poId != null && ids.includes(poId)) byPoId.set(poId, destination);
  };
  for (const row of linked) {
    assign(row.poId, { destinationCompanyId: row.destinationCompanyId, destinationCompanyName: row.destinationCompanyName });
  }
  for (const row of direct) {
    const destination = { destinationCompanyId: row.destinationCompanyId, destinationCompanyName: row.destinationCompanyName };
    assign(row.originalSupplierPoId, destination);
    assign(row.destinationPoId, destination);
  }

  // One voucher may theoretically have multiple POs. Only attribute it when
  // every associated PO resolves to the same actual destination.
  const grouped = new Map<number, Array<SupplierDestination | undefined>>();
  for (const po of voucherPos) {
    if (po.voucherId == null) continue;
    const group = grouped.get(po.voucherId) ?? [];
    group.push(byPoId.get(po.id));
    grouped.set(po.voucherId, group);
  }
  for (const [voucherId, destinations] of grouped) {
    const first = destinations[0];
    if (first && destinations.every((destination) => destination?.destinationCompanyId === first.destinationCompanyId)) {
      byVoucherId.set(voucherId, first);
    }
  }
  return { byPoId, byVoucherId };
}
