export type VerificationSeverity = "PASS" | "WARN" | "FAIL";

export type VerificationIssue = {
  code: string;
  message: string;
  count?: number;
  detail?: unknown;
};

export function classifyFinalVerification(
  blockers: VerificationIssue[],
  deltas: VerificationIssue[]
): VerificationSeverity {
  if (blockers.length > 0) return "FAIL";
  if (deltas.length > 0) return "WARN";
  return "PASS";
}

export function exactCutoverConfirmation(
  suppliedConfirmation: unknown,
  expectedConfirmation: string,
  suppliedCompanyName: unknown,
  expectedCompanyName: string
): string | null {
  if (suppliedConfirmation !== expectedConfirmation) {
    return `Requires confirmation = "${expectedConfirmation}"`;
  }
  if (typeof suppliedCompanyName !== "string" || suppliedCompanyName.trim() !== expectedCompanyName) {
    return `Company name confirmation must match exactly: "${expectedCompanyName}"`;
  }
  return null;
}

export function exactInventoryValue(
  quantity: unknown,
  averageRate: unknown,
  storedTotalValue: unknown
): number {
  const parsedStored = Number.parseFloat(String(storedTotalValue ?? ""));
  if (Number.isFinite(parsedStored)) return parsedStored;
  const parsedQuantity = Number.parseFloat(String(quantity ?? "0"));
  const parsedRate = Number.parseFloat(String(averageRate ?? "0"));
  const safeQuantity = Number.isFinite(parsedQuantity) ? parsedQuantity : 0;
  const safeRate = Number.isFinite(parsedRate) ? parsedRate : 0;
  return Math.round(safeQuantity * safeRate * 10000) / 10000;
}

export function numbersDiffer(left: unknown, right: unknown, tolerance: number): boolean {
  const a = Number.parseFloat(String(left ?? "0"));
  const b = Number.parseFloat(String(right ?? "0"));
  const safeA = Number.isFinite(a) ? a : 0;
  const safeB = Number.isFinite(b) ? b : 0;
  return Math.abs(safeA - safeB) > tolerance;
}

export function latestCutoverBlocksCompany(params: {
  companyId: number;
  sourceCompanyId: number;
  targetCompanyId: number;
  status: string;
  targetWriteHold?: boolean | null;
}): { blocked: boolean; code?: string } {
  const isSource = params.companyId === params.sourceCompanyId;
  const isTarget = params.companyId === params.targetCompanyId;
  if (isSource && ["prepared", "active"].includes(params.status)) {
    return { blocked: true, code: "SP_SOURCE_READ_ONLY" };
  }
  if (isTarget && params.status === "prepared") {
    return { blocked: true, code: "SP_TARGET_CUTOVER_LOCKED" };
  }
  if (isTarget && params.targetWriteHold === true && ["rolled_back", "cancelled", "failed"].includes(params.status)) {
    return { blocked: true, code: "SP_TARGET_POST_ROLLBACK_HOLD" };
  }
  return { blocked: false };
}
