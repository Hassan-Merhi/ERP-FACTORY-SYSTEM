import { findProformaCapacityArticle, type ProformaCapacitySnapshot } from "./proformaCapacity";
import { normalizeLoadingArticleCode } from "./bale-scanning/proformaScanPolicy";

export type ProformaCapacityRejectionReason = "not_in_proforma" | "quantity_exceeded";

/**
 * Loading-time semantics are intentionally different from aggregate reporting.
 * A proforma can be reused on many independent loadings and is a pricing/item
 * reference while a loading is live. It must not reject a scan because another
 * loading used the same item, or because this loading's actual mix differs from
 * the master proforma quantities.
 *
 * `global` remains available for reports/reservations that intentionally need
 * the aggregate historical picture.
 */
export type ProformaCapacityScope = "global" | "per_loading";
export type ProformaLoadingValidationMode = "global" | "reference" | "template";

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
  return snapshot.currentOrderId === null ? "template" : "reference";
}

function remainingTotalForScope(snapshot: ProformaCapacitySnapshot, scope: ProformaCapacityScope): number {
  if (scope === "global") return snapshot.remainingTotalQty;
  // Creation/template checks are independent of sibling loadings. A live order
  // is reference-only, so this value is informational and must never block it.
  return snapshot.articles
    .filter((article) => article.isOnProforma)
    .reduce((sum, article) => sum + Math.max(0, article.requestedQty - article.currentOrderLoadedQty), 0);
}

/**
 * Evaluate one proposed quantity increase. Live loading scans are reference-only
 * and therefore never fail proforma membership/quantity checks. Physical bale
 * duplicate, stock/location, order-status and other safety checks still run in
 * their normal routes.
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
  const consumedQty = article ? (scope === "global" ? article.totalConsumedQty : article.currentOrderLoadedQty) : 0;
  const requestedQty = article?.requestedQty ?? 0;

  if (validationMode === "reference") {
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

  if (!article?.isOnProforma) {
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
 * Creation-time guard. Empty loadings for an active proforma remain independent
 * from sibling loadings; only active/customer validity matters in normal use.
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
  if (scope === "global" && remainingTotalQty <= 0) {
    return { allowed: false, reason: "fully_consumed", remainingTotalQty: 0 };
  }
  return { allowed: true, reason: null, remainingTotalQty };
}

/**
 * Allocate source lines for recovery/reporting helpers. This is intentionally a
 * per-order view by default and never subtracts sibling loading consumption.
 */
export function allocateRemainingProformaLines<T extends { articleCode: unknown; quantity: unknown }>(
  lines: T[],
  snapshot: ProformaCapacitySnapshot,
  scope: ProformaCapacityScope = "per_loading"
): RemainingProformaLineAllocation<T>[] {
  const unallocatedConsumed = new Map(
    snapshot.articles
      .filter((article) => article.isOnProforma)
      .map(
        (article) =>
          [
            article.normalizedArticleCode,
            scope === "global" ? article.totalConsumedQty : article.currentOrderLoadedQty,
          ] as const
      )
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
