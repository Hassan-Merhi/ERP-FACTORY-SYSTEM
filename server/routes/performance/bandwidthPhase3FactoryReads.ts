import type { Express, RequestHandler } from "express";
import { pool } from "../../db";
import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

function requestCompanyId(req: import("express").Request): number | null {
  const raw = req.session?.factoryCompanyId || req.session?.currentCompanyId;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * One grouped bale-ledger row. The aliases are quoted in SQL so the columns
 * arrive camelCased, and the three aggregates are cast to int/float in the
 * query, so they really are numbers rather than the strings a bare SUM returns.
 */
interface LedgerSummaryRow {
  section: LedgerSection;
  productId: number | null;
  productName: string | null;
  articleCode: string | null;
  categoryName: string | null;
  baleCount: number;
  totalWeightKg: number;
  totalCost: number;
}

/** One bale in the per-section detail list; both amounts are cast to float in SQL. */
interface LedgerBaleDetailRow {
  id: number;
  ref: string;
  weightKg: number;
  totalCost: number;
}

/** A ledger row after its section has been stripped for bucketing. */
type LedgerBucketRow = Omit<LedgerSummaryRow, "section">;

const LEDGER_SECTIONS = ["currentStock", "wasteStock", "sold", "wasteDispatched", "pendingLoading"] as const;

type LedgerSection = (typeof LEDGER_SECTIONS)[number];

function isLedgerSection(value: unknown): value is LedgerSection {
  return (LEDGER_SECTIONS as readonly unknown[]).includes(value);
}

function ledgerTotals(rows: readonly LedgerBucketRow[]) {
  return rows.reduce(
    (total, row) => ({
      baleCount: total.baleCount + Number(row.baleCount || 0),
      totalWeightKg: total.totalWeightKg + Number(row.totalWeightKg || 0),
      totalCost: total.totalCost + Number(row.totalCost || 0),
    }),
    { baleCount: 0, totalWeightKg: 0, totalCost: 0 }
  );
}

// This mirrors the legacy employeeLedgerWasteRoutes classification exactly,
// but performs it in PostgreSQL instead of loading every bale, product,
// category, active-order ID and stale-order ID into Node on each summary read.
const LEDGER_CLASSIFICATION_SQL = `
  CASE
    WHEN fb.status = 'SOLD' THEN
      CASE WHEN EXISTS (
        SELECT 1
        FROM customer_order_bales cob
        INNER JOIN customer_orders co ON co.id = cob.order_id
        WHERE cob.bale_id = fb.id
          AND co.company_id = $1
          AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
      ) THEN 'pendingLoading' ELSE 'sold' END
    WHEN fb.status = 'FINALIZED' THEN 'sold'
    WHEN fb.status = 'DISPATCHED' AND fb.waste_dispatch_id IS NOT NULL THEN 'wasteDispatched'
    WHEN fb.status = 'RESERVED_FOR_ORDER' THEN 'pendingLoading'
    WHEN fb.status = 'IN_STOCK' THEN
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM customer_order_bales cob
          INNER JOIN customer_orders co ON co.id = cob.order_id
          WHERE cob.bale_id = fb.id
            AND co.company_id = $1
            AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
        ) THEN 'pendingLoading'
        WHEN EXISTS (
          SELECT 1
          FROM customer_order_bales cob
          INNER JOIN customer_orders co ON co.id = cob.order_id
          WHERE cob.bale_id = fb.id
            AND co.company_id = $1
            AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
        ) THEN 'sold'
        WHEN COALESCE(fb.article_code, '') LIKE 'HMD16%'
          OR LOWER(COALESCE(fc.name, '')) LIKE '%garbage%'
          OR LOWER(COALESCE(fc.name, '')) LIKE '%wiper%'
        THEN 'wasteStock'
        ELSE 'currentStock'
      END
    ELSE NULL
  END
`;

async function sendLedgerSummary(companyId: number, res: import("express").Response): Promise<void> {
  const result = await pool.query<LedgerSummaryRow>(
    `WITH classified AS (
       SELECT
         fb.id,
         fb.product_id,
         COALESCE(fbp.name, fb.product_name, fb.article_code, 'Unknown') AS product_name,
         COALESCE(fbp.article_code, fb.article_code, '—') AS article_code,
         COALESCE(fc.name, '—') AS category_name,
         COALESCE(fb.weight_kg::numeric, 0) AS weight_kg,
         COALESCE(fbp.production_price::numeric, 0) AS sell_value,
         ${LEDGER_CLASSIFICATION_SQL} AS section
       FROM factory_bales fb
       LEFT JOIN factory_bale_products fbp
         ON fbp.id = fb.product_id
        AND fbp.company_id = $1
       LEFT JOIN factory_categories fc
         ON fc.id = fbp.category_id
        AND fc.company_id = $1
       WHERE fb.company_id = $1
         AND fb.status IN ('IN_STOCK', 'FINALIZED', 'SOLD', 'DISPATCHED', 'RESERVED_FOR_ORDER')
         AND (
           fb.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER')
           OR fb.created_at >= NOW() - INTERVAL '90 days'
         )
     )
     SELECT
       section,
       product_id AS "productId",
       product_name AS "productName",
       article_code AS "articleCode",
       category_name AS "categoryName",
       COUNT(*)::int AS "baleCount",
       COALESCE(SUM(weight_kg), 0)::float AS "totalWeightKg",
       COALESCE(SUM(sell_value), 0)::float AS "totalCost"
     FROM classified
     WHERE section IS NOT NULL
     GROUP BY section, product_id, product_name, article_code, category_name
     ORDER BY section, category_name, product_name, product_id NULLS LAST`,
    [companyId]
  );

  const buckets: Record<LedgerSection, LedgerBucketRow[]> = {
    currentStock: [],
    wasteStock: [],
    sold: [],
    wasteDispatched: [],
    pendingLoading: [],
  };
  for (const row of result.rows) {
    const { section, ...bucketRow } = row;
    if (isLedgerSection(section)) buckets[section].push(bucketRow);
  }

  const totals = {
    currentStock: ledgerTotals(buckets.currentStock),
    wasteStock: ledgerTotals(buckets.wasteStock),
    sold: ledgerTotals(buckets.sold),
    wasteDispatched: ledgerTotals(buckets.wasteDispatched),
    pendingLoading: ledgerTotals(buckets.pendingLoading),
  };
  const grand = ledgerTotals([
    ...buckets.currentStock,
    ...buckets.wasteStock,
    ...buckets.sold,
    ...buckets.wasteDispatched,
    ...buckets.pendingLoading,
  ]);

  res.set("X-ERP-Payload-Profile", "bale-ledger-sql-aggregate");
  res.set("Cache-Control", "private, max-age=120");
  res.json({ ...buckets, totals: { ...totals, grand } });
}

async function sendLedgerDetails(
  companyId: number,
  req: import("express").Request,
  res: import("express").Response
): Promise<void> {
  const section = String(req.query.section || "");
  const validSections = new Set(["currentStock", "wasteStock", "sold", "wasteDispatched", "pendingLoading"]);
  if (!validSections.has(section)) {
    res.status(400).json({ message: "Invalid section" });
    return;
  }

  const rawProductId = String(req.query.productId ?? "null");
  const productId = rawProductId === "null" ? null : Number.parseInt(rawProductId, 10);
  if (productId !== null && (!Number.isFinite(productId) || productId <= 0)) {
    res.status(400).json({ message: "Invalid productId" });
    return;
  }

  const params: unknown[] = [companyId, section];
  const productClause = productId === null ? "fb.product_id IS NULL" : "fb.product_id = $3";
  if (productId !== null) params.push(productId);

  const result = await pool.query<LedgerBaleDetailRow>(
    `WITH classified AS (
       SELECT
         fb.id,
         fb.reference_number,
         COALESCE(fb.weight_kg::numeric, 0) AS weight_kg,
         COALESCE(fbp.production_price::numeric, 0) AS sell_value,
         ${LEDGER_CLASSIFICATION_SQL} AS section
       FROM factory_bales fb
       LEFT JOIN factory_bale_products fbp
         ON fbp.id = fb.product_id
        AND fbp.company_id = $1
       LEFT JOIN factory_categories fc
         ON fc.id = fbp.category_id
        AND fc.company_id = $1
       WHERE fb.company_id = $1
         AND fb.status IN ('IN_STOCK', 'FINALIZED', 'SOLD', 'DISPATCHED', 'RESERVED_FOR_ORDER')
         AND ${productClause}
         AND (
           fb.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER')
           OR fb.created_at >= NOW() - INTERVAL '90 days'
         )
     )
     SELECT
       id,
       COALESCE(reference_number, '') AS ref,
       weight_kg::float AS "weightKg",
       sell_value::float AS "totalCost"
     FROM classified
     WHERE section = $2
     ORDER BY id ASC`,
    params
  );

  res.set("X-ERP-Payload-Profile", "bale-ledger-detail-sql");
  res.set("Cache-Control", "private, max-age=300");
  res.json({ baleDetails: result.rows });
}

/**
 * Phase 3 Bale Ledger accelerator.
 *
 * This is mounted as middleware rather than registering duplicate GET route
 * signatures. It owns only GET /api/factory/bale-ledger and GET
 * /api/factory/bale-ledger/details; every other method/path falls through to the
 * existing Factory route module unchanged.
 */
export function registerBandwidthPhase3FactoryReads(app: Express): void {
  app.use("/api/factory/bale-ledger", requireAuth, (async (req, res, next) => {
    if (req.method !== "GET") return next();

    try {
      const companyId = requestCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      if (req.path === "/" || req.path === "") {
        await sendLedgerSummary(companyId, res);
        return;
      }
      if (req.path === "/details") {
        await sendLedgerDetails(companyId, req, res);
        return;
      }
      return next();
    } catch (error: unknown) {
      logger.error("Error fetching bandwidth-optimized bale ledger", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  }) as RequestHandler);
}
