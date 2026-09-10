import { sql } from "drizzle-orm";
import type { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { normalizeLoadingArticleCode } from "./bale-scanning/proformaScanPolicy";

/**
 * Database surface required by the capacity engine. Both the main Drizzle DB
 * and a Drizzle transaction satisfy this contract.
 */
export type ProformaCapacityExecutor = Pick<typeof db, "execute">;

export interface ProformaCapacityOptions {
  companyId: number;
  proformaId: number;
  /** Loading currently being viewed/scanned. Omit when asking for global capacity. */
  currentOrderId?: number | null;
}

export interface ProformaCapacityContribution {
  orderId: number;
  orderStatus: string;
  loadedQty: number;
  isCurrentOrder: boolean;
}

export interface ProformaCapacityArticle {
  /** First non-empty source spelling found on the proforma, otherwise the normalized code. */
  articleCode: string;
  normalizedArticleCode: string;
  isOnProforma: boolean;
  requestedQty: number;
  currentOrderLoadedQty: number;
  siblingLoadedQty: number;
  totalConsumedQty: number;
  remainingQty: number;
  excessQty: number;
  isFulfilled: boolean;
  isOverloaded: boolean;
  contributingOrderIds: number[];
  siblingOrderIds: number[];
  contributions: ProformaCapacityContribution[];
}

export interface ProformaCapacitySnapshot {
  companyId: number;
  proformaId: number;
  customerId: number;
  proformaName: string;
  proformaActive: boolean;
  proformaStatus: string | null;
  currentOrderId: number | null;
  requestedTotalQty: number;
  currentOrderLoadedTotalQty: number;
  siblingLoadedTotalQty: number;
  totalConsumedQty: number;
  remainingTotalQty: number;
  excessTotalQty: number;
  loadedOutsideProformaQty: number;
  articles: ProformaCapacityArticle[];
}

interface ProformaRow extends Record<string, unknown> {
  id: number;
  customerId: number;
  name: string | null;
  isActive: boolean;
  status: string | null;
}

interface ProformaLineRow extends Record<string, unknown> {
  articleCode: string | null;
  quantity: unknown;
}

interface ContributionRow extends Record<string, unknown> {
  normalizedArticleCode: string | null;
  orderId: number;
  orderStatus: string | null;
  loadedQty: unknown;
}

function nonNegativeQuantity(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Pure capacity reducer kept separate from SQL so the business rules can be
 * regression-tested without a database.
 *
 * Rules:
 * - Article codes are compared case-insensitively after trimming.
 * - Duplicate/case-variant proforma lines are one capacity bucket and their
 *   requested quantities are summed.
 * - Current-order and sibling-order consumption remain separately visible.
 * - Remaining quantity never goes below zero; historical overages are exposed
 *   through excessQty instead of being hidden.
 * - Loaded articles absent from the proforma are returned for diagnostics but
 *   do not inflate requested/consumed capacity totals.
 */
export function buildProformaCapacitySnapshot(
  options: ProformaCapacityOptions,
  proforma: ProformaRow,
  lineRows: ProformaLineRow[],
  contributionRows: ContributionRow[]
): ProformaCapacitySnapshot {
  const currentOrderId = options.currentOrderId ?? null;
  const requestedByArticle = new Map<
    string,
    { articleCode: string; requestedQty: number; isOnProforma: true }
  >();

  for (const line of lineRows) {
    const normalized = normalizeLoadingArticleCode(line.articleCode);
    if (!normalized) continue;
    const existing = requestedByArticle.get(normalized);
    if (existing) {
      existing.requestedQty += nonNegativeQuantity(line.quantity);
    } else {
      requestedByArticle.set(normalized, {
        articleCode: String(line.articleCode ?? "").trim() || normalized,
        requestedQty: nonNegativeQuantity(line.quantity),
        isOnProforma: true,
      });
    }
  }

  const contributionsByArticle = new Map<string, Map<number, ProformaCapacityContribution>>();
  for (const row of contributionRows) {
    const normalized = normalizeLoadingArticleCode(row.normalizedArticleCode);
    const orderId = Number(row.orderId);
    if (!normalized || !Number.isSafeInteger(orderId) || orderId <= 0) continue;
    const loadedQty = nonNegativeQuantity(row.loadedQty);
    if (loadedQty <= 0) continue;

    let byOrder = contributionsByArticle.get(normalized);
    if (!byOrder) {
      byOrder = new Map();
      contributionsByArticle.set(normalized, byOrder);
    }
    const existing = byOrder.get(orderId);
    if (existing) {
      existing.loadedQty += loadedQty;
    } else {
      byOrder.set(orderId, {
        orderId,
        orderStatus: String(row.orderStatus ?? "UNKNOWN"),
        loadedQty,
        isCurrentOrder: currentOrderId === orderId,
      });
    }
  }

  const normalizedCodes = new Set<string>([
    ...requestedByArticle.keys(),
    ...contributionsByArticle.keys(),
  ]);

  const articles: ProformaCapacityArticle[] = [...normalizedCodes]
    .sort((a, b) => a.localeCompare(b))
    .map((normalizedArticleCode) => {
      const request = requestedByArticle.get(normalizedArticleCode);
      const contributions = [...(contributionsByArticle.get(normalizedArticleCode)?.values() ?? [])].sort(
        (a, b) => a.orderId - b.orderId
      );
      const currentOrderLoadedQty = contributions
        .filter((entry) => entry.isCurrentOrder)
        .reduce((sum, entry) => sum + entry.loadedQty, 0);
      const siblingLoadedQty = contributions
        .filter((entry) => !entry.isCurrentOrder)
        .reduce((sum, entry) => sum + entry.loadedQty, 0);
      const totalConsumedQty = currentOrderLoadedQty + siblingLoadedQty;
      const requestedQty = request?.requestedQty ?? 0;
      const isOnProforma = !!request;
      const remainingQty = isOnProforma ? Math.max(0, requestedQty - totalConsumedQty) : 0;
      const excessQty = isOnProforma ? Math.max(0, totalConsumedQty - requestedQty) : 0;

      return {
        articleCode: request?.articleCode ?? normalizedArticleCode,
        normalizedArticleCode,
        isOnProforma,
        requestedQty,
        currentOrderLoadedQty,
        siblingLoadedQty,
        totalConsumedQty,
        remainingQty,
        excessQty,
        isFulfilled: isOnProforma && requestedQty > 0 && totalConsumedQty >= requestedQty,
        isOverloaded: isOnProforma && totalConsumedQty > requestedQty,
        contributingOrderIds: contributions.map((entry) => entry.orderId),
        siblingOrderIds: contributions.filter((entry) => !entry.isCurrentOrder).map((entry) => entry.orderId),
        contributions,
      };
    });

  const onProforma = articles.filter((article) => article.isOnProforma);
  const requestedTotalQty = onProforma.reduce((sum, article) => sum + article.requestedQty, 0);
  const currentOrderLoadedTotalQty = onProforma.reduce((sum, article) => sum + article.currentOrderLoadedQty, 0);
  const siblingLoadedTotalQty = onProforma.reduce((sum, article) => sum + article.siblingLoadedQty, 0);
  const totalConsumedQty = onProforma.reduce((sum, article) => sum + article.totalConsumedQty, 0);
  const remainingTotalQty = onProforma.reduce((sum, article) => sum + article.remainingQty, 0);
  const excessTotalQty = onProforma.reduce((sum, article) => sum + article.excessQty, 0);
  const loadedOutsideProformaQty = articles
    .filter((article) => !article.isOnProforma)
    .reduce((sum, article) => sum + article.totalConsumedQty, 0);

  return {
    companyId: options.companyId,
    proformaId: options.proformaId,
    customerId: Number(proforma.customerId),
    proformaName: proforma.name ?? "",
    proformaActive: !!proforma.isActive,
    proformaStatus: proforma.status ?? null,
    currentOrderId,
    requestedTotalQty,
    currentOrderLoadedTotalQty,
    siblingLoadedTotalQty,
    totalConsumedQty,
    remainingTotalQty,
    excessTotalQty,
    loadedOutsideProformaQty,
    articles,
  };
}

/**
 * Authoritative proforma loading-capacity reader.
 *
 * Consumption semantics intentionally match the scanner's safety boundary:
 * every non-cancelled, non-deleted order tied to this proforma consumes its
 * capacity, regardless of whether it is LOADING, VERIFIED, or FINALIZED.
 * Distinct physical bale IDs are counted so an accidental duplicate join row
 * cannot consume the same capacity twice inside one order. Article-code
 * recovery follows the scanner: persisted order-bale code, then physical-bale
 * code, then the canonical product code.
 */
export async function getProformaCapacitySnapshot(
  executor: ProformaCapacityExecutor,
  options: ProformaCapacityOptions
): Promise<ProformaCapacitySnapshot | null> {
  const proformaRows = resultRows<ProformaRow>(
    await executor.execute(sql`
      SELECT
        id,
        customer_id AS "customerId",
        name,
        is_active AS "isActive",
        status
      FROM customer_proformas
      WHERE id = ${options.proformaId}
        AND company_id = ${options.companyId}
        AND deleted_at IS NULL
      LIMIT 1
    `)
  );
  const proforma = proformaRows[0];
  if (!proforma) return null;

  const lineRows = resultRows<ProformaLineRow>(
    await executor.execute(sql`
      SELECT article_code AS "articleCode", quantity
      FROM customer_proforma_lines
      WHERE proforma_id = ${options.proformaId}
    `)
  );

  const contributionRows = resultRows<ContributionRow>(
    await executor.execute(sql`
      SELECT
        LOWER(COALESCE(
          NULLIF(TRIM(cob.article_code), ''),
          NULLIF(TRIM(fb.article_code), ''),
          NULLIF(TRIM(fbp.article_code), ''),
          ''
        )) AS "normalizedArticleCode",
        co.id AS "orderId",
        co.status AS "orderStatus",
        COUNT(DISTINCT cob.bale_id)::int AS "loadedQty"
      FROM customer_order_bales cob
      INNER JOIN customer_orders co ON co.id = cob.order_id
      LEFT JOIN factory_bales fb ON fb.id = cob.bale_id
      LEFT JOIN factory_bale_products fbp
        ON fbp.id = fb.product_id
       AND fbp.company_id = co.company_id
      WHERE co.company_id = ${options.companyId}
        AND co.proforma_id_used = ${options.proformaId}
        AND co.status <> 'CANCELLED'
        AND co.deleted_at IS NULL
        AND COALESCE(
          NULLIF(TRIM(cob.article_code), ''),
          NULLIF(TRIM(fb.article_code), ''),
          NULLIF(TRIM(fbp.article_code), ''),
          ''
        ) <> ''
      GROUP BY
        LOWER(COALESCE(
          NULLIF(TRIM(cob.article_code), ''),
          NULLIF(TRIM(fb.article_code), ''),
          NULLIF(TRIM(fbp.article_code), ''),
          ''
        )),
        co.id,
        co.status
    `)
  );

  return buildProformaCapacitySnapshot(options, proforma, lineRows, contributionRows);
}

/** Small lookup helper for scan/import call sites that start from a raw code. */
export function findProformaCapacityArticle(
  snapshot: ProformaCapacitySnapshot,
  articleCode: unknown
): ProformaCapacityArticle | undefined {
  const normalized = normalizeLoadingArticleCode(articleCode);
  return snapshot.articles.find((article) => article.normalizedArticleCode === normalized);
}
