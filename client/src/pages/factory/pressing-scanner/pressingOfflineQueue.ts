/**
 * Pressing-machine-specific durable queue. No generic ERP offline-queue records.
 * A record is persisted BEFORE HTTP, and its idempotency key/payload never change.
 * History is partitioned by authenticated company and user.
 */
export type PressingQueueState = "pending" | "syncing" | "confirmed" | "rejected";

export interface PressingActor {
  companyId: number;
  userId: string;
}
export interface PressingPayload {
  barcode: string;
  assignmentId: number;
  machineId: number;
  deviceCapturedAt: string;
  requestId: string;
}
export interface PressingServerReceipt {
  id: number;
  status: "PRESSING_COMPLETED";
  referenceNumber: string;
  weightKg: string;
  machineName: string;
  confirmedAt: string;
  productionDate: string;
  timezoneName: string;
  replayed: boolean;
  inventoryFinalized: false;
  machineId: number;
  assignmentId: number;
  requestId: string;
  operatorUserId: string;
}
export interface PressingPreviousScan {
  operatorName?: string;
  operatorUserId?: string;
  confirmedAt?: string;
  referenceNumber?: string;
}

export interface PressingQueuedScan extends PressingActor {
  requestId: string;
  payload: PressingPayload;
  barcode: string;
  state: PressingQueueState;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  errorCode?: string;
  previousScan?: PressingPreviousScan;
  receipt?: PressingServerReceipt;
}

const DB_NAME = "erp-factory-pressing-queue";
const STORE = "scans";
const DB_VERSION = 1;
export const PRESSING_MAX_UNRESOLVED = 500;

export class PressingOfflineStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PressingOfflineStorageError";
  }
}

let openPromise: Promise<IDBDatabase> | null = null;
export function openPressingQueue(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new PressingOfflineStorageError(
      "Offline scan storage is unavailable. No scan was submitted; enable browser storage and retry."
    ));
  }
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "requestId" });
        store.createIndex("actor", ["companyId", "userId"], { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); openPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("Cannot open pressing queue"));
    request.onblocked = () => reject(new Error("Pressing queue upgrade blocked by another tab"));
  }).catch(error => {
    openPromise = null;
    throw new PressingOfflineStorageError(
      "Cannot access saved pressing scans. No scan was submitted. " +
      (error instanceof Error ? error.message : "Browser storage failed")
    );
  });
  return openPromise;
}
export async function listPressingScans(actor: PressingActor): Promise<PressingQueuedScan[]> {
  const db = await openPressingQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("actor").getAll(
      IDBKeyRange.only([actor.companyId, actor.userId])
    );
    req.onerror = () => reject(req.error || new Error("Could not load saved pressing scans"));
    req.onsuccess = () => {
      const rows = (req.result as PressingQueuedScan[])
        .sort((a,b) => a.createdAt.localeCompare(b.createdAt));
      resolve(rows);
    };
  });
}

export async function savePressingScan(record: PressingQueuedScan): Promise<void> {
  const db = await openPressingQueue();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to save pressing scan"));
    tx.onabort = () => reject(tx.error || new Error("Pressing scan save was aborted"));
  });
}

export async function enqueuePressingScan(
  actor: PressingActor, payload: PressingPayload
): Promise<{ record: PressingQueuedScan; existing: boolean }> {
  const barcode = payload.barcode.trim().toUpperCase();
  // This check is a convenience, not the concurrency boundary; the PostgreSQL
  // partial unique company+bale constraint is authoritative across devices.
  const rows = await listPressingScans(actor);
  const duplicate = rows.find(r => r.barcode === barcode &&
    (r.state === "pending" || r.state === "syncing"));
  if (duplicate) return { record: duplicate, existing: true };
  const unresolved = rows.filter(r => r.state === "pending" || r.state === "syncing");
  if (unresolved.length >= PRESSING_MAX_UNRESOLVED) {
    throw new PressingOfflineStorageError(
      "Offline pressing queue is full. Reconnect and sync pending scans before adding more."
    );
  }
  const now = new Date().toISOString();
  const record: PressingQueuedScan = {
    ...actor, requestId: payload.requestId, barcode,
    payload: { ...payload, barcode },
    createdAt: now, updatedAt: now,
    state: "pending", attempts: 0, nextAttemptAt: Date.now(),
  };
  await savePressingScan(record);
  return { record, existing: false };
}
export function pressingRetryDelay(attempts: number): number {
  // Exponential backoff capped at 60 seconds; no immediate retry loop.
  return Math.min(60_000, 1500 * 2 ** Math.min(attempts, 6));
}
export function recordWithState(
  record: PressingQueuedScan, state: PressingQueueState, changes: Partial<PressingQueuedScan> = {}
): PressingQueuedScan {
  return {
    ...record, ...changes, state, updatedAt: new Date().toISOString(),
    // The original request identity and payload cannot be overwritten while
    // updating status, including after transient network failures.
    requestId: record.requestId, payload: record.payload,
    userId: record.userId, companyId: record.companyId, barcode: record.barcode,
    createdAt: record.createdAt,
  };
}


/**
 * Single IndexedDB transaction for read/modify/write prevents stale tab
 * responses from overwriting an already confirmed or rejected scan.
 * A terminal row remains read-only; its original request payload is immutable.
 */
export async function transitionPressingScan(
  actor: PressingActor, requestId: string, state: PressingQueueState,
  changes: Partial<PressingQueuedScan> = {},
): Promise<PressingQueuedScan | null> {
  const db = await openPressingQueue();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let outcome: PressingQueuedScan | null = null;
    const request = store.get(requestId);
    request.onsuccess = () => {
      const row = request.result as PressingQueuedScan | undefined;
      if (!row || row.companyId !== actor.companyId || row.userId !== actor.userId) return;
      if (row.state === "confirmed" || row.state === "rejected") {
        outcome = row;
        return;
      }
      outcome = recordWithState(row, state, changes);
      store.put(outcome);
    };
    tx.oncomplete = () => resolve(outcome);
    tx.onerror = () => reject(tx.error || new Error("Could not update pressing queue status"));
    tx.onabort = () => reject(tx.error || new Error("Pressing queue update was aborted"));
  });
}
