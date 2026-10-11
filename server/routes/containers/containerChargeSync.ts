/** Purchase-order charge helpers of the container freight write routes (split out of containerFreightWriteRoutes.ts). */
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";

import { containerCharges } from "@shared/schema";

import type { DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, moneyString, toMoney, type MoneyInput } from "../../lib/money";

/**
 * A charge as the purchase_orders numeric(20, 2) column stores it: Postgres
 * rounds half away from zero, so vouchers and container totals derived from
 * this value agree with the PO to the cent.
 */
export const storedCents = (value: unknown) =>
  toMoney((typeof value === "string" ? value.trim() : value) as MoneyInput).toDecimalPlaces(
    2,
    MoneyDecimal.ROUND_HALF_UP
  );

/** Mirror a PO's charges into container_charges: one row per charge type, none when zero. */
export async function syncContainerCharges(
  executor: DatabaseOrTransaction,
  containerId: number,
  charges: { chargeType: string; amount: Decimal }[]
) {
  for (const { chargeType, amount } of charges) {
    const existingCharge = await executor
      .select()
      .from(containerCharges)
      .where(and(eq(containerCharges.containerId, containerId), eq(containerCharges.chargeType, chargeType)))
      .limit(1);

    if (amount.isZero()) {
      // Delete entry if charge is 0
      if (existingCharge.length > 0) {
        await executor.delete(containerCharges).where(eq(containerCharges.id, existingCharge[0].id));
      }
    } else if (existingCharge.length > 0) {
      await executor
        .update(containerCharges)
        .set({ amount: moneyString(amount) })
        .where(eq(containerCharges.id, existingCharge[0].id));
    } else {
      await executor.insert(containerCharges).values({ containerId, chargeType, amount: moneyString(amount) });
    }
  }
}
