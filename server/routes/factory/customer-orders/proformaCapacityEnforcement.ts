import { findProformaCapacityArticle, type ProformaCapacitySnapshot } from "./proformaCapacity";
import { normalizeLoadingArticleCode } from "./bale-scanning/proformaScanPolicy";

export type ProformaCapacityRejectionReason = "not_in_proforma" | "quantity_exceeded";

/**
 * Which loaded quantity the capacity check is measured against.
 *
 * - `"per_loading"` — the normal loading rule. A loading with locked
 *   customer_order_expected_lines is validated against that plan only. A live
 *   loading without expected lines is reference-only: the linked proforma can
 *   supply pricing/product context but does not cap or reject scans.
 * - `"global"` — aggregate historical/reporting view across every loading that
 *   references the proforma. Use this only when the caller explicitly needs a
 *   cross-loading total rather than a loading-time validation decision.
 */
export type ProformaCapacityScope = "global" | "per_loading";
export type ProformaLoadingValidationMode = "global" | "planned" | "reference" | "template";

export interface ProformaArticleCapacityDecision {
  allowed: boolean;
  reason: ProformaCapacityRejectionReason | null;
  validationMode: ProformaLoadingValidationMode;
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

function validationModeForScope(
  snapshot: ProformaCapacitySnapshot,
  scope: ProformaCapacityScope
): ProformaLoadingValidationMode {
  if (scope === "global") return "global";
  if (snapshot.currentOrderId === null) return "template";
  return snapshot.currentOrderHasExpectedPlan ? "planned" : "reference";
}

function remainingTotalForScope(snapshot: ProformaCapacitySnapshot, scope: ProformaCapacityScope): number {
  if (scope === "global") return snapshot.remainingTotalQty;
  if (snapshot.currentOrderId !== null) {
    if (!snapshot.currentOrderHasExpectedPlan) {
      // A reference-only loading is never "consumed" by quantity. Keep a
      // positive availability signal while the proforma itself is active.
      return snapshot.requestedTotalQty;
    }
    return snapshot.currentOrderRemainingTotalQty ?? 0;
  }
  return snapshot.articles
    .filter((article) => article.isOnProforma)
    .reduce((sum, article) => sum + Math.max(0, article.requestedQty - article.currentOrderLoadedQty), 0);
}

/**
 * Evaluate one proposed quantity increase against the authoritative snapshot.
 * A current loading's strict limits come only from its locked expected lines.
 * The master proforma is reusable and therefore is not a per-container cap.
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
  const validationMode = validationModeForScope(snapshot, scope);

  if (validationMode === "reference") {
    const consumedQty = article?.currentOrderLoadedQty ?? 0;
    const requestedQty = article?.requestedQty ?? 0;
    return {
      allowed: true,
      reason: null,
      validationMode,
      articleCode: article?.articleCode ?? String(articleCode ?? "").trim(),
      normalizedArticleCode,
      requestedAdditionalQty: additionalQty,
      requestedQty,
      consumedQty,
      remainingQty: Math.max(0, requestedQty - consumedQty),
      projectedConsumedQty: consumedQty + additionalQty,
    };
  }

  const usesExpectedPlan = validationMode === "planned";
  const isAllowedArticle = article && (usesExpectedPlan ? article.isExpectedOnCurrentOrder : article.isOnProforma);
  const requestedQty = article
    ? usesExpectedPlan
      ? (article.currentOrderExpectedQty ?? 0)
      : article.requestedQty
    : 0;
  const consumedQty = article
    ? scope === "global"
      ? article.totalConsumedQty
      : article.currentOrderLoadedQty
    : 0;

  if (!isAllowedArticle) {
    return {
      allowed: false,
      reason: "not_in_proforma",
      validationMode,
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
  const allowed = projectedConsumedQty <= requestedQty;
  const remainingQty = Math.max(0, requestedQty - consumedQty);
  return {
    allowed,
    reason: allowed ? null : "quantity_exceeded",
    validationMode,
    articleCode: article.articleCode,
    normalizedArticleCode,
    requestedAdditionalQty: additionalQty,
    requestedQty,
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
 * order. Planned loadings use their per-container expected totals; reference
 * loadings fall back to the master line quantities for optional recovery tools,
 * but scan validation itself remains non-blocking in reference mode.
 */
export function allocateRemainingProformaLines<T extends { articleCode: unknown; quantity: unknown }>(
  lines: T[],
  snapshot: ProformaCapacitySnapshot,
  scope: ProformaCapacityScope = "per_loading"
): RemainingProformaLineAllocation<T>[] {
  const mode = validationModeForScope(snapshot, scope);
  const unallocatedConsumed = new Map(
    snapshot.articles
      .filter((article) => (mode === "planned" ? article.isExpectedOnCurrentOrder : article.isOnProforma))
      .map((article) => [
        article.normalizedArticleCode,
        scope === "global" ? article.totalConsumedQty : article.currentOrderLoadedQty,
      ] as const)
  );
  const unallocatedExpected =
    mode === "planned"
      ? new Map(
          snapshot.articles
            .filter((article) => article.isExpectedOnCurrentOrder)
            .map((article) => [article.normalizedArticleCode, article.currentOrderExpectedQty ?? 0] as const)
        )
      : null;

  return lines.map((line) => {
    const normalizedArticleCode = normalizeLoadingArticleCode(line.articleCode);
    const sourceRequestedQty = nonNegativeQuantity(line.quantity);
    const expectedAvailable = unallocatedExpected?.get(normalizedArticleCode);
    const requestedQty =
      expectedAvailable === undefined ? sourceRequestedQty : Math.min(sourceRequestedQty, Math.max(0, expectedAvailable));
    if (unallocatedExpected) {
      unallocatedExpected.set(normalizedArticleCode, Math.max(0, (expectedAvailable ?? 0) - requestedQty));
    }
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
