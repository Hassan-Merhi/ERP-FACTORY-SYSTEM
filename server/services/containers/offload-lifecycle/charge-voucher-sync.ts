import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../../../db";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  multiplyInventoryValues,
  roundInventoryValue,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../../lib/inventoryMath";
import {
  postPreCutoverOffloadMovementTx,
  syncContainerStockInTx,
} from "../../accounting/perpetualInventory/stockReceipts";

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

export type ChargePrefix = keyof typeof CHARGE_COLUMN;

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
 *     on hand (value_moved on the line). Bales already sold keep the cost they
 *     were sold at; their share of the change is recorded on the line as
 *     cogs_variance, and the stock-in journal posts it to COGS, so the ledger
 *     Inventory moves exactly with the sub-ledger (wave 11).
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

  return applyContainerChargeDeltaTx(tx, {
    companyId: edit.companyId,
    containerNumber: parsed.containerNumber,
    prefix: parsed.prefix,
    chargeDelta: subtractInventoryValues(edit.newTotal ?? 0, edit.oldTotal ?? 0),
  });
}

export interface ContainerChargeDelta {
  companyId: number;
  containerNumber: string;
  prefix: ChargePrefix;
  chargeDelta: string | number | Decimal;
}

/**
 * Apply a change of `chargeDelta` in one charge category to an offloaded
 * container: the offload record, its lines and the inventory still on hand.
 * Shared by the voucher-edit sync and the one-time repair of offloads whose
 * vouchers were edited before that sync existed.
 */
export async function applyContainerChargeDeltaTx(
  tx: DbTransaction,
  change: ContainerChargeDelta
): Promise<ContainerChargeVoucherSyncResult | null> {
  const chargeDelta = roundInventoryValue(change.chargeDelta, 2);
  if (chargeDelta.isZero()) return null;

  const [container] = await tx
    .select()
    .from(schema.containers)
    .where(
      and(
        eq(schema.containers.companyId, change.companyId),
        eq(schema.containers.containerNumber, change.containerNumber)
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
  const column = CHARGE_COLUMN[change.prefix];
  if (column) {
    const next = addInventoryValues(offload[column], chargeDelta);
    offloadUpdate[column] = inventoryMoney(next.isNegative() ? 0 : next);
  }
  await tx.update(schema.containerOffloads).set(offloadUpdate).where(eq(schema.containerOffloads.id, offload.id));

  if (change.prefix === "DUTY") {
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
  // What the re-pricing changed in the stock sub-ledger (wave 15, C1).
  let subLedgerDelta = toInventoryDecimal(0);
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index];
    const quantity = toInventoryDecimal(item.quantity);
    const share =
      index === lines.length - 1
        ? subtractInventoryValues(chargeDelta, allocated)
        : roundInventoryValue(divideInventoryValues(multiplyInventoryValues(chargeDelta, quantity), lineQuantity), 2);
    allocated = addInventoryValues(allocated, share);

    const totalValue = addInventoryValues(item.totalValue, share);
    // What the sub-ledger holds of the line, and what went to COGS (legacy
    // lines: all of the line value, nothing).
    const valueMoved = toInventoryDecimal(item.valueMoved ?? item.totalValue);
    const cogsVariance = toInventoryDecimal(item.cogsVariance ?? 0);

    // A suspended (optional) offload has already taken its stock back out of
    // inventory; the new line value is received when it is restored.
    let onHandShare = toInventoryDecimal(0);
    if (offload.optional) {
      onHandShare = share;
    } else {
      const [stock] = await tx
        .select()
        .from(schema.inventory)
        .where(
          and(eq(schema.inventory.locationId, offload.locationId), eq(schema.inventory.stockItemId, item.stockItemId))
        )
        .limit(1)
        .for("update");
      const onHand = toInventoryDecimal(stock?.quantity ?? 0);
      if (stock && onHand.greaterThan(0)) {
        // Only the container's bales still on hand take the change; each
        // carries the same per-bale share the offload line did. A reduction
        // never takes the row below zero value (negative value is for short
        // rows only): what the on-hand stock cannot absorb is sold cost.
        const balesOnHand = onHand.lessThan(quantity) ? onHand : quantity;
        onHandShare = roundInventoryValue(
          divideInventoryValues(multiplyInventoryValues(share, balesOnHand), quantity),
          2
        );
        const currentValue = toInventoryDecimal(stock.totalValue);
        if (addInventoryValues(currentValue, onHandShare).isNegative()) onHandShare = currentValue.negated();
        const nextValue = addInventoryValues(currentValue, onHandShare);
        subLedgerDelta = addInventoryValues(subLedgerDelta, onHandShare);
        await tx
          .update(schema.inventory)
          .set({
            totalValue: inventoryMoney(nextValue),
            averageRate: roundInventoryValue(divideInventoryValues(nextValue, onHand), 7).toFixed(7),
            lastUpdated: new Date(),
          })
          .where(eq(schema.inventory.id, stock.id));
      }
    }
    // The bales already sold took their cost to COGS when they were sold; their
    // share of the re-pricing goes to COGS now, on the stock-in journal.
    const soldShare = subtractInventoryValues(share, onHandShare);

    await tx
      .update(schema.containerOffloadItems)
      .set({
        totalValue: inventoryMoney(totalValue),
        rate: roundInventoryValue(divideInventoryValues(totalValue, quantity), 2).toFixed(2),
        valueMoved: inventoryMoney(addInventoryValues(valueMoved, onHandShare)),
        cogsVariance: inventoryMoney(addInventoryValues(cogsVariance, soldShare)),
      })
      .where(eq(schema.containerOffloadItems.id, item.id));
  }

  // Perpetual inventory (wave 8.2): the stock-in journal follows the re-priced offload.
  await syncContainerStockInTx(tx, change.companyId, container.id);
  // Wave 15 (C1): a container offloaded before the cut-over has no stock-in
  // journal; the re-priced stock on hand is journalled against Purchases.
  await postPreCutoverOffloadMovementTx(tx, {
    companyId: change.companyId,
    containerId: container.id,
    containerNumber: container.containerNumber,
    offloadDate: container.offloadDate,
    locationId: offload.locationId,
    valueDelta: roundInventoryValue(subLedgerDelta, 2),
    mode: "inPlace",
    reason: "Offload charge re-priced",
  });

  return {
    offloadId: offload.id,
    locationId: offload.locationId,
    stockItemIds: [...new Set(lines.map((item) => item.stockItemId))],
    chargeDelta: chargeDelta.toFixed(2),
    additionalCostPerBale: newCostPerBale.toFixed(2),
  };
}
