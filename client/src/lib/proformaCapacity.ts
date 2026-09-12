export type ProformaLineStatus = "fulfilled" | "overloaded" | "short" | "none";

export interface ProformaCapacityArticle {
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
  productName?: string;
}

export interface ProformaCapacitySnapshot {
  proformaId: number;
  companyId: number;
  customerId: number;
  proformaName: string;
  proformaActive: boolean;
  currentOrderId: number | null;
  requestedTotalQty: number;
  currentOrderLoadedTotalQty: number;
  siblingLoadedTotalQty: number;
  totalConsumedQty: number;
  remainingTotalQty: number;
  excessTotalQty: number;
  articles: ProformaCapacityArticle[];
}

export interface ProformaProgressLine {
  id: string;
  articleCode: string;
  normalizedArticleCode: string;
  productName: string;
  quantity: number;
  loaded: number;
  siblingLoaded: number;
  totalLoaded: number;
  remaining: number;
  fulfilled: boolean;
  status: ProformaLineStatus;
  excess: number;
}

export function normalizeProformaArticleCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Capacity snapshots arrive straight from `res.json()`, so `articles` is only
 * guaranteed by the declared type, not by anything checked at runtime. A body
 * that omits it — an older server, a JSON error payload — would otherwise throw
 * while a loading page renders and take the whole page down, so every consumer
 * reads the bucket list through here.
 */
export function proformaCapacityArticles(
  snapshot: ProformaCapacitySnapshot | null | undefined
): ProformaCapacityArticle[] {
  return Array.isArray(snapshot?.articles) ? snapshot.articles : [];
}

/**
 * Loading progress is intentionally per-loading. The capacity snapshot keeps
 * sibling/global totals for reporting, but another loading that reused the same
 * proforma must never make this loading look fulfilled or overloaded.
 */
export function buildProformaProgress(snapshot: ProformaCapacitySnapshot | null | undefined): ProformaProgressLine[] {
  if (!snapshot) return [];
  return proformaCapacityArticles(snapshot)
    .filter((article) => article.isOnProforma)
    .map((article) => {
      const loaded = article.currentOrderLoadedQty;
      const remaining = Math.max(0, article.requestedQty - loaded);
      const excess = Math.max(0, loaded - article.requestedQty);
      const status: ProformaLineStatus =
        excess > 0
          ? "overloaded"
          : article.requestedQty > 0 && loaded === article.requestedQty
            ? "fulfilled"
            : loaded === 0
              ? "none"
              : "short";
      return {
        id: `${snapshot.proformaId}:${article.normalizedArticleCode}`,
        articleCode: article.articleCode,
        normalizedArticleCode: article.normalizedArticleCode,
        productName: article.productName || article.articleCode,
        quantity: article.requestedQty,
        loaded,
        siblingLoaded: article.siblingLoadedQty,
        totalLoaded: loaded,
        remaining,
        fulfilled: article.requestedQty > 0 && loaded >= article.requestedQty,
        status,
        excess,
      };
    });
}
