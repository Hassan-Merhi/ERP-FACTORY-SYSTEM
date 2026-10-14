import Dexie, { type Table } from "dexie";

// ─── Schema Types ─────────────────────────────────────────────────────────────

export interface SyncQueueItem {
  id?: number;
  idempotencyKey: string;
  mode: "erp" | "pos" | "factory";
  entityType: string;
  operation: "create" | "update" | "delete";
  payload: string;
  url: string;
  method: string;
  companyId: number | null;
  locationId: number | null;
  tempId: string | null;
  createdAt: number;
  retryCount: number;
  nextRetryAt: number;
  status: "pending" | "syncing" | "failed" | "succeeded";
  lastError: string | null;
  description: string;
}

export interface SyncState {
  id?: number;
  key: string;
  lastSyncedAt: number | null;
  lastAttemptAt: number | null;
  status: "idle" | "syncing" | "error";
  errorMessage: string | null;
}

export interface SyncLog {
  id?: number;
  timestamp: number;
  type: "sync_start" | "sync_end" | "item_success" | "item_failed" | "online" | "offline" | "error";
  message: string;
  metadata: string | null;
}

export interface Conflict {
  id?: number;
  syncQueueItemId: number | null;
  entityType: string;
  operation: string;
  localPayload: string;
  serverResponse: string;
  conflictReason: string;
  url: string;
  method: string;
  createdAt: number;
  resolved: boolean;
  resolvedAt: number | null;
  resolution: "local" | "server" | null;
}

export interface LocalDraft {
  id?: number;
  entityType: string;
  mode: "erp" | "pos" | "factory";
  data: string;
  label: string;
  companyId: number | null;
  locationId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface OfflinePackage {
  id?: number;
  key: string;
  entityType: string;
  companyId: number;
  data: string;
  downloadedAt: number;
  expiresAt: number | null;
  version: number;
}

export interface CachedEntity {
  id: string | number;
  companyId: number;
  data: string;
  updatedAt: number;
  fetchedAt: number;
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
  }
}

export const db = new ERPDatabase();

// ─── Helper Functions ─────────────────────────────────────────────────────────

export async function addToSyncQueue(
  item: Omit<SyncQueueItem, "id" | "createdAt" | "retryCount" | "nextRetryAt" | "status" | "lastError">
): Promise<number> {
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
