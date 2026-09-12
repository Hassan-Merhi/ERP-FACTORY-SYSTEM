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
 * Once a loading exists, its linked proforma is reference-only. Show the master
 * proforma quantity next to what this loading actually scanned, but never call
 * the live loading overloaded/short/missing because the same proforma may be
 * reused for several independently composed loadings.
 *
 * A snapshot without currentOrderId is still a template/global preview, so the
 * historical status calculation remains available there.
 */
export function buildProformaProgress(snapshot: ProformaCapacitySnapshot | null | undefined): ProformaProgressLine[] {
  if (!snapshot) return [];
  const referenceOnly = snapshot.currentOrderId !== null;
  return proformaCapacityArticles(snapshot)
    .filter((article) => article.isOnProforma)
    .map((article) => {
      const loaded = article.currentOrderLoadedQty;
      if (referenceOnly) {
        return {
          id: `${snapshot.proformaId}:${article.normalizedArticleCode}`,
          articleCode: article.articleCode,
          normalizedArticleCode: article.normalizedArticleCode,
          productName: article.productName || article.articleCode,
          quantity: article.requestedQty,
          loaded,
          siblingLoaded: article.siblingLoadedQty,
          totalLoaded: loaded,
          remaining: 0,
          fulfilled: false,
          status: "reference" as const,
          excess: 0,
        };
      }

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
