import type Decimal from "decimal.js";
import * as schema from "@shared/schema";

import { toMoney } from "../../../lib/money";

export type ContainerOffloadLifecycleMode = "create-or-replace" | "replace-only";

export interface ContainerOffloadAdditionalCharge {
  description: string;
  amount: number;
  ledgerAccountId: number;
}

export interface ContainerOffloadAgentCharge {
  description?: string;
  amountUsd: number;
  parentAgentAccountId: number;
}

export interface ContainerOffloadLifecycleInput {
  companyId: number;
  containerId: number;
  mode: ContainerOffloadLifecycleMode;
  locationId: number;
  offloadDate: string;
  duties: string;
  dutiesAccountId?: number | null;
  officeCharges: string;
  officeChargesAccountId?: number | null;
  officeChargesCashAccountId?: number | null;
  transferCharges: string;
  transportFees: string;
  transportAccountId?: number | null;
  additionalCharges?: ContainerOffloadAdditionalCharge[];
  inventoryCostCorrections?: Array<{ stockItemId: number; correctRate: number }>;
  agentChargeLines?: ContainerOffloadAgentCharge[];
}

export interface ContainerOffloadLifecycleResult {
  offload: typeof schema.containerOffloads.$inferSelect;
  companyId: number;
  locationId: number;
  stockItemIds: number[];
  replacedExistingOffload: boolean;
}

export class ContainerOffloadLifecycleError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "ContainerOffloadLifecycleError";
  }
}

export function amount(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function positiveIds(values: unknown[]): number[] {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort(
    (left, right) => left - right
  );
}

/** One stock item's purchase-order quantity and value on a container, exact. */
export interface OffloadItemTotals {
  stockItemId: number;
  totalQuantity: Decimal;
  /** Sum of quantity × rate over the item's PO lines (the purchase value). */
  weightedRateSum: Decimal;
}

/**
 * The container's PO lines grouped by stock item, in decimal arithmetic (the
 * offload costs the received stock from these totals; floats lost the last
 * cent of large containers).
 */
export function buildItemMap(
  lineItems: Array<{ stockItemId: number; quantity: string; rate: string }>
): Map<number, OffloadItemTotals> {
  const items = new Map<number, OffloadItemTotals>();
  for (const line of lineItems) {
    const stockItemId = Number(line.stockItemId);
    if (!Number.isInteger(stockItemId) || stockItemId <= 0) continue;
    const quantity = toMoney(line.quantity);
    const value = quantity.times(toMoney(line.rate));
    const current = items.get(stockItemId);
    if (current) {
      current.totalQuantity = current.totalQuantity.plus(quantity);
      current.weightedRateSum = current.weightedRateSum.plus(value);
    } else {
      items.set(stockItemId, { stockItemId, totalQuantity: quantity, weightedRateSum: value });
    }
  }
  return items;
}
