// Extracted from ./durableOutbox.ts
import { db } from "../db";
import { isValidOfflineActor, type OfflineActor, type OfflineMode } from "./operationContract";

const DEVICE_ID_KEY = "erp_offline_device_id";

export interface QueueOfflineInput {
  actor: OfflineActor;
  mode: OfflineMode;
  entityType: string;
  method: string;
  url: string;
  payload: unknown;
  clientDate: string;
  dependencies?: string[];
}

export interface OfflineDeliverySummary {
  acknowledged: number;
  conflicts: number;
  rejected: number;
  retried: number;
  paused: boolean;
}

export function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const deviceId = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

/** A user cannot self-assert a different actor/company while syncing. */
export async function getAuthenticatedActor(transport: typeof fetch): Promise<OfflineActor | null> {
  try {
    const [userRes, companyRes] = await Promise.all([
      transport("/api/auth/me", { credentials: "include", cache: "no-store" }),
      transport("/api/auth/session-company", { credentials: "include", cache: "no-store" }),
    ]);
    if (!userRes.ok || !companyRes.ok) return null;
    const user = (await userRes.json()) as { id?: unknown };
    const company = (await companyRes.json()) as { companyId?: unknown };
    const actor = { userId: String(user?.id ?? ""), companyId: Number(company?.companyId) };
    return isValidOfflineActor(actor) ? actor : null;
  } catch {
    return null;
  }
}

/**
 * Old queues may have incomplete IDs or company identity; they are deliberately
 * not migrated/replayed automatically. A future migration must reconcile each
 * entry with the server before clearing either original store.
 */
export async function countLegacyOfflineOperations(): Promise<{
  indexedDb: number;
  localStorage: number;
}> {
  const indexedDb = await db.syncQueue.count();
  let localStorageCount = 0;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("erp_offline_queue") || "[]");
    if (Array.isArray(stored)) localStorageCount = stored.length;
  } catch {
    // Corrupt legacy data stays in place for recovery, never silently cleared.
  }
  return { indexedDb, localStorage: localStorageCount };
}
