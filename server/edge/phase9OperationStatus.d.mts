export type Phase9OperationState = "local-only" | "staged" | "cloud-applied" | "conflict";
export type Phase9OperationScope = {
  siteId: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
};
export class Phase9StatusRefusal extends Error {
  constructor(code: string);
}
export function validPhase9OperationScope(scope: Phase9OperationScope): boolean;
export function readPhase9OperationStatus(
  queryable: { query: (sql: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  scope: Phase9OperationScope
): Promise<{
  operationId: string;
  companyId: number;
  state: Phase9OperationState;
  evidence: "verified-local-cloud-receipt" | "lan-staging-receipt" | "receipt-mismatch" | "lan-outbox";
} | null>;
