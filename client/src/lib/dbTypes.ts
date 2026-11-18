// Extracted from ./db.ts to keep that module under the source-size cap.

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

export interface OfflineReadGrant {
  key: string;
  userId: string;
  companyId: number;
  status: "ready" | "partial" | "not_ready";
  preparedAt: number;
  expiresAt: number;
  completed: number;
  total: number;
  errors: string;
  packSummary?: string;
  /** Phase 5 opt-in encryption. Absent on legacy Phase 2 snapshots. */
  protection?: "erp-offline-aes-gcm-v1";
  vaultSalt?: string;
  vaultCheck?: string;
}

/**
 * Plan batch 5 (decision 10): a cold-start ticket for a laptop that reaches
 * neither the cloud nor the factory server. Sealed with the passphrase-derived
 * vault key; userId, companyId, verifiedAt and expiresAt are bound into the
 * AES-GCM authentication, so they cannot be edited on disk.
 */
export interface OfflineColdStartTicket {
  key: string;
  userId: string;
  companyId: number;
  verifiedAt: number;
  expiresAt: number;
  vaultSalt: string;
  sealed: string;
}

/** The browser's non-extractable key for LegacyRecoveryEntry.sealed. */
/**
 * Standalone browser offline mode (Phases 13–16): one business operation the
 * person saved on this laptop while offline. The entered values are sealed
 * with this user's non-extractable device key; only a short label and the
 * delivery state are readable.
 */
export type BrowserOperationState =
  "saved" | "pending" | "sending" | "synced" | "waiting" | "conflict" | "rejected" | "needs_review" | "discarded";

export interface BrowserOperationRecord {
  /** The operation id: the cloud's idempotency key. */
  id: string;
  companyId: number;
  userId: string;
  deviceId: string;
  kind: string;
  stream: string;
  /** Local id from 1,000,000,000 that names the record before the cloud has it. */
  localRef: number;
  capturedAt: string;
  /** Short label for lists: what it is and its amount, never notes or parties. */
  label: string;
  /** SHA-256 of the entered values: spots a double click without decrypting. */
  inputHash: string;
  sealed: string;
  iv: string;
  state: BrowserOperationState;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  conflictCode: string | null;
  conflictOverridable: boolean;
  /** A conflict code an Admin/Developer approved; sent with the next attempt. */
  overrideCode: string | null;
  cloudRef: number | null;
  outcome: string | null;
  createdAt: number;
  updatedAt: number;
  syncedAt: number | null;
}
