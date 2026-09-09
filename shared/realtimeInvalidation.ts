export const REALTIME_INVALIDATION_TOPICS = [
  "inventory",
  "pos",
  "accounting",
  "factory",
  "payroll",
  "containers",
  "reference",
  "communications",
] as const;

export type RealtimeInvalidationTopic = (typeof REALTIME_INVALIDATION_TOPICS)[number];

export interface RealtimeInvalidationMessage {
  type: "invalidate";
  /** Missing topics means safe legacy blanket invalidation. */
  topics?: RealtimeInvalidationTopic[];
  /** Optional location scope. Queries with an explicit different location can stay warm. */
  locationIds?: number[];
}

export interface RealtimeWriteInvalidation {
  topics?: RealtimeInvalidationTopic[];
  locationIds?: number[];
}

const TOPIC_SET = new Set<string>(REALTIME_INVALIDATION_TOPICS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniquePositiveIntegers(values: unknown[]): number[] | undefined {
  const ids = new Set<number>();
  for (const value of values) {
    const id = positiveInteger(value);
    if (id !== null) ids.add(id);
  }
  return ids.size > 0 ? [...ids] : undefined;
}

function uniqueTopics(values: unknown[]): RealtimeInvalidationTopic[] | undefined {
  const topics = new Set<RealtimeInvalidationTopic>();
  for (const value of values) {
    if (typeof value === "string" && TOPIC_SET.has(value)) topics.add(value as RealtimeInvalidationTopic);
  }
  return topics.size > 0 ? [...topics] : undefined;
}

export function parseRealtimeInvalidationMessage(value: unknown): RealtimeInvalidationMessage | null {
  if (!isRecord(value) || value.type !== "invalidate") return null;

  const topics = Array.isArray(value.topics) ? uniqueTopics(value.topics) : undefined;
  const locationIds = Array.isArray(value.locationIds) ? uniquePositiveIntegers(value.locationIds) : undefined;

  return {
    type: "invalidate",
    ...(topics ? { topics } : {}),
    ...(locationIds ? { locationIds } : {}),
  };
}

function requestPath(value: string): string {
  const queryIndex = value.indexOf("?");
  return queryIndex >= 0 ? value.slice(0, queryIndex) : value;
}

function startsWithAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function locationIdsFromWrite(path: string, body: unknown): number[] | undefined {
  const candidates: unknown[] = [];
  const locationMatch = path.match(/^\/api\/locations\/(\d+)(?:\/|$)/);
  if (locationMatch) candidates.push(locationMatch[1]);

  if (isRecord(body)) {
    candidates.push(
      body.locationId,
      body.location_id,
      body.fromLocationId,
      body.toLocationId,
      body.sourceLocationId,
      body.destinationLocationId
    );
  }

  return uniquePositiveIntegers(candidates);
}

/**
 * Classify a successful API write into the smallest safe realtime topic set.
 * Unknown paths intentionally return no topics, which keeps the legacy blanket
 * invalidation fallback instead of risking stale data.
 */
export function classifyRealtimeWrite(url: string, body: unknown): RealtimeWriteInvalidation {
  const path = requestPath(url);
  const locationIds = locationIdsFromWrite(path, body);
  let topics: RealtimeInvalidationTopic[] | undefined;

  if (startsWithAny(path, ["/api/pos", "/api/sales"])) {
    topics = ["pos", "inventory", "accounting"];
  } else if (startsWithAny(path, ["/api/stock-transfers", "/api/stock-transfer"])) {
    topics = ["inventory", "accounting"];
  } else if (
    startsWithAny(path, [
      "/api/suppliers",
      "/api/customers",
      "/api/employees",
      "/api/stock-groups",
      "/api/stock-categories",
      "/api/stock-grades",
      "/api/company-settings",
      "/api/user/preferences",
    ])
  ) {
    topics = ["reference"];
  } else if (startsWithAny(path, ["/api/inventory", "/api/locations", "/api/stock", "/api/bales"])) {
    topics = ["inventory"];
  } else if (
    startsWithAny(path, [
      "/api/vouchers",
      "/api/voucher-entries",
      "/api/accounts",
      "/api/ledger",
      "/api/fiscal-transfers",
      "/api/global-transactions",
      "/api/credit-notes",
      "/api/golden-coast",
    ])
  ) {
    topics = ["accounting"];
  } else if (path.startsWith("/api/factory/daybook")) {
    topics = ["factory", "accounting"];
  } else if (startsWithAny(path, ["/api/factory/payroll", "/api/factory-payroll"])) {
    topics = ["factory", "payroll", "accounting"];
  } else if (path.startsWith("/api/factory")) {
    topics = ["factory"];
  } else if (startsWithAny(path, ["/api/containers", "/api/import", "/api/sp"])) {
    topics = ["containers", "inventory", "accounting"];
  } else if (
    startsWithAny(path, [
      "/api/notifications",
      "/api/intercompany-notifications",
      "/api/business-alerts",
      "/api/chat",
      "/api/user-notes",
      "/api/presence",
    ])
  ) {
    topics = ["communications"];
  }

  return {
    ...(topics ? { topics } : {}),
    ...(locationIds ? { locationIds } : {}),
  };
}
