export type ProformaLineStatus = "fulfilled" | "overloaded" | "short" | "none" | "reference";

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
 * Progress is always calculated against this loading only. Sibling loadings are
 * deliberately ignored so a reusable proforma can be linked to several
 * independent containers without one container changing another container's
 * display.
 *
 * These statuses are informational. Server-side live loading enforcement still
 * treats the linked proforma as reusable/reference-only, so "overloaded",
 * "short", and "missing" describe the current loading versus the proforma but
 * never block scanning, importing, exchanging, or finalizing bales.
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
