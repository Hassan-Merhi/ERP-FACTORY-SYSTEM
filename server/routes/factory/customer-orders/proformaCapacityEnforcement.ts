import { findProformaCapacityArticle, type ProformaCapacitySnapshot } from "./proformaCapacity";
import { normalizeLoadingArticleCode } from "./bale-scanning/proformaScanPolicy";

export type ProformaCapacityRejectionReason = "not_in_proforma" | "quantity_exceeded";

/**
 * Which loaded quantity the capacity check is measured against.
 *
 * - `"per_loading"` — the normal loading rule. Each loading/container is an
 *   independent unit, so sibling containers that reuse the same proforma do
 *   not consume this loading's quantity allowance.
 * - `"global"` — aggregate historical/reporting view across every loading that
 *   references the proforma. Use this only when the caller explicitly needs a
 *   cross-loading total rather than a loading-time validation decision.
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

function remainingTotalForScope(snapshot: ProformaCapacitySnapshot, scope: ProformaCapacityScope): number {
  if (scope === "global") return snapshot.remainingTotalQty;
  return snapshot.articles
    .filter((article) => article.isOnProforma)
    .reduce((sum, article) => sum + Math.max(0, article.requestedQty - article.currentOrderLoadedQty), 0);
}

/**
 * Evaluate one proposed quantity increase against the authoritative snapshot.
 * Loading-time decisions default to per-loading semantics: another loading that
 * uses the same proforma never consumes this loading's quantity allowance.
 */
export function evaluateProformaArticleCapacity(
  snapshot: ProformaCapacitySnapshot,
  articleCode: unknown,
  requestedAdditionalQty: unknown = 1,
  scope: ProformaCapacityScope = "per_loading"
): ProformaArticleCapacityDecision {
  const normalizedArticleCode = normalizeLoadingArticleCode(articleCode);
  const additionalQty = nonNegativeQuantity(requestedAdditionalQty);
  const article = findProformaCapacityArticle(snapshot, normalizedArticleCode);
  const consumedQty = article
    ? scope === "per_loading"
      ? article.currentOrderLoadedQty
      : article.totalConsumedQty
    : 0;

  if (!article || !article.isOnProforma) {
    return {
      allowed: false,
      reason: "not_in_proforma",
      articleCode: String(articleCode ?? "").trim(),
      normalizedArticleCode,
      requestedAdditionalQty: additionalQty,
      requestedQty: 0,
      consumedQty,
      remainingQty: 0,
      projectedConsumedQty: consumedQty + additionalQty,
    };
  }

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
  additions: ProformaCapacityAddition[],
  scope: ProformaCapacityScope = "per_loading"
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
    .map((addition) => evaluateProformaArticleCapacity(snapshot, addition.articleCode, addition.quantity, scope))
    .filter((decision) => !decision.allowed);
  return { allowed: issues.length === 0, issues };
}

/**
 * Creation-time guard. An active proforma can be reused by multiple independent
 * loadings for the same customer. Sibling loadings do not exhaust a new one.
 */
export function evaluateProformaLoadingAvailability(
  snapshot: ProformaCapacitySnapshot,
  customerId: unknown,
  scope: ProformaCapacityScope = "per_loading"
): ProformaLoadingAvailabilityDecision {
  const parsedCustomerId = Number(customerId);
  const remainingTotalQty = remainingTotalForScope(snapshot, scope);
  if (!snapshot.proformaActive) {
    return { allowed: false, reason: "inactive", remainingTotalQty };
  }
  if (!Number.isSafeInteger(parsedCustomerId) || parsedCustomerId <= 0 || snapshot.customerId !== parsedCustomerId) {
    return { allowed: false, reason: "customer_mismatch", remainingTotalQty };
  }
  if (remainingTotalQty <= 0) {
    return { allowed: false, reason: "fully_consumed", remainingTotalQty: 0 };
  }
  return { allowed: true, reason: null, remainingTotalQty };
}

/**
 * Allocate consumption across duplicate/case-variant source lines in source
 * order. Loading-time callers default to the current loading only; callers that
 * intentionally need aggregate historical remaining capacity can pass global.
 */
export function allocateRemainingProformaLines<T extends { articleCode: unknown; quantity: unknown }>(
  lines: T[],
  snapshot: ProformaCapacitySnapshot,
  scope: ProformaCapacityScope = "per_loading"
): RemainingProformaLineAllocation<T>[] {
  const unallocatedConsumed = new Map(
    snapshot.articles
      .filter((article) => article.isOnProforma)
      .map((article) => [
        article.normalizedArticleCode,
        scope === "per_loading" ? article.currentOrderLoadedQty : article.totalConsumedQty,
      ] as const)
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
