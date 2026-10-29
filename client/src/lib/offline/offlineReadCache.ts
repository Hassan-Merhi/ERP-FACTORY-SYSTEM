import { offlineError } from "./offlineError";
import {
  deriveOfflineVaultKey,
  isSealedOfflineVaultBody,
  OFFLINE_VAULT_SCHEME,
  openOfflineVaultBody,
  sealOfflineVaultBody,
  vaultCheckScope,
  type OfflineVaultKey,
} from "./secureSnapshotVault";
import { db, type OfflineReadGrant, type OfflineReadSnapshot } from "../db";
import {
  classifyOfflineReadFallback,
  normalizeOfflineReadUrl,
  offlineReadKey,
  offlineReadinessKey,
} from "./offlineReadPolicy";

export interface OfflineReadActor {
  companyId: number;
  userId: string;
}

export interface ReadBatchInput extends OfflineReadActor {
  snapshots: Array<{ url: string; body: string }>;
  total: number;
  packSummary?: Record<string, { label: string; count: number; completedAt: number }>;
}

const MAX_OFFLINE_READ_AGE = 8 * 60 * 60 * 1000;
let verifiedScope: (OfflineReadActor & { expiresAt: number }) | null = null;
let verificationVersion = 0;
const VAULT_CHECK_VALUE = "erp-offline-vault-check-v1";
let unlockedVault: (OfflineReadActor & { vault: OfflineVaultKey }) | null = null;

export function lockVerifiedOfflineReadVault(): void {
  unlockedVault = null;
}

export function isVerifiedOfflineReadVaultUnlocked(actor: OfflineReadActor): boolean {
  return (
    getVerifiedOfflineReadScope()?.userId === actor.userId &&
    getVerifiedOfflineReadScope()?.companyId === actor.companyId &&
    unlockedVault?.userId === actor.userId &&
    unlockedVault?.companyId === actor.companyId
  );
}

/**
 * An unlock never creates authentication: it needs the live, verified scope
 * established by Phase 2. Lost passphrases require a fresh online preparation.
 */
export async function unlockVerifiedOfflineReadVault(passphrase: string): Promise<boolean> {
  lockVerifiedOfflineReadVault();
  const scope = getVerifiedOfflineReadScope();
  if (!scope) return false;
  const currentVersion = verificationVersion;
  try {
    const grant = await getOfflineReadGrant(scope);
    if (
      !grant ||
      grant.status !== "ready" ||
      grant.expiresAt <= Date.now() ||
      grant.protection !== OFFLINE_VAULT_SCHEME ||
      !grant.vaultSalt ||
      !grant.vaultCheck
    )
      return false;
    const vault = await deriveOfflineVaultKey(passphrase, grant.vaultSalt);
    const check = await openOfflineVaultBody(
      grant.vaultCheck,
      vault,
      vaultCheckScope(scope, grant.preparedAt, grant.expiresAt)
    );
    const verified = getVerifiedOfflineReadScope();
    if (
      check !== VAULT_CHECK_VALUE ||
      verificationVersion !== currentVersion ||
      verified?.userId !== scope.userId ||
      verified?.companyId !== scope.companyId
    )
      return false;
    unlockedVault = { ...scope, vault };
    return true;
  } catch {
    return false;
  }
}

/** In-memory scope only. Never restore authenticated status from IndexedDB. */
export function activateVerifiedOfflineReadScope(actor: OfflineReadActor, ttlMs = MAX_OFFLINE_READ_AGE): void {
  if (!Number.isSafeInteger(actor.companyId) || actor.companyId <= 0 || !actor.userId.trim()) {
    throw offlineError("OFFLINE_READ_ACTOR_INVALID");
  }
  if (verifiedScope?.companyId !== actor.companyId || verifiedScope?.userId !== actor.userId) {
    lockVerifiedOfflineReadVault();
  }
  verifiedScope = {
    companyId: actor.companyId,
    userId: actor.userId,
    expiresAt: Date.now() + Math.min(Math.max(0, ttlMs), MAX_OFFLINE_READ_AGE),
  };
}

export function revokeOfflineReadScope(): void {
  verificationVersion++;
  verifiedScope = null;
  lockVerifiedOfflineReadVault();
}

export function getVerifiedOfflineReadScope(): OfflineReadActor | null {
  if (!verifiedScope || verifiedScope.expiresAt <= Date.now()) {
    verifiedScope = null;
    lockVerifiedOfflineReadVault();
    return null;
  }
  return { companyId: verifiedScope.companyId, userId: verifiedScope.userId };
}

export async function verifyOfflineReadScope(companyId: number): Promise<OfflineReadActor | null> {
  revokeOfflineReadScope();
  const requestVersion = verificationVersion;
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return null;
  try {
    const [userRes, companyRes, assignmentsRes] = await Promise.all([
      fetch("/api/auth/me", { credentials: "include", cache: "no-store" }),
      fetch("/api/auth/session-company", { credentials: "include", cache: "no-store" }),
      fetch("/api/user/companies", { credentials: "include", cache: "no-store" }),
    ]);
    if (!userRes.ok || !companyRes.ok || !assignmentsRes.ok) return null;
    const user: unknown = await userRes.json();
    const selected: unknown = await companyRes.json();
    const assignments: unknown = await assignmentsRes.json();
    const userId = user && typeof user === "object" && "id" in user ? String(user.id ?? "") : "";
    const selectedId =
      selected && typeof selected === "object" && "companyId" in selected ? Number(selected.companyId) : 0;
    const userActive = user && typeof user === "object" && "active" in user ? user.active !== false : true;
    const assigned =
      Array.isArray(assignments) &&
      assignments.some(
        (item) =>
          item && typeof item === "object" && Number(item.companyId) === companyId && item.companyActive !== false
      );
    if (!userId || !userActive || selectedId !== companyId || !assigned || requestVersion !== verificationVersion)
      return null;

    const actor = { companyId, userId };
    activateVerifiedOfflineReadScope(actor);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("erp:offline-read-scope-verified"));
    return actor;
  } catch {
    // Never trust a previous verified scope after a failed verification attempt
    // that explicitly sought to change/reconfirm the user and company.
    return null;
  }
}

/** Atomically promote a complete set of downloaded JSON snapshots. */
export async function saveVerifiedOfflineReadBatch(input: ReadBatchInput, passphrase?: string): Promise<void> {
  const scope = getVerifiedOfflineReadScope();
  if (!scope || scope.userId !== input.userId || scope.companyId !== input.companyId) {
    throw offlineError("OFFLINE_READ_SCOPE_MISMATCH");
  }
  if (input.snapshots.length !== input.total || input.total === 0) {
    throw offlineError("OFFLINE_READ_DATASET_INCOMPLETE");
  }
  const seen = new Set<string>();
  const currentVersion = verificationVersion;
  const now = Date.now();
  const rows: OfflineReadSnapshot[] = input.snapshots.map(({ url, body }) => {
    if (normalizeOfflineReadUrl(url) !== url || seen.has(url)) {
      throw offlineError("OFFLINE_READ_DATASET_UNVERIFIED");
    }
    seen.add(url);
    // Reject incomplete or non-JSON payloads; no "ready" timestamp for them.
    JSON.parse(body);
    return {
      key: offlineReadKey(input.companyId, input.userId, url),
      userId: input.userId,
      companyId: input.companyId,
      url,
      body,
      cachedAt: now,
      expiresAt: now + MAX_OFFLINE_READ_AGE,
    };
  });
  // Perform all expensive PBKDF2 and AES-GCM work BEFORE the IndexedDB
  // transaction; Dexie transactions must not wait on unrelated async crypto.
  let vault: OfflineVaultKey | null = null;
  let vaultCheck: string | undefined;
  if (passphrase !== undefined) {
    vault = await deriveOfflineVaultKey(passphrase);
    for (const row of rows) {
      row.body = await sealOfflineVaultBody(row.body, vault, row);
    }
    vaultCheck = await sealOfflineVaultBody(
      VAULT_CHECK_VALUE,
      vault,
      vaultCheckScope(input, now, now + MAX_OFFLINE_READ_AGE)
    );
  }
  const stillVerified = getVerifiedOfflineReadScope();
  if (
    verificationVersion !== currentVersion ||
    stillVerified?.companyId !== input.companyId ||
    stillVerified?.userId !== input.userId
  ) {
    throw offlineError("OFFLINE_READ_SCOPE_MISMATCH");
  }
  const grant: OfflineReadGrant = {
    key: offlineReadinessKey(input.companyId, input.userId),
    userId: input.userId,
    companyId: input.companyId,
    status: "ready",
    preparedAt: now,
    expiresAt: now + MAX_OFFLINE_READ_AGE,
    completed: rows.length,
    total: input.total,
    errors: "[]",
    packSummary: JSON.stringify(input.packSummary ?? {}),
    protection: vault ? OFFLINE_VAULT_SCHEME : undefined,
    vaultSalt: vault?.salt,
    vaultCheck,
  };
  await db.transaction("rw", db.offlineReadSnapshots, db.offlineReadGrants, async () => {
    await db.offlineReadSnapshots.bulkPut(rows);
    await db.offlineReadGrants.put(grant);
  });
  lockVerifiedOfflineReadVault();
  const verifiedAfterSave = getVerifiedOfflineReadScope();
  if (
    vault &&
    verifiedAfterSave?.companyId === input.companyId &&
    verifiedAfterSave?.userId === input.userId &&
    currentVersion === verificationVersion
  ) {
    unlockedVault = { companyId: input.companyId, userId: input.userId, vault };
  }
}

export async function getOfflineReadGrant(actor: OfflineReadActor): Promise<OfflineReadGrant | null> {
  const grant = await db.offlineReadGrants.get(offlineReadinessKey(actor.companyId, actor.userId));
  if (!grant || grant.companyId !== actor.companyId || grant.userId !== actor.userId) return null;
  return grant;
}

export async function readPreparedOfflineResponse(method: string, url: string): Promise<Response | null> {
  if (!classifyOfflineReadFallback(method, url, "network")) return null;
  const actor = getVerifiedOfflineReadScope();
  if (!actor) return null;
  try {
    const grant = await getOfflineReadGrant(actor);
    if (!grant || grant.status !== "ready" || grant.expiresAt <= Date.now()) return null;
    const row = await db.offlineReadSnapshots.get(offlineReadKey(actor.companyId, actor.userId, url));
    if (
      !row ||
      row.companyId !== actor.companyId ||
      row.userId !== actor.userId ||
      row.url !== url ||
      row.expiresAt <= Date.now() ||
      row.cachedAt > Date.now()
    )
      return null;
    let body = row.body;
    if (grant.protection) {
      if (
        grant.protection !== OFFLINE_VAULT_SCHEME ||
        !grant.vaultSalt ||
        !unlockedVault ||
        unlockedVault.userId !== actor.userId ||
        unlockedVault.companyId !== actor.companyId ||
        unlockedVault.vault.salt !== grant.vaultSalt
      )
        return null;
      body = await openOfflineVaultBody(body, unlockedVault.vault, row);
    } else if (isSealedOfflineVaultBody(body)) {
      // A sealed row without a matching grant must never downgrade to plaintext.
      return null;
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-ERP-Offline-Snapshot": "1",
        "X-ERP-Offline-Cached-At": String(row.cachedAt),
      },
    });
  } catch {
    // Unavailable/evicted IndexedDB never becomes a fabricated successful read.
    return null;
  }
}

/** Only the known worker-generated offline 503 may be replayed from disk. */
export async function isServiceWorkerOfflineResponse(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) return false;
    const body: unknown = await response.clone().json();
    return body !== null && typeof body === "object" && "offline" in body && body.offline === true;
  } catch {
    return false;
  }
}
