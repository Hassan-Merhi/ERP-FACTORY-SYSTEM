// Extracted from ./linkedTradePhysicalDelete.ts
import { and, eq, inArray, or } from "drizzle-orm";
import { intercompanyAuditEvents, intercompanyTrades } from "@shared/schema";
import { db } from "../../db";
import { rejectEdit, type EditIdentity, withTradeScope } from "./tradeSync";

const idsOf = (value: unknown): number[] =>
  Array.isArray(value) && value.every((v) => Number.isSafeInteger(v) && v > 0) ? (value as number[]) : [];

export function deletionVoucherIds(payload: unknown): number[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const list = [
    ...idsOf(record.originalSupplierVoucherIds),
    record.sourceSaleVoucherId,
    record.sourceCostVoucherId,
    record.destinationVoucherId,
  ];
  return list.filter((n): n is number => Number.isSafeInteger(n) && Number(n) > 0);
}

// Resolve the original import vouchers only; other voucher families must
// never be treated as permission to delete their linked financial records.
export async function daybookLinkedVoucherTrades(voucherIds: readonly number[], actor: EditIdentity) {
  if (!voucherIds.length || voucherIds.length > 100 || voucherIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    rejectEdit("Invalid Daybook voucher selection", "IC_DELETE_IDS", 422);
  }
  const trades = await withTradeScope(actor, [], () =>
    db
      .select()
      .from(intercompanyTrades)
      .where(
        or(
          eq(intercompanyTrades.sourceCompanyId, actor.initiatingCompanyId),
          eq(intercompanyTrades.destinationCompanyId, actor.initiatingCompanyId)
        )
      )
  );
  if (!trades.length) return {} as Record<number, { tradeId: number; version: number }>;
  return withTradeScope(
    actor,
    trades.flatMap((t) => [t.sourceCompanyId, t.destinationCompanyId]),
    async () => {
      const events = await db
        .select()
        .from(intercompanyAuditEvents)
        .where(
          and(
            inArray(intercompanyAuditEvents.relationshipId, [...new Set(trades.map((t) => t.relationshipId))]),
            eq(intercompanyAuditEvents.eventType, "container-import-confirmed")
          )
        );
      const candidates = new Set(voucherIds);
      const output: Record<number, { tradeId: number; version: number }> = {};
      for (const trade of trades) {
        if (trade.state !== "active") continue;
        const event = events.find(
          (row) =>
            row.eventKey.startsWith("ic-container-import:") &&
            row.eventKey.endsWith(":" + trade.id) &&
            (row.payload as Record<string, unknown> | null)?.physicalContainerId === trade.physicalContainerId
        );
        if (!event) continue;
        for (const id of deletionVoucherIds(event.payload)) {
          if (candidates.has(id)) output[id] = { tradeId: trade.id, version: trade.version };
        }
      }
      return output;
    }
  );
}
