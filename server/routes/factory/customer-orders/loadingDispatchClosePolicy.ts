/**
 * Phase 6 pure close gate: discrepancies always require explicit supervisor
 * approval, and a trip without actual scanned bales may not be closed.
 */
import type { LoadingDispatchComparison } from "./loadingDispatchComparison";

export interface DispatchCloseIssue {
  code: string;
  label: string;
  count?: number;
}

export function assessFactoryLoadingDispatchClose(comparison: LoadingDispatchComparison) {
  const s = comparison.summary;
  const issues: DispatchCloseIssue[] = [];
  if (!comparison.hasTripPlan) {
    issues.push({ code: "NO_EXPECTED_PLAN", label: "No expected truck allocation has been saved" });
  }
  if (s.missingBales !== null && s.missingBales > 0) {
    issues.push({ code: "MISSING_BALES", label: "Missing expected bales", count: s.missingBales });
  }
  if (s.unexpectedBales > 0) {
    issues.push({ code: "UNEXPECTED_SCANS", label: "Unplanned or wrong-truck verified bales", count: s.unexpectedBales });
  }
  if (s.crossTripMisplacedBales > 0) {
    issues.push({ code: "CROSS_TRIP_MISMATCH", label: "Assigned here but verified on another truck", count: s.crossTripMisplacedBales });
  }
  if (s.duplicateBales > 0) {
    issues.push({ code: "DUPLICATE_ACTIVE_SCANS", label: "Duplicate active verification anomalies", count: s.duplicateBales });
  }
  if (s.expectedWeightKg !== null && s.weightDifferenceKg !== null && Math.abs(s.weightDifferenceKg) > 0.001) {
    issues.push({ code: "WEIGHT_MISMATCH", label: "Expected versus scanned KG differs" });
  }
  if (s.exactMissingBales > 0 && (s.missingBales ?? 0) === 0) {
    issues.push({
      code: "EXACT_MISSING_BALES",
      label: "Exact planned barcode references were not verified",
      count: s.exactMissingBales,
    });
  }
  return {
    issues,
    hasAnyScans: s.verifiedBales > 0,
    needsApproval: issues.length > 0,
    canCloseClean: s.verifiedBales > 0 && issues.length === 0,
  };
}
