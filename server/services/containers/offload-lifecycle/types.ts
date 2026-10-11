import * as schema from "@shared/schema";
import { parseMoneyInput } from "../../../lib/money";

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
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function positiveIds(values: unknown[]): number[] {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort(
    (left, right) => left - right
  );
}

export function buildItemMap(
  lineItems: Array<{ stockItemId: number; quantity: string; rate: string }>
): Map<number, { stockItemId: number; totalQuantity: number; weightedRateSum: number }> {
  const items = new Map<number, { stockItemId: number; totalQuantity: number; weightedRateSum: number }>();
  for (const line of lineItems) {
    const stockItemId = Number(line.stockItemId);
    if (!Number.isInteger(stockItemId) || stockItemId <= 0) continue;
    const quantity = amount(line.quantity);
    const rate = amount(line.rate);
    if (items.has(stockItemId)) {
      const current = items.get(stockItemId)!;
      current.totalQuantity += quantity;
      current.weightedRateSum += quantity * rate;
    } else {
      items.set(stockItemId, {
        stockItemId,
        totalQuantity: quantity,
        weightedRateSum: quantity * rate,
      });
    }
  }
  return items;
}
