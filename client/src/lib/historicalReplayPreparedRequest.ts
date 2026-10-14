export const HISTORICAL_REPLAY_APPLY_PATH = "/api/factory/raw-stock/recalc/historical-replay/apply";

export interface FrozenHistoricalReplayOptions {
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
}

interface FrozenHistoricalReplayRequestState {
  supplierIds: number[];
  options: FrozenHistoricalReplayOptions;
  algorithmVersion: string;
  fingerprint?: string;
  applyAuthorizationToken?: string;
  productionReleaseId?: string;
}

const preparedByToken = new Map<string, FrozenHistoricalReplayRequestState>();

function normalizeIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((entry) => Number(entry));
  if (ids.some((entry) => !Number.isInteger(entry) || entry <= 0)) return null;
  return [...new Set(ids)].sort((left, right) => left - right);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function isHistoricalReplayApplyEndpoint(method: string, url: string): boolean {
  return method.toUpperCase() === "POST" && url === HISTORICAL_REPLAY_APPLY_PATH;
}

export function historicalReplayTokenFromRequest(
  method: string,
  url: string,
  data: unknown
): string | null {
  if (!isHistoricalReplayApplyEndpoint(method, url)) return null;
  const record = asRecord(data);
  const token = record?.confirmationToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function isHistoricalReplayPrepareRequest(
  method: string,
  url: string,
  data: unknown
): boolean {
  if (!isHistoricalReplayApplyEndpoint(method, url)) return false;
  const record = asRecord(data);
  return record?.dryRun === true && historicalReplayTokenFromRequest(method, url, data) == null;
}

/** Store only server-returned, signed preparation state. */
export function rememberHistoricalReplayPreparation(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  const token = record.confirmationToken;
  const supplierIds = normalizeIds(record.safeSupplierIds);
  const frozenOptions = asRecord(record.frozenOptions);
  const algorithmVersion = record.algorithmVersion;
  if (
    typeof token !== "string"
    || token.length === 0
    || !supplierIds
    || supplierIds.length === 0
    || !frozenOptions
    || typeof frozenOptions.includeCompletedBatches !== "boolean"
    || typeof frozenOptions.includeFinalizedBales !== "boolean"
    || typeof algorithmVersion !== "string"
    || algorithmVersion.length === 0
  ) {
    return false;
  }

  const rawAuthorizationToken = record.applyAuthorizationToken;
  const rawReleaseId = record.productionReleaseId;
  const hasCompleteProductionAuthorization =
    typeof rawAuthorizationToken === "string"
    && rawAuthorizationToken.length > 0
    && typeof rawReleaseId === "string"
    && rawReleaseId.length > 0;

  preparedByToken.set(token, {
    supplierIds,
    options: {
      includeCompletedBatches: frozenOptions.includeCompletedBatches,
      includeFinalizedBales: frozenOptions.includeFinalizedBales,
    },
    algorithmVersion,
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : undefined,
    applyAuthorizationToken: hasCompleteProductionAuthorization ? rawAuthorizationToken : undefined,
    productionReleaseId: hasCompleteProductionAuthorization ? rawReleaseId : undefined,
  });
  return true;
}

/**
 * Apply requests never trust live checkbox/selection state. When a prepared token
 * is known, the outbound request is rebuilt entirely from the server-returned
 * frozen state. V8 production authorization is also frozen and remains bound to
 * that exact prepared token. When the cache is missing, only explicitly supplied
 * signed tokens are preserved; a page reload therefore fails closed unless the
 * caller retained both V8 authorization fields.
 */
export function freezeHistoricalReplayApplyRequest(
  method: string,
  url: string,
  data: unknown
): unknown {
  const token = historicalReplayTokenFromRequest(method, url, data);
  if (!token) return data;
  const frozen = preparedByToken.get(token);
  if (!frozen) {
    const record = asRecord(data);
    const applyAuthorizationToken = record?.applyAuthorizationToken;
    const productionReleaseId = record?.productionReleaseId;
    return {
      dryRun: false,
      confirmationToken: token,
      ...(typeof applyAuthorizationToken === "string" && applyAuthorizationToken.length > 0
        ? { applyAuthorizationToken }
        : {}),
      ...(typeof productionReleaseId === "string" && productionReleaseId.length > 0
        ? { productionReleaseId }
        : {}),
    };
  }
  return {
    dryRun: false,
    confirmationToken: token,
    supplierIds: [...frozen.supplierIds],
    includeCompletedBatches: frozen.options.includeCompletedBatches,
    includeFinalizedBales: frozen.options.includeFinalizedBales,
    algorithmVersion: frozen.algorithmVersion,
    fingerprint: frozen.fingerprint,
    ...(frozen.applyAuthorizationToken
      ? { applyAuthorizationToken: frozen.applyAuthorizationToken }
      : {}),
    ...(frozen.productionReleaseId
      ? { productionReleaseId: frozen.productionReleaseId }
      : {}),
  };
}

export function forgetHistoricalReplayPreparation(token: string | null | undefined): void {
  if (token) preparedByToken.delete(token);
}

/** Test/support helper; never called by the replay UI. */
export function clearHistoricalReplayPreparations(): void {
  preparedByToken.clear();
}
