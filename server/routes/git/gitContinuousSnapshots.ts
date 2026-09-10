import { randomUUID } from "node:crypto";
import {
  ContinuousCursorError,
  decodeContinuousCursor,
  encodeContinuousCursor,
} from "../../lib/continuousCursor";

const DEFAULT_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_SNAPSHOTS = 32;

type SnapshotCursor = {
  snapshotId: string;
  offset: number;
};

type Snapshot<T, TFacets, TSummary> = {
  id: string;
  scope: string;
  rows: T[];
  facets: TFacets;
  summary: TSummary;
  asOf: string;
  expiresAt: number;
};

export class GitContinuousSnapshotError extends Error {
  readonly code = "GIT_CONTINUOUS_SNAPSHOT_EXPIRED";
  readonly status = 409;

  constructor() {
    super("This continuous tracking snapshot expired. Restart the list from the first chunk.");
    this.name = "GitContinuousSnapshotError";
  }
}

const snapshots = new Map<string, Snapshot<unknown, unknown, unknown>>();

function finitePositiveConfig(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function prune(now = Date.now()): void {
  for (const [id, snapshot] of snapshots) {
    if (snapshot.expiresAt <= now) snapshots.delete(id);
  }
  const maxSnapshots = finitePositiveConfig("GIT_CONTINUOUS_MAX_SNAPSHOTS", DEFAULT_MAX_SNAPSHOTS);
  while (snapshots.size > maxSnapshots) {
    const oldest = snapshots.keys().next().value;
    if (typeof oldest !== "string") break;
    snapshots.delete(oldest);
  }
}

function isSnapshotCursor(value: unknown): value is SnapshotCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<SnapshotCursor>;
  return typeof cursor.snapshotId === "string" && cursor.snapshotId.length > 0 && Number.isInteger(cursor.offset) && Number(cursor.offset) >= 0;
}

function chunkFromSnapshot<T, TFacets, TSummary>(
  snapshot: Snapshot<T, TFacets, TSummary>,
  scope: string,
  offset: number,
  limit: number
) {
  const rows = snapshot.rows.slice(offset, offset + limit);
  const nextOffset = offset + rows.length;
  const hasMore = nextOffset < snapshot.rows.length;
  return {
    containers: rows,
    total: snapshot.rows.length,
    facets: snapshot.facets,
    summary: snapshot.summary,
    asOf: snapshot.asOf,
    hasMore,
    nextCursor: hasMore
      ? encodeContinuousCursor(scope, { snapshotId: snapshot.id, offset: nextOffset } satisfies SnapshotCursor)
      : null,
  };
}

export function createGitContinuousSnapshot<T, TFacets, TSummary>(input: {
  scope: string;
  rows: T[];
  facets: TFacets;
  summary: TSummary;
  asOf: string;
  limit: number;
}) {
  prune();
  const ttlMs = finitePositiveConfig("GIT_CONTINUOUS_SNAPSHOT_TTL_MS", DEFAULT_TTL_MS);
  const snapshot: Snapshot<T, TFacets, TSummary> = {
    id: randomUUID(),
    scope: input.scope,
    rows: input.rows,
    facets: input.facets,
    summary: input.summary,
    asOf: input.asOf,
    expiresAt: Date.now() + ttlMs,
  };
  if (snapshot.rows.length > input.limit) {
    snapshots.set(snapshot.id, snapshot as Snapshot<unknown, unknown, unknown>);
    prune();
  }
  return chunkFromSnapshot(snapshot, input.scope, 0, input.limit);
}

export function readGitContinuousSnapshot<T, TFacets, TSummary>(input: {
  scope: string;
  cursor: string;
  limit: number;
}) {
  prune();
  let decoded: unknown;
  try {
    decoded = decodeContinuousCursor<unknown>(input.scope, input.cursor);
  } catch (error) {
    if (error instanceof ContinuousCursorError) throw error;
    throw new GitContinuousSnapshotError();
  }
  if (!isSnapshotCursor(decoded)) throw new ContinuousCursorError();
  const snapshot = snapshots.get(decoded.snapshotId) as Snapshot<T, TFacets, TSummary> | undefined;
  if (!snapshot || snapshot.scope !== input.scope || snapshot.expiresAt <= Date.now()) {
    if (snapshot) snapshots.delete(snapshot.id);
    throw new GitContinuousSnapshotError();
  }
  return chunkFromSnapshot(snapshot, input.scope, decoded.offset, input.limit);
}

export function resetGitContinuousSnapshotsForTests(): void {
  snapshots.clear();
}
