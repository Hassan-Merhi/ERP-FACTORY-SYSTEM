/**
 * Phase 2 — signed physical dispatch -> immutable financial source snapshot.
 *
 * Read-only: this module never inserts vouchers, stock, customer balances,
 * charges, or financial rows. Phase 3/4 writers must call it in the same locked
 * order/trip transaction as their financial writes, then compare the fingerprint.
 *
 * Historical closures without a real saved manifest deliberately fail closed.
 * The physical bale reference stays inside the snapshot; the ERP PO exporter
 * will group the rows by ARTICLE CODE, not physical bale barcode.
 */
import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import { resultRows } from "../../lib/queryResult";

export type DispatchFinancialSourceErrorCode =
  | "FINANCIAL_SOURCE_UNAVAILABLE"
  | "DISPATCH_NOT_CLOSED"
  | "CLOSURE_REOPENED"
  | "MANIFEST_UNAVAILABLE"
  | "MANIFEST_INVALID"
  | "LOADING_CHANGED"
  | "SCANS_CHANGED"
  | "ARTICLE_CODE_MISSING"
  | "PRICE_UNRESOLVED";

export class DispatchFinancialSourceError extends Error {
  constructor(
    readonly code: DispatchFinancialSourceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DispatchFinancialSourceError";
  }
}

function refuse(code: DispatchFinancialSourceErrorCode, message: string): never {
  throw new DispatchFinancialSourceError(code, message);
}

type Row = Record<string, unknown>;
export interface DispatchSourceBale {
  scanId: string;
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: string;
  priceUsed: string;
  priceSource: "ORDER_BALE_PRICE_USED";
  pricingMode: "per_bale";
  unitPrice: string;
  lineTotal: string;
}

export interface DispatchFinancialSourceSnapshot {
  companyId: number;
  orderId: number;
  dispatchId: number;
  customerId: number;
  closureHistoryId: string;
  closureRevision: number;
  manifestFingerprint: string;
  sourceFingerprint: string;
  goodsSubtotal: string;
  totalWeightKg: string;
  baleCount: number;
  bales: DispatchSourceBale[];
}

export interface DispatchSourceInput {
  companyId: number;
  orderId: number;
  dispatchId: number;
  customerId: number;
  closureHistoryId: string;
  closureRevision: number;
  manifestFingerprint: string;
  manifest: unknown;
  orderBales: ReadonlyArray<{
    baleId: number;
    baleReference: string;
    articleCode: string | null;
    productName: string | null;
    weightKg: string;
    priceUsed: string;
  }>;
  activeScans: ReadonlyArray<{
    scanId: string;
    baleId: number;
    dispatchId: string;
  }>;
}

const idString = (value: unknown): string => {
  const stringified = String(value ?? "");
  return /^[1-9][0-9]*$/.test(stringified) ? stringified : "";
};

function decimal(value: unknown, places: number, label: string): Decimal {
  const str = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(str)) {
    refuse("MANIFEST_INVALID", label + " must be a non-negative decimal");
  }
  const result = new MoneyDecimal(str);
  if (!result.isFinite() || result.isNegative() || result.decimalPlaces() > places) {
    refuse("MANIFEST_INVALID", label + " has invalid precision or amount");
  }
  return result;
}

function articleCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!code || code.length > 50) refuse("ARTICLE_CODE_MISSING", "Every signed bale needs a valid article code");
  return code;
}

function signedManifestRows(manifest: unknown): Row[] {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    refuse("MANIFEST_UNAVAILABLE", "No saved bale-level closure manifest is available for financial posting");
  }
  return manifest.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      refuse("MANIFEST_INVALID", "Closure contains an invalid saved scan");
    }
    return row as Row;
  });
}

/** Pure validator/fingerprint builder suitable for deterministic local tests. */
export function createDispatchTripFinancialSource(input: DispatchSourceInput): DispatchFinancialSourceSnapshot {
  if (![input.companyId, input.orderId, input.dispatchId, input.customerId, input.closureRevision]
    .every((n) => Number.isSafeInteger(n) && n > 0)) {
    refuse("FINANCIAL_SOURCE_UNAVAILABLE", "Invalid company, order, trip, customer, or closure revision");
  }
  const closureHistoryId = idString(input.closureHistoryId);
  if (!closureHistoryId || !/^[a-f0-9]{64}$/.test(input.manifestFingerprint)) {
    refuse("MANIFEST_INVALID", "Closure reference or fingerprint is invalid");
  }

  const orderBales = new Map<number, DispatchSourceInput["orderBales"][number]>();
  for (const row of input.orderBales) {
    if (!Number.isSafeInteger(row.baleId) || row.baleId <= 0 || orderBales.has(row.baleId)) {
      refuse("LOADING_CHANGED", "Pending Loading contains invalid or repeated bale IDs");
    }
    orderBales.set(row.baleId, row);
  }

  const activeTripScans = new Map<string, number>();
  const activeBaleIds = new Set<number>();
  for (const scan of input.activeScans) {
    const scanId = idString(scan.scanId);
    if (!scanId || !Number.isSafeInteger(scan.baleId) || scan.baleId <= 0 ||
        activeTripScans.has(scanId) || activeBaleIds.has(scan.baleId)) {
      refuse("SCANS_CHANGED", "Live dispatch contains invalid or repeated scans");
    }
    if (scan.dispatchId !== String(input.dispatchId)) {
      refuse("SCANS_CHANGED", "A scan is assigned to a different dispatch");
    }
    activeTripScans.set(scanId, scan.baleId);
    activeBaleIds.add(scan.baleId);
  }

  const seenScans = new Set<string>();
  const seenBales = new Set<number>();
  const result: DispatchSourceBale[] = [];
  for (const manifestRow of signedManifestRows(input.manifest)) {
    const scanId = idString(manifestRow.scanId);
    const baleId = Number(manifestRow.baleId);
    if (!scanId || !Number.isSafeInteger(baleId) || baleId <= 0 ||
        seenScans.has(scanId) || seenBales.has(baleId)) {
      refuse("MANIFEST_INVALID", "Saved manifest contains an invalid or duplicate barcode");
    }
    if (activeTripScans.get(scanId) !== baleId) {
      refuse("SCANS_CHANGED", "A saved closure scan no longer matches the active dispatch");
    }
    const orderBale = orderBales.get(baleId);
    if (!orderBale) refuse("LOADING_CHANGED", "Signed trip bale was removed from Pending Loading");

    const reference = typeof manifestRow.baleReference === "string" ? manifestRow.baleReference.trim() : "";
    if (!reference || reference !== orderBale.baleReference.trim()) {
      refuse("LOADING_CHANGED", "Bale reference differs from the signed closure");
    }
    const article = articleCode(manifestRow.articleCode);
    if (articleCode(orderBale.articleCode) !== article) {
      refuse("LOADING_CHANGED", "Bale article differs from Pending Loading");
    }
    const weight = decimal(manifestRow.weightKg, 3, "Signed bale KG");
    const orderWeight = decimal(orderBale.weightKg, 3, "Loading bale KG");
    if (!weight.equals(orderWeight)) refuse("LOADING_CHANGED", "Bale KG differs from the signed closure");
    const rawPrice = String(orderBale.priceUsed ?? "");
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(rawPrice)) {
      refuse("PRICE_UNRESOLVED", "Loading bale price is invalid");
    }
    const price = new MoneyDecimal(rawPrice);
    const productName = (orderBale.productName || String(manifestRow.productName ?? "")).trim();
    if (!productName) refuse("MANIFEST_INVALID", "Bale product name is missing");

    result.push({
      scanId, baleId, baleReference: reference,
      articleCode: article,
      productName,
      weightKg: weight.toFixed(3),
      priceUsed: price.toFixed(2),
      priceSource: "ORDER_BALE_PRICE_USED",
      pricingMode: "per_bale",
      unitPrice: price.toFixed(6),
      lineTotal: price.toFixed(2),
    });
    seenScans.add(scanId);
    seenBales.add(baleId);
  }
  if (seenScans.size !== activeTripScans.size) {
    refuse("SCANS_CHANGED", "Closure manifest and currently active trip scans differ");
  }

  const bales = result.sort((a, b) => a.baleId - b.baleId);
  const goodsSubtotal = sumMoney(bales.map((b) => b.lineTotal)).toFixed(2);
  const totalWeightKg = bales.reduce((sum, b) => sum.plus(b.weightKg), new MoneyDecimal(0)).toFixed(3);
  const sourceFingerprint = createHash("sha256").update(JSON.stringify({
    version: 1,
    companyId: input.companyId,
    orderId: input.orderId,
    dispatchId: input.dispatchId,
    customerId: input.customerId,
    closureHistoryId,
    closureRevision: input.closureRevision,
    manifestFingerprint: input.manifestFingerprint,
    bales,
    goodsSubtotal,
    totalWeightKg,
  })).digest("hex");

  return {
    companyId: input.companyId, orderId: input.orderId,
    dispatchId: input.dispatchId, customerId: input.customerId,
    closureHistoryId, closureRevision: input.closureRevision,
    manifestFingerprint: input.manifestFingerprint,
    sourceFingerprint, goodsSubtotal, totalWeightKg, baleCount: bales.length, bales,
  };
}

/**
 * Read the CURRENT signed closure and exact price rows under the caller's
 * transaction. The future posting writer must already hold order->trip locks.
 */
export async function loadDispatchTripFinancialSource(
  tx: DbTransaction, companyId: number, orderId: number, dispatchId: number
): Promise<DispatchFinancialSourceSnapshot> {
  const contextRows = resultRows(await tx.execute(sql`
    SELECT o.id, o.customer_id AS "customerId",
           o.status AS "orderStatus", o.deleted_at AS "deletedAt",
           d.status AS "dispatchStatus",
           h.id::text AS "closureId", h.revision,
           h.close_fingerprint AS "manifestFingerprint",
           h.manifest_snapshot AS "manifest",
           h.reopened_at AS "reopenedAt"
      FROM customer_orders o
      JOIN factory_loading_dispatches d
        ON d.company_id = o.company_id AND d.order_id = o.id
      LEFT JOIN LATERAL (
        SELECT id, revision, close_fingerprint, manifest_snapshot, reopened_at
          FROM factory_loading_dispatch_closure_history
         WHERE company_id = o.company_id AND order_id = o.id
           AND dispatch_id = d.id
         ORDER BY revision DESC LIMIT 1
      ) h ON TRUE
     WHERE o.company_id = ${companyId} AND o.id = ${orderId} AND d.id = ${dispatchId}
  `));
  const context = contextRows[0];
  if (!context || context.deletedAt || !["LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(String(context.orderStatus))) {
    refuse("FINANCIAL_SOURCE_UNAVAILABLE", "This order is unavailable for trip financial finalization");
  }
  if (context.dispatchStatus !== "CLOSED") refuse("DISPATCH_NOT_CLOSED", "End Dispatch before financially finalizing the trip");
  if (!context.closureId) refuse("MANIFEST_UNAVAILABLE", "This trip has no saved close revision");
  if (context.reopenedAt) refuse("CLOSURE_REOPENED", "This signed closure was reopened and cannot be posted");

  const orderBalesRows = resultRows(await tx.execute(sql`
    SELECT cob.bale_id AS "baleId", cob.bale_reference AS "baleReference",
           cob.article_code AS "articleCode", cob.bale_name AS "productName",
           cob.weight::text AS "weightKg", cob.price_used::text AS "priceUsed"
      FROM customer_order_bales cob
      JOIN customer_orders o ON o.id = cob.order_id
     WHERE o.company_id = ${companyId} AND o.id = ${orderId}
  `));
  const activeScanRows = resultRows(await tx.execute(sql`
    SELECT id::text AS "scanId", bale_id AS "baleId", dispatch_id::text AS "dispatchId"
      FROM factory_loading_dispatch_scans
     WHERE company_id = ${companyId} AND order_id = ${orderId}
       AND dispatch_id = ${dispatchId} AND removed_at IS NULL
  `));

  return createDispatchTripFinancialSource({
    companyId, orderId, dispatchId,
    customerId: Number(context.customerId),
    closureHistoryId: String(context.closureId),
    closureRevision: Number(context.revision),
    manifestFingerprint: String(context.manifestFingerprint ?? ""),
    manifest: context.manifest,
    orderBales: orderBalesRows.map((row) => ({
      baleId: Number(row.baleId),
      baleReference: String(row.baleReference ?? ""),
      articleCode: row.articleCode == null ? null : String(row.articleCode),
      productName: row.productName == null ? null : String(row.productName),
      weightKg: String(row.weightKg ?? ""),
      priceUsed: String(row.priceUsed ?? ""),
    })),
    activeScans: activeScanRows.map((row) => ({
      scanId: String(row.scanId ?? ""),
      baleId: Number(row.baleId),
      dispatchId: String(row.dispatchId ?? ""),
    })),
  });
}
