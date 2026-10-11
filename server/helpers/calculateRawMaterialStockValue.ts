/**
 * Shared helper: compute the total raw-material stock value (in USD) for a
 * factory company.  Exactly mirrors the aggregation in /api/factory/raw-stock
 * so the net-position endpoint always shows the same number as the Raw
 * Production page.
 *
 * Root cause of previous bug: doing `String(value || fallback)` before
 * parseFloat — a stored "0.0000" string is truthy so the fallback was never
 * reached.  The route correctly parses first and then ORs the numeric result
 * with the fallback (`toMoney(value).toNumber() || fallback`).
 */

import { db } from "../db";
import { factoryRawStock, factoryContainers, factorySuppliers, factoryRawMaterialAdjustments } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { toMoney } from "../lib/money";

function parse(v: unknown): number {
  return toMoney(String(v ?? "")).toNumber();
}

export async function calculateRawMaterialStockValue(companyId: number): Promise<number> {
  const results = await db
    .select({
      supplierId: factoryContainers.supplierId,
      supplierName: factorySuppliers.name,
      receivedKg: factoryRawStock.receivedKg,
      usedKg: factoryRawStock.usedKg,
      costPerKg: factoryRawStock.costPerKg,
      costPerKgUsd: factoryRawStock.costPerKgUsd,
      containerStatus: factoryContainers.status,
      containerId: factoryRawStock.containerId,
    })
    .from(factoryRawStock)
    .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
    .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
    .where(and(eq(factoryRawStock.companyId, companyId), sql`${factoryContainers.status} != 'DELETED'`));

  // Mirror route's key exactly: `supplier-${id}` when supplierId present,
  // otherwise supplierName or `unknown-${containerId}`.
  const supplierMap = new Map<
    string,
    {
      _totalReceived: number;
      _totalUsed: number;
      _avgCostPerKg: number;
      _avgCostPerKgUsd: number;
    }
  >();

  for (const r of results) {
    const key = r.supplierId ? `supplier-${r.supplierId}` : r.supplierName || `unknown-${r.containerId}`;
    const received = parse(r.receivedKg);
    const used = parse(r.usedKg);
    const cpk = parse(r.costPerKg);
    // Parse first, THEN fall back (same as route).
    const cpkUsd = toMoney(r.costPerKgUsd).toNumber() || cpk;

    const existing = supplierMap.get(key);
    if (existing) {
      const prevCost = existing._totalReceived * existing._avgCostPerKg;
      const prevCostUsd = existing._totalReceived * existing._avgCostPerKgUsd;
      existing._totalReceived += received;
      existing._totalUsed += used;
      existing._avgCostPerKg = existing._totalReceived > 0 ? (prevCost + received * cpk) / existing._totalReceived : 0;
      existing._avgCostPerKgUsd =
        existing._totalReceived > 0 ? (prevCostUsd + received * cpkUsd) / existing._totalReceived : 0;
    } else {
      supplierMap.set(key, {
        _totalReceived: received,
        _totalUsed: used,
        _avgCostPerKg: cpk,
        _avgCostPerKgUsd: cpkUsd,
      });
    }
  }

  // Apply manual adjustments — mirrors route logic exactly
  const adjustments = await db
    .select()
    .from(factoryRawMaterialAdjustments)
    .where(eq(factoryRawMaterialAdjustments.companyId, companyId));

  for (const adj of adjustments) {
    const kg = parse(adj.kg);
    const cpk = parse(adj.costPerKg);
    const isAdd = adj.type === "ADD";

    let key: string;
    if (adj.supplierId) {
      key = `supplier-${adj.supplierId}`;
    } else {
      const label = adj.materialLabel || "Manual Stock";
      key = `MANUAL__${label}`;
    }

    const existing = supplierMap.get(key);
    if (existing) {
      if (isAdd) {
        const prevCost = existing._totalReceived * existing._avgCostPerKg;
        existing._totalReceived += kg;
        existing._avgCostPerKg = existing._totalReceived > 0 ? (prevCost + kg * cpk) / existing._totalReceived : 0;
        // Route sets USD = non-USD after adjustments
        existing._avgCostPerKgUsd = existing._avgCostPerKg;
      } else {
        existing._totalUsed += kg;
      }
    } else {
      supplierMap.set(key, {
        _totalReceived: isAdd ? kg : 0,
        _totalUsed: isAdd ? 0 : kg,
        _avgCostPerKg: cpk,
        _avgCostPerKgUsd: cpk,
      });
    }
  }

  let total = 0;
  for (const [, s] of supplierMap.entries()) {
    const remaining = s._totalReceived - s._totalUsed;
    const valueUsd = remaining * s._avgCostPerKgUsd;
    if (valueUsd > 0) total += valueUsd;
  }

  return Math.round((total + Number.EPSILON) * 100) / 100;
}
