// Extracted from ./offlineReadCache.ts to keep that module under the source-size cap.
import { offlineError } from "./offlineError";
import {
  deriveOfflineVaultKey,
  OFFLINE_VAULT_SCHEME,
  type OfflineVaultKey,
  openOfflineVaultBody,
  sealOfflineVaultBody,
  vaultCheckScope,
} from "./secureSnapshotVault";
import { setColdStartReadOnlyUntil } from "./coldStartState";
import { db, type OfflineReadGrant, type OfflineReadSnapshot } from "../db";
import { normalizeOfflineReadUrl, offlineReadinessKey, offlineReadKey } from "./offlineReadPolicy";
import {
  COLD_START_IDENTITY_URLS,
  COLD_START_TICKET_MARKER,
  COLD_START_WINDOW_MS,
  MAX_OFFLINE_READ_AGE,
  VAULT_CHECK_VALUE,
  coldStartTicketScope,
  findColdStartTicket,
  getOfflineReadGrant,
  type ColdStartIdentity,
  type OfflineReadActor,
  type ReadBatchInput,
} from "./offlineReadCacheFindColdStartTicket";

export let verifiedScope: (OfflineReadActor & { expiresAt: number; verifiedAt: number; coldStart: boolean }) | null =
  null;

/** The identity responses of the last live verification (memory only; sealed into the ticket). */
let lastVerifiedIdentity: (OfflineReadActor & { identity: ColdStartIdentity }) | null = null;

export let coldStartIdentity: ColdStartIdentity | null = null;

export let verificationVersion = 0;

export let unlockedVault: (OfflineReadActor & { vault: OfflineVaultKey }) | null = null;

export function lockVerifiedOfflineReadVault(): void {
  unlockedVault = null;
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
    await issueColdStartTicket();
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
  // A fresh verification invalidates in-flight reads and unlocks.
  verificationVersion++;
  lockVerifiedOfflineReadVault();
  const now = Date.now();
  verifiedScope = {
    companyId: actor.companyId,
    userId: actor.userId,
    expiresAt: now + Math.min(Math.max(0, ttlMs), MAX_OFFLINE_READ_AGE),
    verifiedAt: now,
    coldStart: false,
  };
  coldStartIdentity = null;
  setColdStartReadOnlyUntil(null);
}

export function revokeOfflineReadScope(): void {
  verificationVersion++;
  verifiedScope = null;
  coldStartIdentity = null;
  setColdStartReadOnlyUntil(null);
  lockVerifiedOfflineReadVault();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("erp:offline-cold-start-changed"));
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
    if (requestVersion !== verificationVersion) return null;
    // Plan batch 5: the server answered and this account is disabled or no
    // longer belongs to the company, so its cold-start key on this laptop goes.
    if (userId && (!userActive || !assigned)) {
      await wipeColdStartAccess(userId, !userActive ? undefined : companyId);
      return null;
    }
    if (!userId || selectedId !== companyId) return null;

    const actor = { companyId, userId };
    activateVerifiedOfflineReadScope(actor);
    lastVerifiedIdentity = {
      ...actor,
      identity: { "/api/auth/me": user, "/api/auth/session-company": selected, "/api/user/companies": assignments },
    };
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
  if (!scope || scope.userId !== input.userId || scope.companyId !== input.companyId || isColdStartReadOnly()) {
    throw offlineError("OFFLINE_READ_SCOPE_MISMATCH");
  }
  if (input.snapshots.length !== input.total || input.total === 0) {
    throw offlineError("OFFLINE_READ_DATASET_INCOMPLETE");
  }
  const seen = new Set<string>();
  const currentVersion = verificationVersion;
  const now = Date.now();
  // An encrypted cache may serve a read-only cold start for 24 hours (decision 10).
  const lifetime = passphrase !== undefined ? COLD_START_WINDOW_MS : MAX_OFFLINE_READ_AGE;
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
      expiresAt: now + lifetime,
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
    vaultCheck = await sealOfflineVaultBody(VAULT_CHECK_VALUE, vault, vaultCheckScope(input, now, now + lifetime));
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
    expiresAt: now + lifetime,
    completed: rows.length,
    total: input.total,
    errors: "[]",
    packSummary: JSON.stringify(input.packSummary ?? {}),
    protection: vault ? OFFLINE_VAULT_SCHEME : undefined,
    vaultSalt: vault?.salt,
    vaultCheck,
  };
  await db.transaction("rw", db.offlineReadSnapshots, db.offlineReadGrants, async () => {
    const previous = await db.offlineReadGrants.get(grant.key);
    if (previous?.protection && !vault) {
      throw offlineError("OFFLINE_VAULT_PROTECTION_REQUIRED");
    }
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
    await issueColdStartTicket();
  }
}

/** Seal (or refresh) this account's ticket; only while verified online with the vault unlocked. */
async function issueColdStartTicket(): Promise<void> {
  const scope = verifiedScope;
  const vault = unlockedVault;
  const identity = lastVerifiedIdentity;
  if (
    !scope ||
    scope.coldStart ||
    !vault ||
    !identity ||
    vault.userId !== scope.userId ||
    vault.companyId !== scope.companyId ||
    identity.userId !== scope.userId ||
    identity.companyId !== scope.companyId
  )
    return;
  try {
    const grant = await getOfflineReadGrant(scope);
    if (!grant || grant.protection !== OFFLINE_VAULT_SCHEME || grant.vaultSalt !== vault.vault.salt) return;
    const ticket = {
      key: offlineReadinessKey(scope.companyId, scope.userId),
      userId: scope.userId,
      companyId: scope.companyId,
      verifiedAt: scope.verifiedAt,
      expiresAt: scope.verifiedAt + COLD_START_WINDOW_MS,
      vaultSalt: vault.vault.salt,
    };
    const sealed = await sealOfflineVaultBody(
      JSON.stringify({ marker: COLD_START_TICKET_MARKER, identity: identity.identity }),
      vault.vault,
      coldStartTicketScope(ticket)
    );
    await db.offlineColdStartTickets.put({ ...ticket, sealed });
  } catch {
    // A ticket is a convenience for a later outage; never fail the unlock over it.
  }
}

/**
 * Open the newest ticket with the cache passphrase: read-only access to that
 * account's cached data until the ticket (and the cache) expire. Never an
 * authenticated session and never a write.
 */
export async function unlockColdStartReadOnly(passphrase: string): Promise<boolean> {
  const ticket = await findColdStartTicket();
  if (!ticket) return false;
  try {
    const vault = await deriveOfflineVaultKey(passphrase, ticket.vaultSalt);
    const opened: unknown = JSON.parse(await openOfflineVaultBody(ticket.sealed, vault, coldStartTicketScope(ticket)));
    const body = opened as { marker?: unknown; identity?: Partial<ColdStartIdentity> };
    const identity = body?.identity;
    const me = identity?.["/api/auth/me"] as { id?: unknown } | undefined;
    if (
      body?.marker !== COLD_START_TICKET_MARKER ||
      !identity ||
      COLD_START_IDENTITY_URLS.some((url) => !(url in identity)) ||
      String(me?.id ?? "") !== ticket.userId
    )
      return false;
    const grant = await getOfflineReadGrant(ticket);
    if (!grant || grant.vaultSalt !== ticket.vaultSalt || grant.expiresAt <= Date.now()) return false;
    verificationVersion++;
    verifiedScope = {
      companyId: ticket.companyId,
      userId: ticket.userId,
      expiresAt: Math.min(ticket.expiresAt, grant.expiresAt),
      verifiedAt: ticket.verifiedAt,
      coldStart: true,
    };
    unlockedVault = { companyId: ticket.companyId, userId: ticket.userId, vault };
    coldStartIdentity = identity as ColdStartIdentity;
    setColdStartReadOnlyUntil(verifiedScope.expiresAt);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("erp:offline-cold-start-changed"));
    return true;
  } catch {
    return false;
  }
}

/** True while this tab is a read-only cold-start viewer: every write is refused locally. */
export function isColdStartReadOnly(): boolean {
  return getVerifiedOfflineReadScope() !== null && verifiedScope?.coldStart === true;
}

/**
 * Remove the cold-start key on this laptop: on sign-out (this account's
 * tickets), or when the server says the account was disabled (all its tickets)
 * or removed from a company (that company's ticket, grant and cached data).
 */
export async function wipeColdStartAccess(userId: string, companyId?: number): Promise<void> {
  try {
    const tickets = await db.offlineColdStartTickets.toArray();
    const doomed = tickets.filter((t) => t.userId === userId && (companyId === undefined || t.companyId === companyId));
    await db.offlineColdStartTickets.bulkDelete(doomed.map((t) => t.key));
    if (companyId !== undefined) {
      await db.offlineReadGrants.delete(offlineReadinessKey(companyId, userId));
      await db.offlineReadSnapshots.where("[companyId+userId]").equals([companyId, userId]).delete();
    }
  } catch {
    // Best effort: an unavailable IndexedDB holds no usable ticket either.
  }
  if (verifiedScope?.userId === userId) revokeOfflineReadScope();
}
