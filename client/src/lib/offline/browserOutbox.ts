/**
 * Standalone browser offline mode (Phase 13): the laptop's own queue of
 * business operations saved while offline.
 *
 * - Durable: IndexedDB (Dexie table `browserOperations`); survives reloads and
 *   restarts. Storage errors propagate: nothing is reported saved unless it is.
 * - Isolated: every record carries its company and user; lists, edits and
 *   delivery only ever see the signed-in user's records in the active company.
 * - Sealed: the entered values are encrypted with AES-GCM under a
 *   non-extractable key generated for this user on this device. Only a short
 *   label (type and amount) and the delivery state are readable.
 * - Vetted: only the writes listed in offlineCoverage.ts, with plain JSON and
 *   no credentials, can be saved.
 */
import { db, type BrowserDeviceKey, type BrowserOperationRecord, type BrowserOperationState } from "../db";
import { offlineError } from "./offlineError";
import { validateOfflinePayload } from "./operationContract";
import { supportedOfflineKind } from "./offlineCoverage";

export interface BrowserActor {
  companyId: number;
  userId: string;
}

export const BROWSER_LOCAL_REF_BASE = 1_000_000_000;
const MAX_INPUT_BYTES = 512 * 1024;
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

/** States the user sees as "saved on this device, not yet in the cloud". */
export const UNSYNCED_STATES: readonly BrowserOperationState[] = ["saved", "pending", "sending", "waiting"];
/** States that need the user's decision. */
export const ATTENTION_STATES: readonly BrowserOperationState[] = ["conflict", "rejected", "needs_review"];

export type BrowserOperationStatus = "saved-locally" | "pending-sync" | "synced" | "failed" | "discarded";

export function browserOperationStatus(state: BrowserOperationState): BrowserOperationStatus {
  if (state === "saved") return "saved-locally";
  if (state === "synced") return "synced";
  if (state === "discarded") return "discarded";
  if (ATTENTION_STATES.includes(state)) return "failed";
  return "pending-sync";
}

function validActor(actor: BrowserActor | null | undefined): actor is BrowserActor {
  return !!actor && Number.isSafeInteger(actor.companyId) && actor.companyId > 0 && actor.userId.trim().length > 0;
}

function keyId(actor: BrowserActor): string {
  return `${actor.companyId}:${actor.userId}`;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
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

async function allocateLocalRef(actor: BrowserActor): Promise<{ deviceId: string; localRef: number; key: CryptoKey }> {
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

async function seal(key: CryptoKey, input: unknown): Promise<{ sealed: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(input));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { sealed: toBase64(sealed), iv: toBase64(iv) };
}

async function inputHash(kind: string, input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}\n${JSON.stringify(input)}`));
  return toBase64(digest);
}

function vetInput(kind: string, input: unknown): Record<string, unknown> {
  const write = supportedOfflineKind(kind);
  if (!write) throw offlineError("OFFLINE_WRITE_NOT_SUPPORTED");
  if (!input || typeof input !== "object" || Array.isArray(input) || !validateOfflinePayload(input)) {
    throw offlineError("OFFLINE_UNSAFE_PAYLOAD");
  }
  if (JSON.stringify(input).length > MAX_INPUT_BYTES) throw offlineError("OFFLINE_PAYLOAD_TOO_LARGE");
  return input as Record<string, unknown>;
}

export interface SavedBrowserOperation {
  record: BrowserOperationRecord;
  /** True when the same entry was already saved moments ago (a double click). */
  duplicate: boolean;
}

/** Save one supported write on this device. Nothing is sent from here. */
export async function saveBrowserOperation(
  actor: BrowserActor,
  kind: string,
  rawInput: unknown,
  now: number = Date.now()
): Promise<SavedBrowserOperation> {
  if (!validActor(actor)) throw offlineError("OFFLINE_ACTOR_REQUIRED");
  const input = vetInput(kind, rawInput);
  const write = supportedOfflineKind(kind)!;
  const hash = await inputHash(kind, input);
  const recent = (await listBrowserOperations(actor, UNSYNCED_STATES)).find(
    (record) => record.kind === kind && record.inputHash === hash && now - record.createdAt < DUPLICATE_WINDOW_MS
  );
  if (recent) return { record: recent, duplicate: true };

  const { deviceId, localRef, key } = await allocateLocalRef(actor);
  const sealed = await seal(key, input);
  const record: BrowserOperationRecord = {
    id: crypto.randomUUID(),
    companyId: actor.companyId,
    userId: actor.userId,
    deviceId,
    kind,
    stream: write.stream,
    localRef,
    capturedAt: new Date(now).toISOString(),
    label: write.label(input).slice(0, 120),
    inputHash: hash,
    sealed: sealed.sealed,
    iv: sealed.iv,
    state: "saved",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    conflictCode: null,
    conflictOverridable: false,
    overrideCode: null,
    cloudRef: null,
    outcome: null,
    createdAt: now,
    updatedAt: now,
    syncedAt: null,
  };
  await db.browserOperations.add(record);
  return { record, duplicate: false };
}

export async function listBrowserOperations(
  actor: BrowserActor,
  states?: readonly BrowserOperationState[]
): Promise<BrowserOperationRecord[]> {
  if (!validActor(actor)) return [];
  const rows = await db.browserOperations.where("[companyId+userId]").equals([actor.companyId, actor.userId]).toArray();
  return rows
    .filter((row) => !states || states.includes(row.state))
    .sort((a, b) => a.createdAt - b.createdAt || a.localRef - b.localRef);
}

function owned(actor: BrowserActor, record: BrowserOperationRecord | undefined): record is BrowserOperationRecord {
  return !!record && record.companyId === actor.companyId && record.userId === actor.userId;
}

export async function getBrowserOperation(actor: BrowserActor, id: string): Promise<BrowserOperationRecord | null> {
  const record = await db.browserOperations.get(id);
  return owned(actor, record) ? record : null;
}

/** The entered values, decrypted with this user's device key. */
export async function openBrowserOperation(
  actor: BrowserActor,
  record: BrowserOperationRecord
): Promise<Record<string, unknown>> {
  if (!owned(actor, record)) throw offlineError("OFFLINE_RECORD_NOT_YOURS");
  const device = await db.browserDeviceKeys.get(keyId(actor));
  if (!device) throw offlineError("OFFLINE_DEVICE_KEY_MISSING");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(record.iv) },
    device.key,
    fromBase64(record.sealed)
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
}

/**
 * A record may be edited while the cloud certainly holds no receipt for it:
 * never sent, or the cloud answered without writing (conflict, refused, or
 * waiting for an earlier record). After a lost connection mid-send it may have
 * been applied, so it can no longer change.
 */
export function browserOperationEditable(record: BrowserOperationRecord): boolean {
  if (
    record.state === "saved" ||
    record.state === "conflict" ||
    record.state === "rejected" ||
    record.state === "waiting"
  ) {
    return true;
  }
  return record.state === "pending" && record.attempts === 0;
}

/**
 * Edit a record the cloud has not accepted yet (offline editing of your own
 * saved work). The operation keeps its id and local reference, so records that
 * name it still do.
 */
export async function editBrowserOperation(
  actor: BrowserActor,
  id: string,
  rawInput: unknown
): Promise<BrowserOperationRecord> {
  const record = await getBrowserOperation(actor, id);
  if (!record) throw offlineError("OFFLINE_RECORD_NOT_YOURS");
  if (!browserOperationEditable(record)) throw offlineError("OFFLINE_RECORD_ALREADY_SENT");
  const input = vetInput(record.kind, rawInput);
  const device = await browserDeviceKey(actor);
  const sealed = await seal(device.key, input);
  const updated: BrowserOperationRecord = {
    ...record,
    ...sealed,
    label: supportedOfflineKind(record.kind)!.label(input).slice(0, 120),
    inputHash: await inputHash(record.kind, input),
    state: record.state === "saved" ? "saved" : "pending",
    attempts: record.attempts,
    nextAttemptAt: 0,
    lastError: null,
    conflictCode: null,
    conflictOverridable: false,
    overrideCode: null,
    updatedAt: Date.now(),
  };
  await db.browserOperations.put(updated);
  return updated;
}

/** Change a record's delivery state (only the owner's records). */
export async function updateBrowserOperation(
  actor: BrowserActor,
  id: string,
  patch: Partial<BrowserOperationRecord>
): Promise<BrowserOperationRecord | null> {
  return db.transaction("rw", db.browserOperations, async () => {
    const current = await db.browserOperations.get(id);
    if (!owned(actor, current)) return null;
    const next = {
      ...current,
      ...patch,
      id: current.id,
      companyId: current.companyId,
      userId: current.userId,
      updatedAt: Date.now(),
    };
    await db.browserOperations.put(next);
    return next;
  });
}

/** Forget synced and discarded records older than the given age (storage management). */
export async function clearFinishedBrowserOperations(actor: BrowserActor, olderThanMs = 0): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const done = (await listBrowserOperations(actor, ["synced", "discarded"])).filter((row) => row.updatedAt <= cutoff);
  await db.browserOperations.bulkDelete(done.map((row) => row.id));
  return done.length;
}

export interface BrowserQueueCounts {
  savedLocally: number;
  pendingSync: number;
  synced: number;
  failed: number;
  conflicts: number;
}

export async function countBrowserOperations(actor: BrowserActor | null): Promise<BrowserQueueCounts> {
  const counts: BrowserQueueCounts = { savedLocally: 0, pendingSync: 0, synced: 0, failed: 0, conflicts: 0 };
  if (!actor) return counts;
  for (const row of await listBrowserOperations(actor)) {
    const status = browserOperationStatus(row.state);
    if (status === "saved-locally") counts.savedLocally += 1;
    else if (status === "pending-sync") counts.pendingSync += 1;
    else if (status === "synced") counts.synced += 1;
    else if (status === "failed") counts.failed += 1;
    if (row.state === "conflict") counts.conflicts += 1;
  }
  return counts;
}

/**
 * Recovery copy of every unsynced record for this user, decrypted, so the
 * person can re-enter them by hand if the device must be replaced. Only the
 * owner can produce it, on this device.
 */
export async function exportUnsyncedBrowserOperations(
  actor: BrowserActor
): Promise<
  Array<{ id: string; kind: string; label: string; capturedAt: string; state: string; input: Record<string, unknown> }>
> {
  const rows = (await listBrowserOperations(actor)).filter(
    (row) => UNSYNCED_STATES.includes(row.state) || ATTENTION_STATES.includes(row.state)
  );
  const out = [];
  for (const row of rows) {
    out.push({
      id: row.id,
      kind: row.kind,
      label: row.label,
      capturedAt: row.capturedAt,
      state: row.state,
      input: await openBrowserOperation(actor, row),
    });
  }
  return out;
}
