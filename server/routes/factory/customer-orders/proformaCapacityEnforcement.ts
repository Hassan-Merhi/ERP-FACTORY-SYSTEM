import { findProformaCapacityArticle, type ProformaCapacitySnapshot } from "./proformaCapacity";
import { normalizeLoadingArticleCode } from "./bale-scanning/proformaScanPolicy";

export type ProformaCapacityRejectionReason = "not_in_proforma" | "quantity_exceeded";

/**
 * Which loaded quantity the capacity check is measured against.
 *
 * - `"global"` — the proforma quantity is a total shared across every
 *   loading/container that references it (the historical default). Sibling
 *   containers consume each other's capacity.
 * - `"per_loading"` — each loading/container is an independent unit. A bale is
 *   counted only against what has already been loaded into the *current*
 *   loading, so reusing one proforma for several containers lets every
 *   container load up to the full proforma quantity on its own.
 */
export type ProformaCapacityScope = "global" | "per_loading";

export interface ProformaArticleCapacityDecision {
  allowed: boolean;
  reason: ProformaCapacityRejectionReason | null;
  articleCode: string;
  normalizedArticleCode: string;
  requestedAdditionalQty: number;
  requestedQty: number;
  consumedQty: number;
  remainingQty: number;
  projectedConsumedQty: number;
}

export interface ProformaLoadingAvailabilityDecision {
  allowed: boolean;
  reason: "inactive" | "customer_mismatch" | "fully_consumed" | null;
  remainingTotalQty: number;
}

export interface ProformaCapacityAddition {
  articleCode: unknown;
  quantity: unknown;
}

export interface ProformaCapacityValidation {
  allowed: boolean;
  issues: ProformaArticleCapacityDecision[];
}

export interface RemainingProformaLineAllocation<T> {
  line: T;
  normalizedArticleCode: string;
  requestedQty: number;
  consumedQty: number;
  remainingQty: number;
}

function nonNegativeQuantity(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Evaluate one proposed quantity increase against the authoritative Phase 1
 * snapshot. This is intentionally pure so every write path can share the exact
 * same membership and remaining-capacity semantics.
 */
export function evaluateProformaArticleCapacity(
  snapshot: ProformaCapacitySnapshot,
  articleCode: unknown,
  requestedAdditionalQty: unknown = 1,
  scope: ProformaCapacityScope = "global"
): ProformaArticleCapacityDecision {
  const normalizedArticleCode = normalizeLoadingArticleCode(articleCode);
  const additionalQty = nonNegativeQuantity(requestedAdditionalQty);
  const article = findProformaCapacityArticle(snapshot, normalizedArticleCode);

  if (!article || !article.isOnProforma) {
    return {
      allowed: false,
      reason: "not_in_proforma",
      articleCode: String(articleCode ?? "").trim(),
      normalizedArticleCode,
      requestedAdditionalQty: additionalQty,
      requestedQty: 0,
      consumedQty: article?.totalConsumedQty ?? 0,
      remainingQty: 0,
      projectedConsumedQty: (article?.totalConsumedQty ?? 0) + additionalQty,
    };
  }

  // Per-loading mode measures only what the current loading has already
  // consumed, so sibling containers sharing the same proforma no longer block
  // this container from loading up to the full proforma quantity.
  const consumedQty = scope === "per_loading" ? article.currentOrderLoadedQty : article.totalConsumedQty;
  const projectedConsumedQty = consumedQty + additionalQty;
  const allowed = projectedConsumedQty <= article.requestedQty;
  const remainingQty = scope === "per_loading" ? Math.max(0, article.requestedQty - consumedQty) : article.remainingQty;
  return {
    allowed,
    reason: allowed ? null : "quantity_exceeded",
    articleCode: article.articleCode,
    normalizedArticleCode,
    requestedAdditionalQty: additionalQty,
    requestedQty: article.requestedQty,
    consumedQty,
    remainingQty,
    projectedConsumedQty,
  };
}

/** Validate a grouped set of candidate additions against one snapshot. */
export function validateProformaCapacityAdditions(
  snapshot: ProformaCapacitySnapshot,
  additions: ProformaCapacityAddition[]
): ProformaCapacityValidation {
  const grouped = new Map<string, { articleCode: unknown; quantity: number }>();
  for (const addition of additions) {
    const normalized = normalizeLoadingArticleCode(addition.articleCode);
    if (!normalized) continue;
    const quantity = nonNegativeQuantity(addition.quantity);
    if (quantity <= 0) continue;
    const existing = grouped.get(normalized);
    if (existing) existing.quantity += quantity;
    else grouped.set(normalized, { articleCode: addition.articleCode, quantity });
  }

  const issues = [...grouped.values()]
    .map((addition) => evaluateProformaArticleCapacity(snapshot, addition.articleCode, addition.quantity))
    .filter((decision) => !decision.allowed);
  return { allowed: issues.length === 0, issues };
}

/**
 * Creation-time guard. Empty containers/orders are useful only while an active
 * proforma still has capacity for the same customer.
 */
export function evaluateProformaLoadingAvailability(
  snapshot: ProformaCapacitySnapshot,
  customerId: unknown
): ProformaLoadingAvailabilityDecision {
  const parsedCustomerId = Number(customerId);
  if (!snapshot.proformaActive) {
    return { allowed: false, reason: "inactive", remainingTotalQty: snapshot.remainingTotalQty };
  }
  if (!Number.isSafeInteger(parsedCustomerId) || parsedCustomerId <= 0 || snapshot.customerId !== parsedCustomerId) {
    return { allowed: false, reason: "customer_mismatch", remainingTotalQty: snapshot.remainingTotalQty };
  }
  if (snapshot.remainingTotalQty <= 0) {
    return { allowed: false, reason: "fully_consumed", remainingTotalQty: 0 };
  }
  return { allowed: true, reason: null, remainingTotalQty: snapshot.remainingTotalQty };
}

/**
 * Allocate historical consumption across duplicate/case-variant source lines in
 * source order. This preserves each line's pricing while making the combined
 * remaining quantity agree exactly with the authoritative snapshot.
 */
export function allocateRemainingProformaLines<T extends { articleCode: unknown; quantity: unknown }>(
  lines: T[],
  snapshot: ProformaCapacitySnapshot
): RemainingProformaLineAllocation<T>[] {
  const unallocatedConsumed = new Map(
    snapshot.articles
      .filter((article) => article.isOnProforma)
      .map((article) => [article.normalizedArticleCode, article.totalConsumedQty] as const)
  );

  return lines.map((line) => {
    const normalizedArticleCode = normalizeLoadingArticleCode(line.articleCode);
    const requestedQty = nonNegativeQuantity(line.quantity);
    const availableConsumed = unallocatedConsumed.get(normalizedArticleCode) ?? 0;
    const consumedQty = Math.min(requestedQty, availableConsumed);
    unallocatedConsumed.set(normalizedArticleCode, Math.max(0, availableConsumed - consumedQty));
    return {
      line,
      normalizedArticleCode,
      requestedQty,
      consumedQty,
      remainingQty: Math.max(0, requestedQty - consumedQty),
    };
  });
}
