// Extracted from ./tradeSync.ts
import { eq } from "drizzle-orm";
import { intercompanyTrades } from "@shared/schema";
import { db } from "../../db";
import { cents } from "./tradeRevisionMath";
import {
  loadTradeTx,
  rejectEdit,
  requireMembership,
  withTradeScope,
  type EditIdentity,
  type Trade,
  type TradeData,
} from "./tradeSyncLoadTradeTx";

export async function assertTradeAccess(tradeId: number, identity: EditIdentity): Promise<Trade> {
  await requireMembership(identity);
  if (!Number.isSafeInteger(tradeId) || tradeId <= 0) rejectEdit("Invalid trade ID", "IC_EDIT_ID", 422);
  const [trade] = await db.select().from(intercompanyTrades).where(eq(intercompanyTrades.id, tradeId));
  if (!trade || ![trade.sourceCompanyId, trade.destinationCompanyId].includes(identity.initiatingCompanyId)) {
    rejectEdit("No linked trade belongs to this company", "IC_EDIT_NOT_FOUND", 404);
  }
  return trade;
}

export function requireUnreceived(data: TradeData) {
  if (
    data.received != null ||
    data.physical.status !== "OTW" ||
    data.physical.offloadDate != null ||
    data.destination.po.status !== "Open" ||
    data.source.some((g) => g.po.status !== "Open")
  ) {
    rejectEdit(
      "Offloaded, sold or reserved inventory needs the later inventory/COGS-safe workflow",
      "IC_EDIT_INVENTORY_DEPENDENCY"
    );
  }
  if (
    [
      data.policy.sourcePurchaseAccountId,
      data.policy.sourceSalesAccountId,
      data.policy.sourceCostAccountId,
      data.policy.sourceReceivableAccountId,
      data.policy.sourceChargeAccrualAccountId,
      data.policy.destinationGitAccountId,
      data.policy.destinationSupplierId,
    ].some((id) => !id)
  ) {
    rejectEdit("Verified accounts or partner supplier are missing");
  }
}

export async function getTradeDetail(tradeId: number, identity: EditIdentity) {
  const trade = await assertTradeAccess(tradeId, identity);
  return withTradeScope(identity, [trade.sourceCompanyId, trade.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      const data = await loadTradeTx(tx, tradeId, false);
      const source = new Map(data.source.flatMap((g) => g.lines.map((l) => [l.id, { po: g.po, line: l }] as const)));
      const dest = new Map(data.destination.lines.map((l) => [l.id, l] as const));
      return {
        tradeId,
        version: data.trade.version,
        containerNumber: data.physical.containerNumber,
        sourceCompanyId: data.trade.sourceCompanyId,
        destinationCompanyId: data.trade.destinationCompanyId,
        physicalStatus: data.physical.status,
        destinationReceivedAt: data.received?.postingDate ?? null,
        destinationReceiptVoucherId: data.received?.receiptVoucherId ?? null,
        landedCost: cents(data.physical.grandTotal ?? "0").toFixed(2),
        goodsCost: cents(data.physical.itemsTotal ?? "0").toFixed(2),
        sourcePos: data.source.map((g) => ({ poId: g.po.id, poNumber: g.po.poNumber, itemsTotal: g.po.itemsTotal })),
        destinationPoId: data.destination.po.id,
        lines: data.links.map((l) => {
          const s = source.get(l.sourceLineId)!,
            d = dest.get(l.destinationLineId)!;
          return {
            lineLinkId: l.id,
            sourcePoId: s.po.id,
            sourcePoNumber: s.po.poNumber,
            sourceLineId: s.line.id,
            destinationLineId: d.id,
            itemName: s.line.itemName,
            quantity: s.line.quantity,
            rate: s.line.rate,
            lineTotal: s.line.lineTotal,
            sourceItemId: s.line.stockItemId,
            destinationItemId: d.stockItemId,
          };
        }),
      };
    })
  );
}
