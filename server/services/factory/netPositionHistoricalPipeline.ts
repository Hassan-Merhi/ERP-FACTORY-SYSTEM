/** Stable historical net-position pipeline; source snapshots never infer today's state. */
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { MoneyDecimal } from "../../lib/money";
import { getHistoricalOrders } from "./netPositionHistoricalOrders";
import {
  decimal,
  cents,
  getHistoricalOtw,
  type DatedPipelineOrder,
  type DatedPipelineSnapshot,
} from "./netPositionHistoricalOtw";

export * from "./netPositionHistoricalOtw";

export async function loadHistoricalFactoryPipeline(
  companyId: number,
  scope: FactoryNetPositionAsOf,
  getConfigFx: (cc: string) => number
): Promise<DatedPipelineSnapshot> {
  let otw: Awaited<ReturnType<typeof getHistoricalOtw>>;
  let orders: Awaited<ReturnType<typeof getHistoricalOrders>>;
  try {
    [otw, orders] = await Promise.all([
      getHistoricalOtw(companyId, scope, getConfigFx),
      getHistoricalOrders(companyId, scope),
    ]);
  } catch (cause) {
    // Never substitute today's container or order totals for a failed date.
    throw new Error("HISTORICAL_NET_POSITION_PIPELINE_FAILED", { cause });
  }
  const sum = (items: readonly DatedPipelineOrder[]) =>
    cents(items.reduce((acc, item) => acc.plus(decimal(item.grandTotal)), new MoneyDecimal(0)));
  return {
    stockOtwValue: otw.value,
    ...orders,
    pendingTotal: sum(orders.pendingOrders),
    verifiedTotal: sum(orders.verifiedOrders),
    loadingTotal: sum(orders.loadingOrders),
    warnings: [...new Set([...otw.warnings, ...orders.warnings])],
  };
}
