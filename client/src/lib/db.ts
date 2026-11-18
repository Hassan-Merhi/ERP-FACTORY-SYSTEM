import Dexie, { type Table } from "dexie";
import { OFFLINE_MODE_ENABLED } from "./featureFlags";
import type { OfflineOperation } from "./offline/operationContract";
import { offlineError } from "@/lib/offline/offlineError";
import type {
  BrowserOperationRecord,
  CachedEntity,
  Conflict,
  LocalDraft,
  OfflineColdStartTicket,
  OfflinePackage,
  OfflineReadGrant,
  SyncLog,
  SyncQueueItem,
  SyncState,
} from "./dbTypes";
export type {
  BrowserOperationRecord,
  BrowserOperationState,
  CachedEntity,
  Conflict,
  LocalDraft,
  OfflineColdStartTicket,
  OfflinePackage,
  OfflineReadGrant,
  SyncLog,
  SyncQueueItem,
  SyncState,
} from "./dbTypes";

export interface OfflineReadSnapshot {
  key: string;
  userId: string;
  companyId: number;
  url: string;
  body: string;
  cachedAt: number;
  expiresAt: number;
}

/** Plan batch 5: an entry moved out of an old browser queue, sealed at rest; never sent automatically. */
export interface LegacyRecoveryEntry {
  id: string;
  source: "localStorage" | "indexedDb";
  companyId: number | null;
  kind: string;
  recordedAt: number;
  amount: string | null;
  sealed: string;
  migratedAt: number;
  expiresAt: number;
  state: "pending" | "discarded" | "re-entered";
}

export interface BrowserDeviceKey {
  /** `${companyId}:${userId}` */
  id: string;
  key: CryptoKey;
  deviceId: string;
  /** Next local reference to hand out on this device. */
  nextLocalRef: number;
}

export interface LegacyRecoveryKey {
  id: string;
  key: CryptoKey;
}

export interface OfflineMeta {
  id?: number;
  key: string;
  preparedAt: number | null;
  status: "ready" | "partial" | "not_ready";
  totalDatasets: number;
  completedDatasets: number;
  errors: string;
  packSummary: string;
}

export interface PooledRef {
  id?: number;
  referenceNumber: string;
  status: "available" | "used";
  allocatedAt: number;
  usedAt: number | null;
}

export interface BulkFxSupplierEntry {
  id: number;
  name: string;
  available: number;
  oldestDate: string | null;
  newestDate: string | null;
}

export interface BulkFxCacheEntry {
  brokerId: number;
  currency: string;
  suppliers: BulkFxSupplierEntry[];
  cachedAt: number;
}

// ─── Dexie Database ───────────────────────────────────────────────────────────

class ERPDatabase extends Dexie {
  syncQueue!: Table<SyncQueueItem, number>;
  offlineOperations!: Table<OfflineOperation, string>;
  offlineReadSnapshots!: Table<OfflineReadSnapshot, string>;
  offlineReadGrants!: Table<OfflineReadGrant, string>;
  offlineColdStartTickets!: Table<OfflineColdStartTicket, string>;
  legacyRecoveryEntries!: Table<LegacyRecoveryEntry, string>;
  legacyRecoveryKeys!: Table<LegacyRecoveryKey, string>;
  browserOperations!: Table<BrowserOperationRecord, string>;
  browserDeviceKeys!: Table<BrowserDeviceKey, string>;
  syncState!: Table<SyncState, number>;
  syncLogs!: Table<SyncLog, number>;
  conflicts!: Table<Conflict, number>;
  localDrafts!: Table<LocalDraft, number>;
  offlinePackages!: Table<OfflinePackage, number>;
  users!: Table<CachedEntity, string | number>;
  companies!: Table<CachedEntity, string | number>;
  companySettings!: Table<CachedEntity, string | number>;
  permissions!: Table<CachedEntity, string | number>;
  locations!: Table<CachedEntity, string | number>;
  ledgerAccounts!: Table<CachedEntity, string | number>;
  bankAccounts!: Table<CachedEntity, string | number>;
  suppliers!: Table<CachedEntity, string | number>;
  customers!: Table<CachedEntity, string | number>;
  employees!: Table<CachedEntity, string | number>;
  fixedAssets!: Table<CachedEntity, string | number>;
  stockItems!: Table<CachedEntity, string | number>;
  inventoryByLocation!: Table<CachedEntity, string | number>;
  // Factory offline tables
  factorySuppliers!: Table<CachedEntity, string | number>;
  factoryCategories!: Table<CachedEntity, string | number>;
  factoryBaleProducts!: Table<CachedEntity, string | number>;
  factoryContainers!: Table<CachedEntity, string | number>;
  factoryRawStock!: Table<CachedEntity, string | number>;
  // Offline prep metadata
  offlineMeta!: Table<OfflineMeta, number>;
  // Pre-allocated label reference number pool
  refPool!: Table<PooledRef, number>;
  // Bulk FX offline preview cache
  bulkFxCache!: Table<BulkFxCacheEntry, [number, string]>;

  constructor() {
    super("ERPDatabase");

    // v1 — original schema
    this.version(1).stores({
      syncQueue: "++id, idempotencyKey, mode, entityType, status, createdAt",
      syncState: "++id, &key",
      syncLogs: "++id, timestamp, type",
      conflicts: "++id, syncQueueItemId, entityType, resolved",
      localDrafts: "++id, entityType, mode, companyId, createdAt",
      offlinePackages: "++id, &key, entityType, companyId",
      users: "id, companyId, fetchedAt",
      companies: "id, companyId, fetchedAt",
      companySettings: "id, companyId, fetchedAt",
      permissions: "id, companyId, fetchedAt",
      locations: "id, companyId, fetchedAt",
      ledgerAccounts: "id, companyId, fetchedAt",
      bankAccounts: "id, companyId, fetchedAt",
      suppliers: "id, companyId, fetchedAt",
      customers: "id, companyId, fetchedAt",
      employees: "id, companyId, fetchedAt",
      fixedAssets: "id, companyId, fetchedAt",
      stockItems: "id, companyId, fetchedAt",
      inventoryByLocation: "id, companyId, fetchedAt",
    });

    // v2 — add nextRetryAt index to syncQueue; richer Conflict schema
    this.version(2)
      .stores({
        syncQueue: "++id, idempotencyKey, mode, entityType, status, createdAt, nextRetryAt",
        conflicts: "++id, syncQueueItemId, entityType, resolved, createdAt",
      })
      .upgrade((tx) =>
        tx
          .table("syncQueue")
          .toCollection()
          .modify((item) => {
            if (item.nextRetryAt === undefined) item.nextRetryAt = 0;
          })
      );

    // v3 — add url/method fields to conflicts for retry capability
    this.version(3).upgrade((tx) =>
      tx
        .table("conflicts")
        .toCollection()
        .modify((c) => {
          if (c.url === undefined) c.url = "";
          if (c.method === undefined) c.method = "POST";
          if (c.localPayload === undefined && c.payload !== undefined) {
            c.localPayload = c.payload;
          }
          if (c.conflictReason === undefined) c.conflictReason = c.serverResponse || "";
        })
    );

    // v4 — factory offline tables + offline preparation metadata
    this.version(4).stores({
      factorySuppliers: "id, companyId, fetchedAt",
      factoryCategories: "id, companyId, fetchedAt",
      factoryBaleProducts: "id, companyId, fetchedAt",
      factoryContainers: "id, companyId, fetchedAt",
      factoryRawStock: "id, companyId, fetchedAt",
      offlineMeta: "++id, &key",
    });

    // v5 — pre-allocated label reference number pool for offline printing
    this.version(5).stores({
      refPool: "++id, referenceNumber, status, allocatedAt",
    });

    // v6 — bulk FX offline preview cache keyed by [brokerId, currency]
    this.version(6).stores({
      bulkFxCache: "[brokerId+currency], cachedAt",
    });

    // v7 — durable operation outbox. Legacy queues are preserved, never auto-migrated.
    this.version(7).stores({
      offlineOperations: "&id, companyId, state, [companyId+userId+state], [state+nextAttemptAt], createdAt",
    });

    // v8 — independently scoped offline GET response snapshots and readiness.
    this.version(8).stores({
      offlineReadSnapshots: "&key, [companyId+userId], url, expiresAt",
      offlineReadGrants: "&key, [companyId+userId], expiresAt",
    });

    // Plan batch 5 (decision 10): sealed cold-start tickets for read-only laptops.
    this.version(9).stores({
      offlineColdStartTickets: "&key, [companyId+userId], verifiedAt, expiresAt",
    });

    // Plan batch 5: old queue entries moved into an encrypted store for supervised re-entry or discard.
    this.version(10).stores({
      legacyRecoveryEntries: "&id, companyId, state, expiresAt",
      legacyRecoveryKeys: "&id",
    });
    // Standalone browser offline mode: operations saved on this laptop, and the
    // per-user device key that seals them.
    this.version(11).stores({
      browserOperations: "&id, [companyId+userId], state, createdAt",
      browserDeviceKeys: "&id",
    });
  }
}

export const db = new ERPDatabase();

// ─── Helper Functions ─────────────────────────────────────────────────────────

export async function addToSyncQueue(
  item: Omit<SyncQueueItem, "id" | "createdAt" | "retryCount" | "nextRetryAt" | "status" | "lastError">
): Promise<number> {
  // Legacy rows have no verified per-user identity or universal exactly-once
  // handling. Never create additional legacy rows under the new offline mode.
  if (OFFLINE_MODE_ENABLED) throw offlineError("OFFLINE_LEGACY_IDB_QUEUE_BLOCKED");
  const id = await db.syncQueue.add({
    ...item,
    createdAt: Date.now(),
    retryCount: 0,
    nextRetryAt: 0,
    status: "pending",
    lastError: null,
  });
  return id as number;
}

export async function getSyncQueueCount(): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    db.syncQueue.where("status").equals("pending").count(),
    db.syncQueue.where("status").equals("failed").count(),
  ]);
  return { pending, failed };
}

export async function getConflictCount(): Promise<number> {
  try {
    return await db.conflicts.where("resolved").equals(0).count();
  } catch {
    return 0;
  }
}

export async function getUnresolvedConflicts(): Promise<Conflict[]> {
  return db.conflicts.where("resolved").equals(0).reverse().sortBy("createdAt");
}

export async function resolveConflict(id: number, resolution: "local" | "server"): Promise<void> {
  await db.conflicts.update(id, {
    resolved: true,
    resolvedAt: Date.now(),
    resolution,
  });
}

export async function addConflict(
  conflict: Omit<Conflict, "id" | "createdAt" | "resolved" | "resolvedAt" | "resolution">
): Promise<void> {
  await db.conflicts.add({
    ...conflict,
    url: conflict.url || "",
    method: conflict.method || "POST",
    createdAt: Date.now(),
    resolved: false,
    resolvedAt: null,
    resolution: null,
  });
}

export async function getGlobalSyncState(): Promise<SyncState | null> {
  const state = await db.syncState.where("key").equals("global").first();
  return state ?? null;
}

export async function upsertGlobalSyncState(updates: Partial<Omit<SyncState, "id" | "key">>): Promise<void> {
  const existing = await db.syncState.where("key").equals("global").first();
  if (existing?.id !== undefined) {
    await db.syncState.update(existing.id, updates);
  } else {
    await db.syncState.add({
      key: "global",
      lastSyncedAt: null,
      lastAttemptAt: null,
      status: "idle",
      errorMessage: null,
      ...updates,
    });
  }
}

// Prune check runs every N writes instead of every write.
// A full count() scan on every log write blocks the IDB thread on Android
// WebView; throttling to 1-in-25 reduces that pressure ~25× at the cost of
// letting the table grow to at most ~524 rows before the next prune.
let _syncLogWriteCount = 0;
const SYNC_LOG_PRUNE_EVERY = 25;

export async function appendSyncLog(type: SyncLog["type"], message: string, metadata?: object): Promise<void> {
  try {
    await db.syncLogs.add({
      timestamp: Date.now(),
      type,
      message,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
    _syncLogWriteCount++;
    if (_syncLogWriteCount % SYNC_LOG_PRUNE_EVERY === 0) {
      const count = await db.syncLogs.count();
      if (count > 500) {
        const oldest = await db.syncLogs
          .orderBy("timestamp")
          .limit(count - 500)
          .primaryKeys();
        await db.syncLogs.bulkDelete(oldest as number[]);
      }
    }
  } catch {
    // Logs are best-effort; never throw
  }
}
