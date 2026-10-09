/**
 * Factory bale cost basis (accounting audit wave 11, owner decision 5).
 *
 * A bale's cost is USD material cost:
 *   - a bale from a mix costs weight × the mix's USD cost per kg (the mix's
 *     own `cost_per_kg`), so pressing relieves work in progress by exactly the
 *     finished-goods value it adds;
 *   - a stock-entry bale with no mix costs its product's `production_price`
 *     PER BALE (cost per kg = price ÷ weight); garbage (HMD16) bales with no
 *     mix cost nothing, as before.
 *
 * Each mix source is priced at its USD rate:
 *   1. the supplier's locked moving average (factory_suppliers
 *      .current_raw_material_cost_per_kg_usd) when it is set and positive;
 *   2. otherwise the container's landed USD cost (factory_raw_stock
 *      .cost_per_kg_usd), or its `cost_per_kg` when the container's own
 *      currency is USD (that is the USD rate, not a fallback);
 *   3. an upstream batch source at that batch's cost per kg.
 * A native-currency cost is never used. A source with no USD rate:
 *   - under perpetual inventory (the company's cut-over applies to the
 *     document date) refuses the mix or the pressing with
 *     FACTORY_SOURCE_NO_USD_RATE (409);
 *   - before the cut-over the mix is recorded UNVALUED: cost per kg and total
 *     cost 0 (the sources keep the rates they have), so its bales carry no
 *     cost and the factory valuation lists them as unvalued instead of
 *     guessing. The reviewed re-cost (baleRecost.ts) values them once a rate
 *     is confirmed.
 */
import type { Response } from "express";
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { isPerpetualInventoryActive } from "../accounting/perpetualInventory/cutover";

/** Bale and mix cost columns are numeric(20, 7). */
export const FACTORY_COST_SCALE = 7;

export const FACTORY_SOURCE_NO_USD_RATE = "FACTORY_SOURCE_NO_USD_RATE" as const;
export const FACTORY_SOURCE_NO_USD_RATE_MESSAGE =
  "A mix source has no USD cost rate. Confirm the container's exchange rate or the supplier's rate before mixing or pressing under perpetual inventory.";

export interface UnpricedSource {
  supplierId?: number | null;
  containerId?: number | null;
  sourceBatchId?: number | null;
}

export class FactoryCostBasisRefusalError extends HttpError {
  readonly code = FACTORY_SOURCE_NO_USD_RATE;
  constructor(readonly sources: UnpricedSource[]) {
    super(409, FACTORY_SOURCE_NO_USD_RATE_MESSAGE);
    this.name = "FactoryCostBasisRefusalError";
  }
}

export const FACTORY_BALE_REQUIRES_COSTED_MIX = "FACTORY_BALE_REQUIRES_COSTED_MIX" as const;
export const FACTORY_BALE_REQUIRES_COSTED_MIX_MESSAGE =
  "Under perpetual inventory a bale must come from a costed mix. Choose the mix the bales were pressed from.";

/**
 * A stock-entry bale with no mix once the cut-over applies to its date (wave
 * 17 B, owner decision 2): it would be costed at the catalogue production
 * price, which is not a cost the factory incurred.
 */
export class FactoryBaleWithoutMixRefusalError extends HttpError {
  readonly code = FACTORY_BALE_REQUIRES_COSTED_MIX;
  constructor(readonly articleCodes: string[]) {
    super(409, FACTORY_BALE_REQUIRES_COSTED_MIX_MESSAGE);
    this.name = "FactoryBaleWithoutMixRefusalError";
  }
}

/** Garbage bales (HMD16…) cost nothing by rule, so they need no mix. */
export const isZeroCostArticle = (articleCode: string | null | undefined) => Boolean(articleCode?.startsWith("HMD16"));

/**
 * Refuses stock-entry bales with no mix once the company's cut-over applies to
 * the entry date (decision 2). Before the cut-over they keep the catalogue
 * price and are listed as unvalued by the readiness report
 * (noMixCataloguePricedBales), and the cut-over apply refuses while any is
 * stock.
 */
export async function assertStockEntryHasCostedMixTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  date: string,
  articleCodes: ReadonlyArray<string | null | undefined>
): Promise<void> {
  const priced = [...new Set(articleCodes.filter((code) => !isZeroCostArticle(code)).map((code) => String(code)))];
  if (priced.length === 0) return;
  if (await isPerpetualInventoryActive(executor, companyId, date)) {
    throw new FactoryBaleWithoutMixRefusalError(priced);
  }
}

/** Sends the 409 when `error` is a cost-basis refusal; returns whether it did. */
export function sendFactoryCostBasisRefusal(response: Response, error: unknown): boolean {
  if (error instanceof FactoryBaleWithoutMixRefusalError) {
    response.status(409).json({ code: error.code, message: error.message, articleCodes: error.articleCodes });
    return true;
  }
  if (!(error instanceof FactoryCostBasisRefusalError)) return false;
  response
    .status(409)
    .json({ code: FACTORY_SOURCE_NO_USD_RATE, message: FACTORY_SOURCE_NO_USD_RATE_MESSAGE, sources: error.sources });
  return true;
}

export type SourceRateBasis = "supplier-locked" | "container-usd" | "batch";

export interface SourceUsdRate {
  rate: Decimal;
  basis: SourceRateBasis;
}

async function firstRow<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return (await executor.execute(query)).rows[0] as T | undefined;
}

/** The supplier's persisted locked moving-average USD rate, when positive. */
export async function supplierLockedUsdRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  supplierId: number
): Promise<Decimal | null> {
  const row = await firstRow<{ rate: string | null }>(
    executor,
    sql`SELECT current_raw_material_cost_per_kg_usd::text AS rate FROM factory_suppliers
         WHERE id = ${supplierId} AND company_id = ${companyId}`
  );
  const rate = row?.rate == null ? null : toMoney(row.rate);
  return rate && rate.gt(0) ? rate : null;
}

/**
 * The container's landed USD cost per kg, when it has one.
 *
 * Wave 15 (M7): read from the container's live raw-stock rows only (a
 * soft-deleted receipt no longer prices anything), received-kg weighted when
 * the rows carry different USD costs; it used to take whichever row came
 * first, deleted or not, even one with no USD cost while another row had one.
 * A USD container's own cost per kg is its USD rate; any other currency's
 * native cost is never read as dollars.
 */
export async function containerUsdRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  containerId: number
): Promise<Decimal | null> {
  const row = await firstRow<{ usd: string | null; native: string | null; currency: string | null }>(
    executor,
    sql`WITH scope AS (SELECT ${companyId}::int AS company_id, ${containerId}::int AS container_id),
        live AS (
          SELECT frs.id, frs.received_kg, frs.cost_per_kg_usd, frs.cost_per_kg
            FROM factory_raw_stock frs JOIN scope ON frs.company_id = scope.company_id
             AND frs.container_id = scope.container_id
           WHERE frs.deleted_at IS NULL
        )
        SELECT (SELECT CASE WHEN SUM(received_kg) FILTER (WHERE cost_per_kg_usd > 0) > 0
                            THEN SUM(received_kg * cost_per_kg_usd) FILTER (WHERE cost_per_kg_usd > 0)
                                 / SUM(received_kg) FILTER (WHERE cost_per_kg_usd > 0)
                            ELSE (SELECT cost_per_kg_usd FROM live WHERE cost_per_kg_usd > 0 ORDER BY id LIMIT 1)
                       END FROM live)::text AS usd,
               (SELECT CASE WHEN SUM(received_kg) FILTER (WHERE cost_per_kg > 0) > 0
                            THEN SUM(received_kg * cost_per_kg) FILTER (WHERE cost_per_kg > 0)
                                 / SUM(received_kg) FILTER (WHERE cost_per_kg > 0)
                            ELSE (SELECT cost_per_kg FROM live WHERE cost_per_kg > 0 ORDER BY id LIMIT 1)
                       END FROM live)::text AS native,
               fc.currency_code AS currency
          FROM factory_containers fc JOIN scope ON fc.id = scope.container_id AND fc.company_id = scope.company_id
         WHERE EXISTS (SELECT 1 FROM live)`
  );
  if (!row) return null;
  const usd = row.usd == null ? null : toMoney(row.usd);
  if (usd && usd.gt(0)) return usd;
  const native = row.native == null ? null : toMoney(row.native);
  if ((row.currency || "USD").toUpperCase() === "USD" && native && native.gt(0)) return native;
  return null;
}

/**
 * The USD rate of a raw-material mix source: the supplier's locked rate, else
 * the container's landed USD cost; null when it has none.
 */
export async function rawSourceUsdRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  source: { supplierId?: number | null; containerId?: number | null }
): Promise<SourceUsdRate | null> {
  if (source.supplierId != null) {
    const locked = await supplierLockedUsdRate(executor, companyId, source.supplierId);
    if (locked) return { rate: locked, basis: "supplier-locked" };
  }
  if (source.containerId != null) {
    const container = await containerUsdRate(executor, companyId, source.containerId);
    if (container) return { rate: container, basis: "container-usd" };
  }
  return null;
}

/**
 * Accumulates a mix's sources at their USD rates and settles the mix cost:
 * refused under perpetual inventory when a source has no rate, recorded
 * unvalued (zero) before the cut-over.
 */
export class MixCostAccumulator {
  totalWeight: Decimal = new MoneyDecimal(0);
  totalCost: Decimal = new MoneyDecimal(0);
  readonly unpriced: UnpricedSource[] = [];
  /**
   * The value the mix took over the raw material's landed cost (a supplier
   * rate above or below the container's own cost): the material price
   * variance of this mix.
   */
  materialPriceDelta: Decimal = new MoneyDecimal(0);

  add(weight: Decimal, rate: Decimal | null, source: UnpricedSource): Decimal {
    this.totalWeight = this.totalWeight.plus(weight);
    if (rate === null) {
      this.unpriced.push(source);
      return new MoneyDecimal(0);
    }
    this.totalCost = this.totalCost.plus(weight.times(rate));
    return rate;
  }

  /** Adds the material price difference of a container-linked source. */
  addPriceDifference(weight: Decimal, rate: Decimal | null, landedRate: Decimal | null) {
    if (rate === null || landedRate === null) return;
    this.materialPriceDelta = this.materialPriceDelta.plus(weight.times(rate.minus(landedRate)));
  }

  /**
   * The mix's cost per kg and total cost, starting from `existing` (a top-up
   * adds to the batch's weight and cost). Throws the refusal under perpetual
   * inventory when a source has no USD rate.
   */
  async settle(
    executor: DatabaseOrTransaction,
    companyId: number,
    date: string,
    existing?: { weight: Decimal; cost: Decimal; unvalued: boolean }
  ): Promise<{ costPerKg: Decimal; totalCost: Decimal; totalWeight: Decimal; unvalued: boolean }> {
    const totalWeight = this.totalWeight.plus(existing?.weight ?? 0);
    const unvalued = this.unpriced.length > 0 || existing?.unvalued === true;
    if (this.unpriced.length > 0 && (await isPerpetualInventoryActive(executor, companyId, date))) {
      throw new FactoryCostBasisRefusalError(this.unpriced);
    }
    if (unvalued) return { costPerKg: new MoneyDecimal(0), totalCost: new MoneyDecimal(0), totalWeight, unvalued };
    const totalCost = this.totalCost.plus(existing?.cost ?? 0);
    const costPerKg = totalWeight.gt(0) ? totalCost.dividedBy(totalWeight) : new MoneyDecimal(0);
    return {
      costPerKg: costPerKg.toDecimalPlaces(FACTORY_COST_SCALE),
      totalCost: totalCost.toDecimalPlaces(FACTORY_COST_SCALE),
      totalWeight,
      unvalued,
    };
  }
}

export interface BaleCost {
  costPerKg: Decimal;
  totalCost: Decimal;
}

/** A bale from a mix: weight × the mix's USD cost per kg. */
export function baleCostFromMix(weightKg: Decimal.Value, mixCostPerKg: Decimal.Value): BaleCost {
  const costPerKg = toMoney(mixCostPerKg).toDecimalPlaces(FACTORY_COST_SCALE);
  return { costPerKg, totalCost: toMoney(weightKg).times(costPerKg).toDecimalPlaces(FACTORY_COST_SCALE) };
}

/**
 * A stock-entry bale with no mix: the product's production price per bale
 * (garbage HMD16 bales cost nothing). Only before the company's cut-over
 * (assertStockEntryHasCostedMixTx refuses it after).
 */
export function stockEntryBaleCost(
  productionPrice: Decimal.Value | null | undefined,
  weightKg: Decimal.Value,
  articleCode?: string | null
): BaleCost {
  const zero = new MoneyDecimal(0);
  if (isZeroCostArticle(articleCode)) return { costPerKg: zero, totalCost: zero };
  const totalCost = toMoney(productionPrice ?? 0).toDecimalPlaces(FACTORY_COST_SCALE);
  const weight = toMoney(weightKg);
  const costPerKg = weight.gt(0) ? totalCost.dividedBy(weight).toDecimalPlaces(FACTORY_COST_SCALE) : zero;
  return { costPerKg, totalCost };
}

/**
 * The USD cost per kg bales pressed from a mix take: the mix's own cost per
 * kg. A mix with no cost (recorded unvalued) refuses under perpetual
 * inventory and gives unvalued (zero-cost) bales before the cut-over.
 */
export async function mixCostForPressing(
  executor: DatabaseOrTransaction,
  companyId: number,
  date: string,
  mix: { id: number; costPerKg: string | null }
): Promise<Decimal> {
  const cost = toMoney(mix.costPerKg ?? 0);
  if (cost.gt(0)) return cost;
  if (await isPerpetualInventoryActive(executor, companyId, date)) {
    throw new FactoryCostBasisRefusalError([{ sourceBatchId: mix.id }]);
  }
  return new MoneyDecimal(0);
}
