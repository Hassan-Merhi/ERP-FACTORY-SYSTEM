import type { Express, Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";

import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getClientDate } from "../../../lib/dateUtils";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";

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

async function computeHistoricalOperationalValues(
  companyId: number,
  asOf: string,
  currentRawMaterialValue: number,
  valuationMode: "cost" | "selling"
) {
  const stockResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(p.production_price::numeric), 0) AS total_cost,
      COALESCE(SUM(p.selling_price::numeric), 0) AS total_selling
    FROM factory_bales b
    JOIN factory_bale_products p ON p.id = b.product_id
    WHERE b.company_id = ${companyId}
      AND p.company_id = ${companyId}
      AND COALESCE(b.stock_entry_date, b.pressed_at::date, b.created_at::date) <= ${asOf}::date
      AND (b.finalized_at IS NULL OR b.finalized_at::date > ${asOf}::date)
      AND (b.deleted_at IS NULL OR b.deleted_at::date > ${asOf}::date)
      AND b.status <> 'PENDING_PRESSING'
  `);
  const stockRow = resultRows(stockResult)[0] ?? {};
  const inventoryCostValue = round2(parseFloat(String(stockRow.total_cost ?? "0")) || 0);
  const inventorySellingValue = round2(parseFloat(String(stockRow.total_selling ?? "0")) || 0);
  const inventoryValue = valuationMode === "selling" ? inventorySellingValue : inventoryCostValue;

  const mixResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(total_weight_kg::numeric), 0) AS total_mix_kg,
      COALESCE(SUM(total_cost::numeric), 0) AS total_mix_cost
    FROM factory_mix_batches
    WHERE company_id = ${companyId}
      AND carry_forward_from_id IS NULL
      AND (deleted_at IS NULL OR deleted_at::date > ${asOf}::date)
      AND COALESCE(batch_date, created_at::date) <= ${asOf}::date
  `);
  const mixRow = resultRows(mixResult)[0] ?? {};
  const totalMixKg = parseFloat(String(mixRow.total_mix_kg ?? "0")) || 0;
  const totalMixCost = parseFloat(String(mixRow.total_mix_cost ?? "0")) || 0;
  const blendedCpk = totalMixKg > 0 ? totalMixCost / totalMixKg : 0;

  const baleResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(b.weight_kg::numeric), 0) AS total_bale_kg,
      COALESCE(SUM(p.selling_price::numeric), 0) AS total_selling_value
    FROM factory_bales b
    LEFT JOIN factory_bale_products p ON p.id = b.product_id
    WHERE b.company_id = ${companyId}
      AND COALESCE(b.stock_entry_date, b.pressed_at::date, b.created_at::date) <= ${asOf}::date
      AND (b.deleted_at IS NULL OR b.deleted_at::date > ${asOf}::date)
      AND b.status <> 'PENDING_PRESSING'
  `);
  const baleRow = resultRows(baleResult)[0] ?? {};
  const totalBaleKg = parseFloat(String(baleRow.total_bale_kg ?? "0")) || 0;
  const totalSellingValue = parseFloat(String(baleRow.total_selling_value ?? "0")) || 0;
  const botWeightKg = Math.max(totalMixKg - totalBaleKg, 0);
  const balanceOnTableCostValue = round2(botWeightKg * blendedCpk);
  const blendedSellingPerKg = totalBaleKg > 0 ? totalSellingValue / totalBaleKg : 0;
  const balanceOnTableSellingValue =
    blendedSellingPerKg > 0 ? round2(botWeightKg * blendedSellingPerKg) : balanceOnTableCostValue;
  const balanceOnTableValue =
    valuationMode === "selling" ? balanceOnTableSellingValue : balanceOnTableCostValue;

  const consumedAfterResult = await db.execute(sql`
    SELECT COALESCE(SUM(fms.total_cost::numeric), 0) AS value_after
    FROM factory_mix_batch_sources fms
    JOIN factory_mix_batches fmb ON fmb.id = fms.mix_batch_id
    WHERE fmb.company_id = ${companyId}
      AND COALESCE(fmb.batch_date, fmb.created_at::date) > ${asOf}::date
      AND fmb.deleted_at IS NULL
  `);
  const consumedAfterRow = resultRows(consumedAfterResult)[0] ?? {};
  const consumedAfter = parseFloat(String(consumedAfterRow.value_after ?? "0")) || 0;

  const receiptsAfterResult = await db.execute(sql`
    SELECT COALESCE(SUM(
      frs.received_kg::numeric * COALESCE(NULLIF(frs.cost_per_kg_usd::numeric, 0), frs.cost_per_kg::numeric, 0)
    ), 0) AS value_after
    FROM factory_raw_stock frs
    WHERE frs.company_id = ${companyId}
      AND frs.offloaded_at::date > ${asOf}::date
      AND frs.deleted_at IS NULL
  `);
  const receiptsAfterRow = resultRows(receiptsAfterResult)[0] ?? {};
  const receiptsAfter = parseFloat(String(receiptsAfterRow.value_after ?? "0")) || 0;

  const adjustmentsAfterResult = await db.execute(sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN type = 'ADD' THEN kg::numeric * COALESCE(cost_per_kg::numeric, 0)
        WHEN type = 'DEDUCT' THEN -(kg::numeric * COALESCE(cost_per_kg::numeric, 0))
        ELSE 0
      END
    ), 0) AS value_after
    FROM factory_raw_material_adjustments
    WHERE company_id = ${companyId}
      AND date::date > ${asOf}::date
      AND deleted_at IS NULL
  `);
  const adjustmentsAfterRow = resultRows(adjustmentsAfterResult)[0] ?? {};
  const adjustmentsAfter = parseFloat(String(adjustmentsAfterRow.value_after ?? "0")) || 0;

  const rawMaterialValue = round2(
    Math.max(currentRawMaterialValue + consumedAfter - receiptsAfter - adjustmentsAfter, 0)
  );

  return { inventoryValue, rawMaterialValue, balanceOnTableValue };
}

export function registerNetPositionHistoricalCorrection(app: Express) {
  app.get("/api/factory/net-position", requireAuth, (req: Request, res: Response, next: NextFunction) => {
    const asOf =
      typeof req.query.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : null;
    if (!asOf || asOf === getClientDate(req)) return next();

    const originalJson = res.json.bind(res);
    res.json = ((body: NetPositionResponse) => {
      void (async () => {
        const session = req.session as typeof req.session & {
          factoryCompanyId?: number;
          currentCompanyId?: number;
        };
        const companyId = Number(session.factoryCompanyId || session.currentCompanyId || 0);
        if (!companyId) return originalJson(body);

        try {
          if (!body?.forUs?.accounts || typeof body.rawMaterialValue !== "number") {
            return originalJson(body);
          }

          const valuationMode = req.query.valuationMode === "selling" ? "selling" : "cost";
          const historical = await computeHistoricalOperationalValues(
            companyId,
            asOf,
            body.rawMaterialValue,
            valuationMode
          );
          replaceAccountValue(body.forUs.accounts, "INVENTORY", historical.inventoryValue);
          replaceAccountValue(body.forUs.accounts, "RAW_MATERIAL", historical.rawMaterialValue);
          replaceAccountValue(body.forUs.accounts, "BALANCE_ON_TABLE", historical.balanceOnTableValue);

          body.inventoryValue = historical.inventoryValue;
          body.rawMaterialValue = historical.rawMaterialValue;
          body.balanceOnTableValue = historical.balanceOnTableValue;
          body.forUs.breakdown = recomputeBreakdown(body.forUs.accounts);
          body.forUsTotal = round2(body.forUs.accounts.reduce((sum, account) => sum + Number(account.value || 0), 0));
          body.forUs.total = body.forUsTotal;
          body.netPosition = round2(body.forUsTotal - body.onUsTotal);
          body.netPositionLabel = body.netPosition >= 0 ? "We have more than we owe" : "We owe more than we have";

          return originalJson(body);
        } catch (error) {
          logger.error("Historical net-position correction failed", { error, companyId, asOf });
          return originalJson(body);
        }
      })();
      return res;
    }) as Response["json"];

    next();
  });
}
