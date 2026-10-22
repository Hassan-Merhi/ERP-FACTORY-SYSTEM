import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { computeHistoricalFactoryInventory } from "../../../services/factory/netPositionHistoricalInventory";

type NetPositionAccount = {
  name: string;
  code: string;
  value: number;
  category: string;
  [key: string]: unknown;
};

type NetPositionResponse = {
  asOf?: string;
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  netPositionLabel: string;
  forUs: {
    total: number;
    breakdown: Array<{ name: string; value: number }>;
    accounts: NetPositionAccount[];
  };
  onUs: {
    total: number;
    breakdown: Array<{ name: string; value: number }>;
    accounts: NetPositionAccount[];
  };
  inventoryValue?: number;
  rawMaterialValue?: number;
  balanceOnTableValue?: number;
  [key: string]: unknown;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function recomputeBreakdown(accounts: NetPositionAccount[]) {
  const totals = new Map<string, number>();
  for (const account of accounts) {
    totals.set(account.category, (totals.get(account.category) ?? 0) + Number(account.value || 0));
  }
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value: round2(value) }))
    .sort((a, b) => b.value - a.value);
}

function replaceAccountValue(accounts: NetPositionAccount[], code: string, value: number) {
  const account = accounts.find((row) => row.code === code);
  if (account) account.value = round2(value);
}

/**
 * Replace provisional, current-state inventory figures with dated,
 * transaction-derived movements. Keep response field names stable and
 * recalculate account rows / breakdowns from a SINGLE historical valuation.
 */
export async function applyHistoricalOperationalCorrection<T extends NetPositionResponse>(
  companyId: number,
  scope: FactoryNetPositionAsOf,
  body: T,
  valuationMode: "cost" | "selling"
): Promise<T> {
  if (!scope.isHistorical) return body;
  if (!Array.isArray(body?.forUs?.accounts) || typeof body.rawMaterialValue !== "number") {
    throw new Error("HISTORICAL_NET_POSITION_RESPONSE_INCOMPLETE");
  }
  let historical: Awaited<ReturnType<typeof computeHistoricalFactoryInventory>>;
  try {
    historical = await computeHistoricalFactoryInventory(companyId, scope, valuationMode);
  } catch (cause) {
    throw new Error("HISTORICAL_NET_POSITION_REPLAY_FAILED", { cause });
  }
  const inventory = body.forUs.accounts.find((row) => row.code === "INVENTORY");
  const rawMaterial = body.forUs.accounts.find((row) => row.code === "RAW_MATERIAL");
  if (!inventory || !rawMaterial) throw new Error("HISTORICAL_STOCK_ROWS_MISSING");

  replaceAccountValue(body.forUs.accounts, "INVENTORY", historical.inventoryValue);
  replaceAccountValue(body.forUs.accounts, "RAW_MATERIAL", historical.rawMaterialValue);
  const wipRow = body.forUs.accounts.find((row) => row.code === "BALANCE_ON_TABLE");
  if (wipRow) {
    wipRow.value = round2(historical.balanceOnTableValue);
  } else if (historical.balanceOnTableValue > 0) {
    // The original/current snapshot omitted zero WIP; an earlier day can
    // have a nonzero balance and still needs its own account row.
    body.forUs.accounts.push({
      name: "Balance on Table",
      code: "BALANCE_ON_TABLE",
      value: round2(historical.balanceOnTableValue),
      category: "Production",
    });
  }

  body.inventoryValue = historical.inventoryValue;
  body.rawMaterialValue = historical.rawMaterialValue;
  body.balanceOnTableValue = historical.balanceOnTableValue;
  (body as NetPositionResponse).inventoryHistoryWarnings = historical.warnings;
  body.forUs.breakdown = recomputeBreakdown(body.forUs.accounts);
  body.forUsTotal = round2(body.forUs.accounts.reduce((sum, account) => sum + Number(account.value || 0), 0));
  body.forUs.total = body.forUsTotal;
  body.netPosition = round2(body.forUsTotal - body.onUsTotal);
  body.netPositionLabel = body.netPosition >= 0 ? "We have more than we owe" : "We owe more than we have";
  return body;
}
