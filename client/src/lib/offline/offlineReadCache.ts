import { isSealedOfflineVaultBody, OFFLINE_VAULT_SCHEME, openOfflineVaultBody } from "./secureSnapshotVault";
import { db } from "../db";
import { classifyOfflineReadFallback, offlineReadKey } from "./offlineReadPolicy";
import {
  COLD_START_IDENTITY_URLS,
  getOfflineReadGrant,
  type OfflineReadActor,
} from "./offlineReadCacheFindColdStartTicket";
import {
  coldStartIdentity,
  getVerifiedOfflineReadScope,
  isColdStartReadOnly,
  unlockedVault,
  verificationVersion,
  verifiedScope,
} from "./saveVerifiedOfflineReadBatch";
export {
  COLD_START_IDENTITY_URLS,
  COLD_START_WINDOW_MS,
  findColdStartTicket,
  getOfflineReadGrant,
} from "./offlineReadCacheFindColdStartTicket";
export type { OfflineReadActor, ReadBatchInput } from "./offlineReadCacheFindColdStartTicket";
export {
  activateVerifiedOfflineReadScope,
  getVerifiedOfflineReadScope,
  isColdStartReadOnly,
  lockVerifiedOfflineReadVault,
  revokeOfflineReadScope,
  saveVerifiedOfflineReadBatch,
  unlockColdStartReadOnly,
  unlockVerifiedOfflineReadVault,
  verifyOfflineReadScope,
  wipeColdStartAccess,
} from "./saveVerifiedOfflineReadBatch";

export function isVerifiedOfflineReadVaultUnlocked(actor: OfflineReadActor): boolean {
  return (
    getVerifiedOfflineReadScope()?.userId === actor.userId &&
    getVerifiedOfflineReadScope()?.companyId === actor.companyId &&
    unlockedVault?.userId === actor.userId &&
    unlockedVault?.companyId === actor.companyId
  );
}

export async function readPreparedOfflineResponse(method: string, url: string): Promise<Response | null> {
  if (!classifyOfflineReadFallback(method, url, "network")) return null;
  const actor = getVerifiedOfflineReadScope();
  if (!actor) return null;
  const requestVersion = verificationVersion;
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
      row.cachedAt > Date.now() ||
      row.cachedAt !== grant.preparedAt ||
      row.expiresAt !== grant.expiresAt
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
    // Sign-out/company-switch may happen while IndexedDB or WebCrypto awaits.
    const finalActor = getVerifiedOfflineReadScope();
    if (
      verificationVersion !== requestVersion ||
      finalActor?.companyId !== actor.companyId ||
      finalActor?.userId !== actor.userId
    )
      return null;
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

/** Until when the read-only view stays open (null when not in a cold start). */
export function coldStartReadOnlyUntil(): number | null {
  return isColdStartReadOnly() ? (verifiedScope?.expiresAt ?? null) : null;
}

/** During a cold start only: the identity responses sealed in the ticket (never otherwise). */
export function readColdStartIdentityResponse(method: string, url: string): Response | null {
  if (method.toUpperCase() !== "GET" || !isColdStartReadOnly() || !coldStartIdentity) return null;
  if (!(COLD_START_IDENTITY_URLS as readonly string[]).includes(url)) return null;
  return new Response(JSON.stringify(coldStartIdentity[url as (typeof COLD_START_IDENTITY_URLS)[number]]), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-ERP-Offline-Snapshot": "1", "X-ERP-Offline-Read-Only": "1" },
  });
}
