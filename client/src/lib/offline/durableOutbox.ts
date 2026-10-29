import { db } from "../db";
import {
  classifyOfflineResponse,
  isAutoReplayAllowed,
  isValidOfflineActor,
  isVettedOfflineVoucherPayload,
  offlineRetryDelay,
  validateOfflinePayload,
  type OfflineActor,
  type OfflineMode,
  type OfflineOperation,
  type OfflineOperationState,
} from "./operationContract";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const LEASE_MS = 10 * 60 * 1000;
const DEVICE_ID_KEY = "erp_offline_device_id";
const runnerId = crypto.randomUUID();
let processing = false;

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

function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const deviceId = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

/**
 * The operation is saved before any HTTP is attempted. Storage errors propagate:
 * never tell the user a write was saved if IndexedDB was blocked or out of space.
 */
export async function queueOfflineOperation(input: QueueOfflineInput): Promise<OfflineOperation> {
  if (!isValidOfflineActor(input.actor)) throw new Error("OFFLINE_ACTOR_REQUIRED");
  if (!isAutoReplayAllowed(input.method, input.url)) {
    throw new Error("OFFLINE_WRITE_UNVERIFIED");
  }
  if (!validateOfflinePayload(input.payload)) throw new Error("OFFLINE_UNSAFE_PAYLOAD");
  if (!isVettedOfflineVoucherPayload(input.payload)) {
    throw new Error("OFFLINE_VOUCHER_NOT_CENTRAL");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.clientDate)) throw new Error("OFFLINE_CLIENT_DATE_REQUIRED");
  if (!input.entityType.trim()) throw new Error("OFFLINE_ENTITY_TYPE_REQUIRED");

  const body = input.payload as Record<string, unknown>;
  const existingId = body.clientRequestId;
  const id = existingId === undefined ? crypto.randomUUID() : existingId;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("OFFLINE_REQUEST_ID_INVALID");
  }
  // The posting engine reads the original body identity; match the header.
  const payload = JSON.stringify({ ...body, clientRequestId: id });
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("OFFLINE_PAYLOAD_TOO_LARGE");
  const now = Date.now();
  const record: OfflineOperation = {
    schemaVersion: 1,
    id,
    deviceId: getDeviceId(),
    companyId: input.actor.companyId,
    userId: input.actor.userId,
    mode: input.mode,
    entityType: input.entityType,
    method: input.method.toUpperCase(),
    url: input.url,
    payload,
    clientDate: input.clientDate,
    dependencies: input.dependencies ?? [],
    createdAt: now,
    updatedAt: now,
    state: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    leaseOwner: null,
    leaseUntil: 0,
    lastError: null,
    response: null,
    acknowledgedAt: null,
  };

  await db.offlineOperations.add(record);
  return record;
}

export async function listOfflineOperations(
  actor: OfflineActor,
  states?: OfflineOperationState[]
): Promise<OfflineOperation[]> {
  const all = await db.offlineOperations.where("companyId").equals(actor.companyId).toArray();
  return all
    .filter((item) => item.userId === actor.userId && (!states || states.includes(item.state)))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** A user cannot self-assert a different actor/company while syncing. */
async function getAuthenticatedActor(transport: typeof fetch): Promise<OfflineActor | null> {
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

async function claimOfflineOperation(id: string, actor: OfflineActor): Promise<OfflineOperation | null> {
  return db.transaction("rw", db.offlineOperations, async () => {
    const item = await db.offlineOperations.get(id);
    if (!item || item.companyId !== actor.companyId || item.userId !== actor.userId) return null;
    if (item.state !== "pending" && item.state !== "sending") return null;
    const now = Date.now();
    if (item.nextAttemptAt > now || (item.state === "sending" && item.leaseUntil > now)) return null;
    const claimed: OfflineOperation = {
      ...item,
      state: "sending",
      leaseOwner: runnerId,
      leaseUntil: now + LEASE_MS,
      updatedAt: now,
    };
    await db.offlineOperations.put(claimed);
    return claimed;
  });
}

async function settleOperation(
  id: string,
  state: OfflineOperationState,
  patch: Partial<OfflineOperation>
): Promise<void> {
  await db.transaction("rw", db.offlineOperations, async () => {
    const current = await db.offlineOperations.get(id);
    if (!current || current.state !== "sending" || current.leaseOwner !== runnerId) return;
    await db.offlineOperations.put({
      ...current,
      ...patch,
      state,
      leaseOwner: null,
      leaseUntil: 0,
      updatedAt: Date.now(),
    });
  });
}

/**
 * Only sends operations for the currently authenticated company and user.
 * Results are never silently deleted. Missing acknowledgements retry with the
 * original X-Idempotency-Key; the server must own exactly-once posting.
 */
export async function deliverOfflineOperations(
  transport: typeof fetch = fetch
): Promise<OfflineDeliverySummary> {
  const summary: OfflineDeliverySummary = {
    acknowledged: 0,
    conflicts: 0,
    rejected: 0,
    retried: 0,
    paused: false,
  };
  if (processing) return { ...summary, paused: true };
  processing = true;
  try {
    const actor = await getAuthenticatedActor(transport);
    if (!actor) {
      summary.paused = true;
      return summary;
    }
    const candidates = await listOfflineOperations(actor);
    for (const candidate of candidates) {
      if (candidate.state === "acknowledged") continue;
      // Stop after a conflict/rejection: later writes may depend on this one.
      if (candidate.state !== "pending" && candidate.state !== "sending") break;
      if (!isAutoReplayAllowed(candidate.method, candidate.url)) break;
      if (candidate.dependencies.length > 0) {
        const parents = await db.offlineOperations.bulkGet(candidate.dependencies);
        if (
          parents.some(
            (parent) =>
              !parent ||
              parent.companyId !== actor.companyId ||
              parent.userId !== actor.userId ||
              parent.state !== "acknowledged"
          )
        ) break;
      }
      const item = await claimOfflineOperation(candidate.id, actor);
      // An earlier operation may be in backoff or leased by another tab.
      // Never overtake it with a later business write.
      if (!item) break;
      try {
        const response = await transport(item.url, {
          method: item.method,
          headers: {
            "Content-Type": "application/json",
            "X-Idempotency-Key": item.id,
            "X-Offline-Operation-Id": item.id,
            "X-Client-Date": item.clientDate,
          },
          credentials: "include",
          body: item.payload,
        });
        const raw = await response.text().catch(() => "");
        const outcome = classifyOfflineResponse(response.status);
        if (outcome === "acknowledged") {
          await settleOperation(item.id, "acknowledged", {
            response: raw,
            acknowledgedAt: Date.now(),
            lastError: null,
          });
          summary.acknowledged++;
        } else if (outcome === "conflict" || outcome === "rejected") {
          await settleOperation(item.id, outcome === "conflict" ? "conflict" : "rejected", {
            response: raw.slice(0, 16384),
            lastError: `HTTP ${response.status}: ${raw.slice(0, 1000)}`,
            attempts: item.attempts + 1,
          });
          summary[outcome === "conflict" ? "conflicts" : "rejected"]++;
          // Do not reorder dependent or noncommutative writes after rejection.
          break;
        } else if (outcome === "paused") {
          await settleOperation(item.id, "pending", { lastError: "OFFLINE_AUTH_REQUIRED" });
          summary.paused = true;
          break;
        } else {
          const attempts = item.attempts + 1;
          await settleOperation(item.id, "pending", {
            attempts,
            nextAttemptAt: Date.now() + offlineRetryDelay(attempts),
            lastError: `HTTP ${response.status}`,
          });
          summary.retried++;
          break;
        }
      } catch (error) {
        const attempts = item.attempts + 1;
        await settleOperation(item.id, "pending", {
          attempts,
          nextAttemptAt: Date.now() + offlineRetryDelay(attempts),
          lastError: error instanceof Error ? error.message : "OFFLINE_TRANSPORT_FAILED",
        });
        summary.retried++;
        break;
      }
    }
    return summary;
  } finally {
    processing = false;
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
  let indexedDb = 0;
  let localStorageCount = 0;
  indexedDb = await db.syncQueue.count();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("erp_offline_queue") || "[]");
    if (Array.isArray(stored)) localStorageCount = stored.length;
  } catch {
    // Corrupt legacy data stays in place for recovery, never silently cleared.
  }
  return { indexedDb, localStorage: localStorageCount };
}
