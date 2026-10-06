import { and, eq } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../../../db";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryUnitCost,
  multiplyInventoryValues,
  roundInventoryValue,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../../lib/inventoryMath";

/**
 * Container offload charge vouchers are numbered `<PREFIX>-<containerNumber>-<timestamp>`
 * by postChargeVouchers. The prefix names the offload column the voucher feeds.
 */
const CHARGE_VOUCHER_PATTERN = /^(DUTY|OFFICE|TRANS|XFER|CHG)-(.+)-\d+$/;

const CHARGE_COLUMN = {
  DUTY: "duties",
  OFFICE: "officeCharges",
  TRANS: "transportFees",
  XFER: "transferCharges",
  CHG: null,
} as const;

type ChargePrefix = keyof typeof CHARGE_COLUMN;

export function parseContainerChargeVoucherNumber(
  voucherNumber: string | null | undefined
): { prefix: ChargePrefix; containerNumber: string } | null {
  const match = voucherNumber?.match(CHARGE_VOUCHER_PATTERN);
  if (!match) return null;
  return { prefix: match[1] as ChargePrefix, containerNumber: match[2] };
}

export interface ContainerChargeVoucherEdit {
  companyId: number;
  voucherNumber: string;
  oldTotal: string | number | null | undefined;
  newTotal: string | number | null | undefined;
}

export interface ContainerChargeVoucherSyncResult {
  offloadId: number;
  locationId: number;
  stockItemIds: number[];
  chargeDelta: string;
  additionalCostPerBale: string;
}

/**
 * Carry an edited duty / transport / office / transfer / additional charge
 * voucher back into the container's landed cost.
 *
 * At offload time the charges are spread over every bale and baked into the
 * offload lines and the location's inventory. Editing the voucher afterwards
 * used to change only the ledger, so the per-bale cost on the offload and in
 * inventory kept the old amount. This applies the voucher's change to:
 *   - the offload record's charge column, total charges and cost per bale;
 *   - each offload line, spread by quantity with the cent remainder on the last
 *     line (the same rule the offload itself uses);
 *   - the inventory at the offload location, for the container's bales still
 *     on hand. Bales already sold keep the cost they were sold at.
 *
 * Returns null when the voucher is not a container charge voucher, the amount
 * did not change, or the container has no active offload to update.
 */
export async function syncContainerChargeVoucherEditTx(
  tx: DbTransaction,
  edit: ContainerChargeVoucherEdit
): Promise<ContainerChargeVoucherSyncResult | null> {
  const parsed = parseContainerChargeVoucherNumber(edit.voucherNumber);
  if (!parsed) return null;

  const chargeDelta = roundInventoryValue(subtractInventoryValues(edit.newTotal ?? 0, edit.oldTotal ?? 0), 2);
  if (chargeDelta.isZero()) return null;

  const [container] = await tx
    .select()
    .from(schema.containers)
    .where(
      and(
        eq(schema.containers.companyId, edit.companyId),
        eq(schema.containers.containerNumber, parsed.containerNumber)
      )
    )
    .limit(1)
    .for("update");
  if (!container || container.status !== "OFFLOADED") return null;

  const [offload] = await tx
    .select()
    .from(schema.containerOffloads)
    .where(eq(schema.containerOffloads.containerId, container.id))
    .limit(1)
    .for("update");
  if (!offload) return null;

  const totalBales = toInventoryDecimal(offload.totalBales);
  if (totalBales.lessThanOrEqualTo(0)) return null;

  const newTotalCharges = addInventoryValues(offload.totalCharges, chargeDelta);
  const newCostPerBale = roundInventoryValue(divideInventoryValues(newTotalCharges, totalBales), 2);

  const offloadUpdate: Partial<typeof schema.containerOffloads.$inferInsert> = {
    totalCharges: inventoryMoney(newTotalCharges),
    additionalCostPerBale: newCostPerBale.toFixed(2),
  };
  const column = CHARGE_COLUMN[parsed.prefix];
  if (column) {
    const next = addInventoryValues(offload[column], chargeDelta);
    offloadUpdate[column] = inventoryMoney(next.isNegative() ? 0 : next);
  }
  await tx.update(schema.containerOffloads).set(offloadUpdate).where(eq(schema.containerOffloads.id, offload.id));

  if (parsed.prefix === "DUTY") {
    await tx
      .update(schema.containers)
      .set({ dutyFee: offloadUpdate.duties })
      .where(eq(schema.containers.id, container.id));
  }

  const items = await tx
    .select()
    .from(schema.containerOffloadItems)
    .where(eq(schema.containerOffloadItems.offloadId, offload.id))
    .orderBy(schema.containerOffloadItems.id);
  const lines = items.filter((item) => toInventoryDecimal(item.quantity).greaterThan(0));
  const lineQuantity = addInventoryValues(...lines.map((item) => item.quantity));

  let allocated = toInventoryDecimal(0);
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index];
    const quantity = toInventoryDecimal(item.quantity);
    const share =
      index === lines.length - 1
        ? subtractInventoryValues(chargeDelta, allocated)
        : roundInventoryValue(divideInventoryValues(multiplyInventoryValues(chargeDelta, quantity), lineQuantity), 2);
    allocated = addInventoryValues(allocated, share);

    const totalValue = addInventoryValues(item.totalValue, share);
    await tx
      .update(schema.containerOffloadItems)
      .set({
        totalValue: inventoryMoney(totalValue),
        rate: roundInventoryValue(divideInventoryValues(totalValue, quantity), 2).toFixed(2),
      })
      .where(eq(schema.containerOffloadItems.id, item.id));

    // A suspended (optional) offload has already taken its stock back out of
    // inventory; the new line value is picked up when it is restored.
    if (offload.optional) continue;

    const [stock] = await tx
      .select()
      .from(schema.inventory)
      .where(
        and(eq(schema.inventory.locationId, offload.locationId), eq(schema.inventory.stockItemId, item.stockItemId))
      )
      .limit(1)
      .for("update");
    if (!stock) continue;
    const onHand = toInventoryDecimal(stock.quantity);
    if (onHand.lessThanOrEqualTo(0)) continue;

    // Only the container's bales still on hand take the change; each carries
    // the same per-bale share the offload line did.
    const balesOnHand = onHand.lessThan(quantity) ? onHand : quantity;
    const valueDelta = multiplyInventoryValues(divideInventoryValues(share, quantity), balesOnHand);
    const candidate = addInventoryValues(stock.totalValue, valueDelta);
    const nextValue = candidate.isNegative() ? toInventoryDecimal(0) : candidate;
    await tx
      .update(schema.inventory)
      .set({
        totalValue: inventoryMoney(nextValue),
        averageRate: inventoryUnitCost(divideInventoryValues(nextValue, onHand)),
        lastUpdated: new Date(),
      })
      .where(eq(schema.inventory.id, stock.id));
  }

  return {
    offloadId: offload.id,
    locationId: offload.locationId,
    stockItemIds: [...new Set(lines.map((item) => item.stockItemId))],
    chargeDelta: chargeDelta.toFixed(2),
    additionalCostPerBale: newCostPerBale.toFixed(2),
  };
}
