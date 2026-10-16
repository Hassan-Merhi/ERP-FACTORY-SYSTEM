import Decimal from "decimal.js";

/**
 * Supplier Partner public P&L presentation.
 *
 * A developer-approved monthly profit is the report's final net target.
 * Reflect its difference in the displayed gross line, NOT shared charges,
 * so that displayed gross minus unchanged shared charges equals net profit.
 *
 * The underlying revenue, COGS, voucher and audit history stay unchanged.
 * The ledger monthly close separately books any correction to suspense.
 */
export function presentSpMonthlyProfit(input: {
  totalRevenue: number;
  totalCogs: number;
  totalSharedCharges: number;
  approvedNetProfit?: string | number | null;
}): { grossProfit: number; netProfit: number } {
  const sourceGross = new Decimal(input.totalRevenue).minus(input.totalCogs);
  const shared = new Decimal(input.totalSharedCharges);
  const sourceNet = sourceGross.minus(shared);
  const finalNet = input.approvedNetProfit == null
    ? sourceNet
    : new Decimal(input.approvedNetProfit);
  if (!finalNet.isFinite()) throw new Error("Supplier Partner net profit must be finite");
  // In money units, round the target once and derive the visible gross FROM
  // the exact same rounded shared amount (no independent floating-point drift).
  const netCents = finalNet.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const sharedCents = shared.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    grossProfit: netCents.plus(sharedCents).toNumber(),
    netProfit: netCents.toNumber(),
  };
}
