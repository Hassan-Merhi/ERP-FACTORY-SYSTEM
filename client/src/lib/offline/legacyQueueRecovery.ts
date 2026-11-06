/**
 * Plan batch 5 (owner-approved 2026-11-05): the old browser queues.
 *
 * Some browsers still hold entries saved by the pre-Phase 9 offline queues
 * (localStorage `erp_offline_queue`, IndexedDB `syncQueue`). They have no
 * request id, verified actor or replay proof, so they are never sent.
 *
 * At the next sign-in on that browser they move into an encrypted store. The
 * key is a non-extractable AES-GCM key kept by this browser. Admin, Owner and
 * Developer users then see a list: date, type, amount. Each entry is either
 * re-entered (the user types it again through the normal form, which goes
 * through the server's checks) or discarded. Every choice is recorded in the
 * server audit log with the user's name before it takes effect. Entries
 * nobody handles are deleted after 30 days.
 */
import { db, type LegacyRecoveryEntry } from "../db";

const LEGACY_LOCAL_KEY = "erp_offline_queue";
const KEY_ID = "legacy-recovery-v1";
export const LEGACY_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const LEGACY_RECOVERY_ROLES = new Set(["Admin", "Owner", "Developer"]);

function aad(id: string): ArrayBuffer {
  return new TextEncoder().encode(`erp-legacy-recovery:${id}`).buffer as ArrayBuffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

async function recoveryKey(): Promise<CryptoKey> {
  const existing = await db.legacyRecoveryKeys.get(KEY_ID);
  if (existing) return existing.key;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await db.legacyRecoveryKeys.put({ id: KEY_ID, key });
  return (await db.legacyRecoveryKeys.get(KEY_ID))?.key ?? key;
}

async function seal(id: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(id) },
    await recoveryKey(),
    data
  );
  return JSON.stringify({ iv: toBase64(iv), data: toBase64(new Uint8Array(sealed)) });
}

/** The entry's original request, decrypted for the person re-entering it. */
export async function openLegacyRecoveryEntry(
  entry: LegacyRecoveryEntry
): Promise<{ method: string; url: string; body: unknown }> {
  const { iv, data } = JSON.parse(entry.sealed) as { iv: string; data: string };
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: aad(entry.id) },
    await recoveryKey(),
    fromBase64(data)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

function parseBody(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The amount shown in the list: a top-level total, or the sum of entry/item amounts. */
export function legacyEntryAmount(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const field of ["totalAmount", "total", "amount"]) {
    const value = Number(record[field]);
    if (record[field] !== undefined && record[field] !== "" && Number.isFinite(value)) return value.toFixed(2);
  }
  for (const field of ["entries", "items", "lines"]) {
    const rows = record[field];
    if (!Array.isArray(rows)) continue;
    let sum = 0;
    let found = false;
    for (const row of rows) {
      const value = Number((row as Record<string, unknown> | null)?.amount);
      if (Number.isFinite(value)) {
        sum += value;
        found = true;
      }
    }
    if (found) return sum.toFixed(2);
  }
  return null;
}

function companyOf(body: unknown, fallback: number | null): number | null {
  const value = Number((body as Record<string, unknown> | null)?.companyId);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Move every old queue entry into the encrypted store, then remove the
 * originals. Entry ids are derived from the originals, so a move cut short
 * and run again never duplicates an entry. Never sends anything.
 */
export async function migrateLegacyQueues(now = Date.now()): Promise<number> {
  const moved: LegacyRecoveryEntry[] = [];
  let localItems: Array<Record<string, unknown>> = [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LEGACY_LOCAL_KEY) || "[]");
    if (Array.isArray(stored)) localItems = stored.filter((item) => item && typeof item === "object");
  } catch {
    localItems = [];
  }
  for (const item of localItems) {
    const id = `ls:${String(item.id ?? item.timestamp ?? moved.length)}`;
    const body = parseBody(item.body);
    moved.push({
      id,
      source: "localStorage",
      companyId: companyOf(body, null),
      kind: String(item.description || "Action").slice(0, 200),
      recordedAt: Number(item.timestamp) || now,
      amount: legacyEntryAmount(body),
      sealed: await seal(id, { method: String(item.method ?? ""), url: String(item.url ?? ""), body }),
      migratedAt: now,
      expiresAt: now + LEGACY_RECOVERY_RETENTION_MS,
      state: "pending",
    });
  }
  const queued = (await db.syncQueue.toArray()).filter((row) => row.status !== "succeeded");
  for (const row of queued) {
    const id = `idb:${row.idempotencyKey || row.id}`;
    const body = parseBody(row.payload);
    moved.push({
      id,
      source: "indexedDb",
      companyId: companyOf(body, row.companyId ?? null),
      kind: String(row.description || row.entityType || "Action").slice(0, 200),
      recordedAt: Number(row.createdAt) || now,
      amount: legacyEntryAmount(body),
      sealed: await seal(id, { method: row.method, url: row.url, body }),
      migratedAt: now,
      expiresAt: now + LEGACY_RECOVERY_RETENTION_MS,
      state: "pending",
    });
  }
  if (moved.length === 0) return 0;
  // An entry already moved keeps its first state and retention date.
  const known = new Set(
    (await db.legacyRecoveryEntries.bulkGet(moved.map((e) => e.id))).filter(Boolean).map((e) => e!.id)
  );
  await db.legacyRecoveryEntries.bulkPut(moved.filter((entry) => !known.has(entry.id)));
  // Originals go only after their encrypted copies are stored.
  if (localItems.length) localStorage.removeItem(LEGACY_LOCAL_KEY);
  const queuedIds = queued.map((row) => row.id).filter((id): id is number => typeof id === "number");
  if (queuedIds.length) await db.syncQueue.bulkDelete(queuedIds);
  return moved.length;
}

/** Delete every entry past its 30 days, handled or not. */
export async function purgeExpiredLegacyEntries(now = Date.now()): Promise<number> {
  const expired = (await db.legacyRecoveryEntries.toArray()).filter((entry) => entry.expiresAt <= now);
  await db.legacyRecoveryEntries.bulkDelete(expired.map((entry) => entry.id));
  return expired.length;
}

/** The entries still waiting for a choice, for this company (or with no known company). */
export async function listLegacyRecoveryEntries(companyId: number, now = Date.now()): Promise<LegacyRecoveryEntry[]> {
  return (await db.legacyRecoveryEntries.toArray())
    .filter(
      (entry) =>
        entry.state === "pending" &&
        entry.expiresAt > now &&
        (entry.companyId === null || entry.companyId === companyId)
    )
    .sort((a, b) => a.recordedAt - b.recordedAt);
}

/**
 * Record the choice in the server audit log (with the signed-in user's name),
 * then apply it here. If the server cannot record it, nothing changes.
 */
export async function decideLegacyRecoveryEntry(
  entry: LegacyRecoveryEntry,
  decision: "discarded" | "re-entered",
  post: (body: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
  await post({
    entryId: entry.id,
    decision,
    kind: entry.kind,
    recordedAt: new Date(entry.recordedAt).toISOString(),
    amount: entry.amount,
    source: entry.source,
  });
  await db.legacyRecoveryEntries.update(entry.id, { state: decision });
}
