import type { OfflineOperation } from "./operationContract";

/** Browser state never upgrades a LAN-posted voucher to cloud-applied by itself. */
export type Phase9VisibleState = "local-only" | "staged" | "cloud-applied" | "conflict" | "blocked";

export interface Phase9Evidence {
  operationId: string;
  companyId: number;
  state: "local-only" | "staged" | "cloud-applied" | "conflict";
  evidence: "lan-outbox" | "lan-staging-receipt" | "verified-local-cloud-receipt" | "receipt-mismatch";
}

const VALID_PROOF: Record<Phase9Evidence["state"], Phase9Evidence["evidence"]> = {
  "local-only": "lan-outbox",
  staged: "lan-staging-receipt",
  "cloud-applied": "verified-local-cloud-receipt",
  conflict: "receipt-mismatch",
};

/** An HTTP acknowledgement is NOT an independently verified cloud receipt. */
export function visiblePhase9Status(
  operation: Pick<OfflineOperation, "id" | "companyId" | "state">,
  proof?: unknown
): Phase9VisibleState {
  if (operation.state === "conflict" || operation.state === "needs_review") return "conflict";
  if (operation.state === "rejected") return "blocked";
  if (operation.state !== "acknowledged" || !proof || typeof proof !== "object") return "local-only";
  const candidate = proof as Partial<Phase9Evidence>;
  if (
    candidate.operationId !== operation.id ||
    candidate.companyId !== operation.companyId ||
    !candidate.state ||
    !Object.hasOwn(VALID_PROOF, candidate.state) ||
    VALID_PROOF[candidate.state as Phase9Evidence["state"]] !== candidate.evidence
  ) return "local-only";
  return candidate.state;
}

export const PHASE9_STATE_LABELS: Record<Phase9VisibleState, string> = {
  "local-only": "Local only · cloud apply unverified",
  staged: "Staged · NOT cloud-applied",
  "cloud-applied": "Cloud-applied · verified receipt",
  conflict: "Conflict · operator review required",
  blocked: "Blocked · operation not completed",
};
