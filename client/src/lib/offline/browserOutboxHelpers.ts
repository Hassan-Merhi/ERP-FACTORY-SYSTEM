// Extracted from ./browserOutbox.ts
import { db, type BrowserDeviceKey, type BrowserOperationRecord, type BrowserOperationState } from "../db";
import { offlineError } from "./offlineError";

export interface BrowserActor {
  companyId: number;
  userId: string;
}

export const BROWSER_LOCAL_REF_BASE = 1_000_000_000;

/** States the user sees as "saved on this device, not yet in the cloud". */
export const UNSYNCED_STATES: readonly BrowserOperationState[] = ["saved", "pending", "sending", "waiting"];

/** States that need the user's decision. */
export const ATTENTION_STATES: readonly BrowserOperationState[] = ["conflict", "rejected", "needs_review"];

export type BrowserOperationStatus = "saved-locally" | "pending-sync" | "synced" | "failed" | "discarded";

export function validActor(actor: BrowserActor | null | undefined): actor is BrowserActor {
  return !!actor && Number.isSafeInteger(actor.companyId) && actor.companyId > 0 && actor.userId.trim().length > 0;
}

export function keyId(actor: BrowserActor): string {
  return `${actor.companyId}:${actor.userId}`;
}

/** This user's device key and device id, created on first use; never exported. */
export async function browserDeviceKey(actor: BrowserActor): Promise<BrowserDeviceKey> {
  if (!validActor(actor)) throw offlineError("OFFLINE_ACTOR_REQUIRED");
  const existing = await db.browserDeviceKeys.get(keyId(actor));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const record: BrowserDeviceKey = {
    id: keyId(actor),
    key,
    deviceId: crypto.randomUUID(),
    nextLocalRef: BROWSER_LOCAL_REF_BASE + 1,
  };
  // Another tab may have created it first: keep whichever was stored.
  await db.transaction("rw", db.browserDeviceKeys, async () => {
    if (!(await db.browserDeviceKeys.get(record.id))) await db.browserDeviceKeys.put(record);
  });
  return (await db.browserDeviceKeys.get(record.id)) ?? record;
}

export async function allocateLocalRef(
  actor: BrowserActor
): Promise<{ deviceId: string; localRef: number; key: CryptoKey }> {
  await browserDeviceKey(actor);
  return db.transaction("rw", db.browserDeviceKeys, async () => {
    const current = await db.browserDeviceKeys.get(keyId(actor));
    if (!current) throw offlineError("OFFLINE_DEVICE_KEY_MISSING");
    const localRef = current.nextLocalRef;
    if (localRef >= 2_147_483_647) throw offlineError("OFFLINE_LOCAL_REFS_EXHAUSTED");
    await db.browserDeviceKeys.put({ ...current, nextLocalRef: localRef + 1 });
    return { deviceId: current.deviceId, localRef, key: current.key };
  });
}

export interface SavedBrowserOperation {
  record: BrowserOperationRecord;
  /** True when the same entry was already saved moments ago (a double click). */
  duplicate: boolean;
}

export interface BrowserQueueCounts {
  savedLocally: number;
  pendingSync: number;
  synced: number;
  failed: number;
  conflicts: number;
}
