// Extracted from ./historicalReplayPhase8ReadinessRoutes.ts

export const APPLY_PATH = "/api/factory/raw-stock/recalc/historical-replay/apply";

export const READINESS_PATH = "/api/factory/raw-stock/recalc/historical-replay/readiness";

export const ADMIN_ROLES = ["Admin", "Developer"] as const;

export const APPLY_AUTHORIZATION_KIND = "HISTORICAL_REPLAY_V8_APPLY_AUTHORIZATION" as const;

export interface HistoricalReplayApplyAuthorizationPayload {
  kind: typeof APPLY_AUTHORIZATION_KIND;
  companyId: number;
  userId: string;
  releaseId: string;
  algorithmVersion: string;
  readinessVersion: string;
  confirmationTokenHash: string;
  issuedAt: number;
  expiresAt: number;
}

export interface LatestReplayRow {
  id: number;
  algorithm_version: string | null;
  scope_fingerprint: string | null;
  applied_at: Date | string;
  undone_at: Date | string | null;
}

export function positiveIntegerIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => Number(item));
  if (ids.some((item) => !Number.isInteger(item) || item <= 0)) return [];
  return [...new Set(ids)].sort((left, right) => left - right);
}
