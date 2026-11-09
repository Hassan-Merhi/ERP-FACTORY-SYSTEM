/** 
 * Scan-only trip close policy. A truck needs physical scans to be completed;
 * no expected truck allocation is required. Missing bales are reconciled
 * against Pending Loading only after all trips finish.
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
  // Evidence that was scanned but is no longer in the loading is exceptional.
  if (s.unexpectedBales > 0) {
    issues.push({ code: "UNEXPECTED_SCANS", label: "Verified bales not in Pending Loading", count: s.unexpectedBales });
  }
  if (s.duplicateBales > 0) {
    issues.push({ code: "DUPLICATE_ACTIVE_SCANS", label: "Duplicate active verification anomalies", count: s.duplicateBales });
  }
  return {
    issues,
    hasAnyScans: s.verifiedBales > 0,
    needsApproval: issues.length > 0,
    canCloseClean: s.verifiedBales > 0 && issues.length === 0,
  };
}
